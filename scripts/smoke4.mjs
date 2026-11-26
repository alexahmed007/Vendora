// Stage-4 checks: posting rules, the media sender, the publisher (limits, retries, recovery),
// the .target/.post commands, the Posting dashboard, and the status audience. Fakes only.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { rmSync } from 'node:fs';

for (const v of ['MONGO_URL', 'POSTGRES_URL', 'MYSQL_URL', 'DB_URL']) {
  if (process.env[v]) { console.error(`Refusing to run: ${v} is set. Unset all database env vars.`); process.exit(1); }
}
process.env.DOTENV_CONFIG_PATH = '/nonexistent.env';
rmSync('./data', { recursive: true, force: true });
process.env.ADMIN_NUMBER = '2348012345678';
process.env.COMMAND_COOLDOWN_MS = '1';
process.env.TIMEZONE = 'Africa/Lagos';

const pol = await import('../dist/lib/postingPolicy.js');
const { makeSender, PostError, classifySendError } = await import('../dist/core/sender.js');
const pub = await import('../dist/core/publisher.js');
const q = await import('../dist/core/queue.js');
const { saveProduct, getProduct, listProducts } = await import('../dist/core/catalog.js');
const { addTarget, listTargets, removeTarget, getTarget } = await import('../dist/core/targets.js');
const { addVendor } = await import('../dist/core/vendors.js');
const { noteContact, buildStatusAudience } = await import('../dist/core/audience.js');
const { getSettings, updateSettings } = await import('../dist/core/settings.js');
const { PluginHost } = await import('../dist/core/pluginHost.js');
const { TenantContext } = await import('../dist/core/tenantContext.js');
const bs = await import('../dist/ui/menuSession.js');
const menuPlugin = (await import('../dist/plugins/menu.js')).default;
const publishPlugin = (await import('../dist/plugins/publish.js')).default;
const corePlugin = (await import('../dist/plugins/core.js')).default;

setInterval(() => {}, 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, ms = 2500) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (cond()) return true; await sleep(10); } return false; }
const must = async (cond, ms) => { if (!(await waitFor(cond, ms))) throw new Error(`timed out waiting for: ${cond.toString().slice(0, 140)}`); };
let passed = 0;
const ok = (n) => { passed++; console.log('  ✓', n); };

// ═══ A. posting policy (pure) ════════════════════════════════════════════════
const DAY = 86_400_000;
const NOON = Date.UTC(2027, 2, 10, 11, 0, 0);     // 12:00 in Lagos (UTC+1)
assert.equal(pol.dailyLimit({ dailyCap: 40, createdAt: NOON, now: NOON }), 10);
assert.equal(pol.dailyLimit({ dailyCap: 40, createdAt: NOON - DAY, now: NOON }), 20);
assert.equal(pol.dailyLimit({ dailyCap: 40, createdAt: NOON - 3 * DAY, now: NOON }), 40);
assert.equal(pol.dailyLimit({ dailyCap: 40, createdAt: NOON - 99 * DAY, now: NOON }), 40);
assert.equal(pol.dailyLimit({ dailyCap: 15, createdAt: NOON - 99 * DAY, now: NOON }), 15);
assert.deepEqual(pol.localParts(Date.UTC(2027, 2, 10, 23, 30), 'Africa/Lagos'), { day: '2027-03-11', hour: 0 });   // 00:30 next day in Lagos
assert.deepEqual(pol.localParts(NOON, 'Africa/Lagos'), { day: '2027-03-10', hour: 12 });
assert.equal(pol.inQuietHours(23, 23, 6), true); assert.equal(pol.inQuietHours(2, 23, 6), true); assert.equal(pol.inQuietHours(6, 23, 6), false);
assert.equal(pol.inQuietHours(12, 23, 6), false); assert.equal(pol.inQuietHours(3, 3, 3), false); assert.equal(pol.inQuietHours(14, 13, 15), true);
assert.equal(pol.nextGapMs(45, 120, () => 0), 45_000); assert.equal(pol.nextGapMs(45, 120, () => 1), 120_000); assert.equal(pol.nextGapMs(120, 45, () => 0), 45_000);
const base = { enabled: true, now: NOON, timeZone: 'Africa/Lagos', createdAt: 0, sentToday: 0, dailyCap: 40, quietStart: 23, quietEnd: 6, nextSendAt: 0, pausedUntil: 0 };
assert.deepEqual(pol.canSendNow(base), { ok: true });
assert.equal(pol.canSendNow({ ...base, enabled: false }).reason, 'paused');
assert.equal(pol.canSendNow({ ...base, pausedUntil: NOON + 1 }).reason, 'cooldown');
assert.equal(pol.canSendNow({ ...base, now: Date.UTC(2027, 2, 10, 22, 30) }).reason, 'quiet');
assert.equal(pol.canSendNow({ ...base, sentToday: 40 }).reason, 'cap');
assert.equal(pol.canSendNow({ ...base, createdAt: NOON, sentToday: 10 }).reason, 'cap');       // new account: 10/day
assert.equal(pol.canSendNow({ ...base, nextSendAt: NOON + 1 }).reason, 'gap');
ok('posting policy: warm-up ramp (10 → 20 → … → cap), Lagos day/hour, quiet hours wrap midnight, random gaps, block reasons in order');

// ═══ fakes ═══════════════════════════════════════════════════════════════════
function fakeSock(userId, extra = {}) {
  const em = new EventEmitter();
  const sock = { ev: { on: (e, f) => em.on(e, f), off: (e, f) => em.off(e, f), emit: (e, p) => em.emit(e, p), removeAllListeners: () => em.removeAllListeners() }, user: { id: userId }, sent: [],
    async sendMessage(jid, content, opts) { const key = { id: `OUT${sock.sent.length + 1}`, remoteJid: jid, fromMe: true }; sock.sent.push({ jid, content, opts, key }); return { key, message: content }; }, ...extra };
  return sock;
}
let seq = 0;
const msg = ({ id, chat, text, from, fromMe = false, ts = Date.now() }) => ({ key: { id: id ?? `M${++seq}`, remoteJid: chat, fromMe, participant: from }, message: { conversation: text }, messageTimestamp: Math.floor(ts / 1000), pushName: 'X' });
const up = (sock, messages, type = 'notify') => sock.ev.emit('messages.upsert', { messages, type });
const rec = (id, number, createdAt = 0) => ({ id, number, status: 'active', plan: 't', expiresAt: null, createdAt, sudo: [] });
const online = (tenant, sock) => { const c = new TenantContext(tenant); c.attach(sock); c.markOnline(); return c; };
const lastText = (s) => s.sent.at(-1)?.content?.text ?? '';
const img = (sha, extra = {}) => ({ type: 'image', mimetype: 'image/jpeg', sha, mediaKey: 'a2V5', directPath: `/p/${sha}`, url: `https://m/${sha}`, fileEncSha256: '', fileLength: 1000, ...extra });
const vid = (sha) => ({ ...img(sha), type: 'video', mimetype: 'video/mp4' });
let pid = 0;
const mkProduct = (over = {}) => ({ id: `prod${++pid}`, vendorChatId: 'VG@g.us', vendorName: 'Shoe Plug', sender: '2349011111111', createdAt: Date.now() - pid, updatedAt: Date.now(), status: 'approved',
  media: [img(`S${pid}`)], hashes: [`S${pid}`], rawCaption: `Item ${pid}\nPrice ₦8,000`, parsed: [], cost: 8000, manualPrice: null, needsReview: false, reposts: 0, priceHistory: [], sourceMessageIds: [`m${pid}`], ...over });
let tcount = 0;
const mkCtx = (createdAt = 0) => { const n = ++tcount; return online(rec(`pub${n}`, `23480000${String(n).padStart(5, '0')}`, createdAt), fakeSock(`23480000${String(n).padStart(5, '0')}:1@s.whatsapp.net`)); };

// ═══ B. the media sender ═════════════════════════════════════════════════════
{
  const sleeps = []; const downloaded = [];
  const sender = makeSender({ download: async (d) => { downloaded.push(d.sha); return Buffer.from(`bytes-${d.sha}`); }, sleep: async (ms) => { sleeps.push(ms); }, rand: () => 0 });
  const ctx = mkCtx();
  const ids = await sender.sendGroup(ctx, 'G@g.us', { media: [img('a'), img('b'), vid('c')], caption: 'Nice item ₦9,600' });
  const sent = ctx.trySock().sent;
  assert.equal(sent.length, 3); assert.deepEqual(ids, ['OUT1', 'OUT2', 'OUT3']);
  assert.equal(sent[0].content.caption, 'Nice item ₦9,600'); assert.equal(sent[1].content.caption, undefined);
  assert.ok(sent[0].content.image && sent[2].content.video && sent[2].content.mimetype === 'video/mp4');
  assert.deepEqual(sleeps, [2000, 2000]);                                   // a pause between photos, none before the first
  const ctx2 = mkCtx();
  await sender.sendGroup(ctx2, 'G@g.us', { media: Array.from({ length: 9 }, (_, i) => img(`m${i}`)), caption: 'x' });
  assert.equal(ctx2.trySock().sent.length, 6);                              // MAX_MEDIA_PER_POST
  await sender.sendGroup(ctx2, 'G@g.us', { media: [], caption: 'text only' });
  assert.equal(ctx2.trySock().sent.at(-1).content.text, 'text only');
  ok('sender: caption on the first photo only, a pause between photos, videos as video, capped at 6 per post, text-only items');

  const st = await sender.sendStatus(ctx, ['1@s.whatsapp.net', '2@s.whatsapp.net'], { media: [img('z'), img('y')], caption: 'x'.repeat(900) });
  const last = ctx.trySock().sent.at(-1);
  assert.deepEqual(st, [last.key.id]); assert.equal(last.jid, 'status@broadcast'); assert.deepEqual(last.opts.statusJidList, ['1@s.whatsapp.net', '2@s.whatsapp.net']);
  assert.equal(last.content.caption.length, 600); assert.ok(last.content.image);
  await assert.rejects(sender.sendStatus(ctx, [], { media: [img('z')], caption: '' }), (e) => e instanceof PostError && e.kind === 'permanent');
  ok('sender: status goes to status@broadcast with the audience list, first photo only, caption trimmed; empty audience is refused');

  // errors are classified; oversize media never touches the network
  const mk = (e) => { const c = mkCtx(); c.trySock().sendMessage = async () => { throw e; }; return c; };
  const real = makeSender({ sleep: async () => {} });
  await assert.rejects(makeSender({ download: async () => Buffer.from('x'), sleep: async () => {} }).sendGroup(mk(Object.assign(new Error('rate-overlimit'), { output: { statusCode: 429 } })), 'G', { media: [img('q')], caption: '' }), (e) => e.kind === 'ratelimit');
  await assert.rejects(makeSender({ download: async () => Buffer.from('x'), sleep: async () => {} }).sendGroup(mk(Object.assign(new Error('forbidden'), { output: { statusCode: 403 } })), 'G', { media: [img('q')], caption: '' }), (e) => e.kind === 'permanent');
  await assert.rejects(makeSender({ download: async () => Buffer.from('x'), sleep: async () => {} }).sendGroup(mk(new Error('Connection Closed')), 'G', { media: [img('q')], caption: '' }), (e) => e.kind === 'transient');
  await assert.rejects(real.sendGroup(mkCtx(), 'G', { media: [img('big', { fileLength: 50 * 1024 * 1024 })], caption: '' }), (e) => e.kind === 'permanent' && /too large/.test(e.message));
  await assert.rejects(real.sendGroup(mkCtx(), 'G', { media: [img('nokey', { mediaKey: '' })], caption: '' }), (e) => e.kind === 'permanent');
  // half-sent items keep the ids that did go out
  const half = mkCtx(); let n = 0; const orig = half.trySock().sendMessage; half.trySock().sendMessage = async (...a) => { if (++n === 2) throw new Error('boom'); return orig(...a); };
  await assert.rejects(makeSender({ download: async () => Buffer.from('x'), sleep: async () => {} }).sendGroup(half, 'G', { media: [img('h1'), img('h2')], caption: '' }), (e) => JSON.stringify(e.partialIds) === '["OUT1"]');
  assert.equal(classifySendError(new PostError('x', 'permanent')).kind, 'permanent');
  ok('sender errors: rate limit / forbidden / connection are told apart; oversize or keyless media never hits the network; half-sent items keep their ids');
}

// ═══ C. the publisher ════════════════════════════════════════════════════════
const sendLog = [];
const okSender = { sendGroup: async (c, jid, p) => { sendLog.push(['group', jid, p.caption]); return [`G${sendLog.length}`]; }, sendStatus: async (c, aud, p) => { sendLog.push(['status', aud.length, p.caption]); return [`S${sendLog.length}`]; } };
const notices = [];
const deps = (extra = {}) => ({ sender: okSender, rand: () => 0, notify: async (c, key, text) => { notices.push({ key, text }); }, ...extra });
await assert.rejects; // (silence lint)

{
  const ctx = mkCtx(); const p = mkProduct(); await saveProduct(ctx, p);
  assert.deepEqual(await pub.enqueueProduct(ctx, p.id), { queued: 0, reason: 'no-targets' });
  await addTarget(ctx, 'A@g.us', 'Group A'); await addTarget(ctx, 'B@g.us', 'Group B'); await updateSettings(ctx, { postToStatus: true });
  assert.deepEqual(await pub.enqueueProduct(ctx, p.id), { queued: 3 });
  assert.deepEqual(await pub.enqueueProduct(ctx, p.id), { queued: 0, reason: 'already-queued' });
  assert.equal((await getProduct(ctx, p.id)).status, 'queued');

  sendLog.length = 0; let t = NOON;
  const run = () => pub.runOnce(ctx, deps({ now: () => t }));
  assert.equal((await run()).kind, 'sent');
  assert.deepEqual(await run(), { kind: 'blocked', reason: 'gap' });            // the human-like gap
  t += 44_000; assert.equal((await run()).reason, 'gap');
  t += 2_000; assert.equal((await run()).kind, 'sent');
  t += 46_000; assert.equal((await run()).kind, 'sent');
  assert.deepEqual(await run(), { kind: 'idle' });
  assert.deepEqual(sendLog.map((x) => x[0]), ['group', 'group', 'status']);
  const done = await getProduct(ctx, p.id);
  assert.equal(done.status, 'posted'); assert.ok(done.postedAt);
  assert.match(sendLog[0][2], /Item \d+\nPrice ₦8,000/);                         // markup 0 by default → ₦8,000
  const sentRec = await q.findSent(ctx, 'G1'); assert.equal(sentRec.productId, p.id); assert.equal(sentRec.jid, 'A@g.us');
  assert.equal((await q.findSent(ctx, 'S3')).jid, 'status@broadcast');
  const summary = await pub.queueSummary(ctx, t); assert.equal(summary.sentToday, 3); assert.equal(summary.pending, 0);
  ok('publisher: one job at a time with a random gap, group → group → status, item becomes "posted", sent ids remembered for reply matching');
}

{
  // a brand-new account is held to 10 posts a day, then 20 the next day
  const ctx = mkCtx(NOON); await addTarget(ctx, 'A@g.us', 'A');
  for (let i = 0; i < 12; i++) { const p = mkProduct(); await saveProduct(ctx, p); await pub.enqueueProduct(ctx, p.id); }
  let t = NOON; let sent = 0;
  for (let i = 0; i < 12; i++) { const r = await pub.runOnce(ctx, deps({ now: () => t })); if (r.kind === 'sent') sent++; t += 50_000; }
  assert.equal(sent, 10); assert.equal((await pub.runOnce(ctx, deps({ now: () => t }))).reason, 'cap');
  t = NOON + DAY; assert.equal((await pub.runOnce(ctx, deps({ now: () => t }))).kind, 'sent');            // new day, new allowance
  ok('warm-up: a new account is capped at 10 posts on day one; the allowance resets and grows the next day');
}

{
  const ctx = mkCtx(); await addTarget(ctx, 'A@g.us', 'A'); const p = mkProduct(); await saveProduct(ctx, p); await pub.enqueueProduct(ctx, p.id);
  assert.equal((await pub.runOnce(ctx, deps({ now: () => Date.UTC(2027, 2, 10, 22, 30) }))).reason, 'quiet');
  await updateSettings(ctx, { postingEnabled: false });
  assert.equal((await pub.runOnce(ctx, deps({ now: () => NOON }))).reason, 'paused');
  await updateSettings(ctx, { postingEnabled: true });
  ctx.markOffline(); assert.equal((await pub.runOnce(ctx, deps({ now: () => NOON }))).reason, 'offline'); ctx.markOnline();
  await updateSettings(ctx, { dailyCap: 1 }); await q.countSent(ctx, '2027-03-10');
  assert.equal((await pub.runOnce(ctx, deps({ now: () => NOON }))).reason, 'cap');
  ok('rules: quiet hours, the kill switch, an offline session and the daily cap each stop sending');
}

{
  // failures: retry with back-off, auto-pause after three in a row, rate limits, permanent errors
  const ctx = mkCtx(); await addTarget(ctx, 'A@g.us', 'A');
  const prods = []; for (let i = 0; i < 4; i++) { const p = mkProduct(); await saveProduct(ctx, p); await pub.enqueueProduct(ctx, p.id); prods.push(p); }
  notices.length = 0; let t = NOON;
  const flaky = { ...okSender, sendGroup: async () => { throw new PostError('Connection Closed', 'transient'); } };
  let r = await pub.runOnce(ctx, deps({ now: () => t, sender: flaky }));
  assert.equal(r.kind, 'retry'); const j1 = (await q.listJobs(ctx))[0]; assert.equal(j1.state, 'pending'); assert.equal(j1.notBefore, t + 2 * 60_000); assert.equal(j1.attempts, 1);
  t += 50_000; r = await pub.runOnce(ctx, deps({ now: () => t, sender: flaky }));       // next job fails too
  t += 50_000; r = await pub.runOnce(ctx, deps({ now: () => t, sender: flaky }));       // third failure in a row → pause
  assert.equal((await q.getMeta(ctx)).consecutiveFailures, 3); assert.ok((await q.getMeta(ctx)).pausedUntil > t);
  assert.ok(notices.some((n) => n.key === 'failures'));
  t += 61 * 60_000; assert.equal((await pub.runOnce(ctx, deps({ now: () => t }))).kind, 'sent'); assert.equal((await q.getMeta(ctx)).consecutiveFailures, 0);
  ok('failures: transient errors retry with back-off, three in a row pause posting for an hour and tell the owner, success resets the count');

  const ctx2 = mkCtx(); await addTarget(ctx2, 'A@g.us', 'A'); const pr = mkProduct(); await saveProduct(ctx2, pr); await pub.enqueueProduct(ctx2, pr.id);
  notices.length = 0; t = NOON;
  const limited = { ...okSender, sendGroup: async () => { throw new PostError('WhatsApp rate limit', 'ratelimit'); } };
  assert.equal((await pub.runOnce(ctx2, deps({ now: () => t, sender: limited }))).kind, 'retry');
  const m = await q.getMeta(ctx2); assert.equal(m.pausedUntil, t + 2 * 3_600_000);
  assert.ok(notices.some((n) => n.key === 'ratelimit' && /rate limit/i.test(n.text)));
  assert.equal((await pub.runOnce(ctx2, deps({ now: () => t + 3_600_000 }))).reason, 'cooldown');
  ok('rate limit: posting stops for 2 hours, the owner is warned to lower their limit, the job waits');

  const ctx3 = mkCtx(); await addTarget(ctx3, 'A@g.us', 'A'); await addTarget(ctx3, 'B@g.us', 'B');
  const p3 = mkProduct(); await saveProduct(ctx3, p3); await pub.enqueueProduct(ctx3, p3.id); notices.length = 0; t = NOON;
  const halfBad = { ...okSender, sendGroup: async (c, jid) => { if (jid === 'B@g.us') throw new PostError('not allowed to post there', 'permanent'); return ['OK1']; } };
  assert.equal((await pub.runOnce(ctx3, deps({ now: () => t, sender: halfBad }))).kind, 'sent');
  t += 50_000; assert.equal((await pub.runOnce(ctx3, deps({ now: () => t, sender: halfBad }))).kind, 'failed');
  const after = await getProduct(ctx3, p3.id); assert.equal(after.status, 'posted'); assert.match(after.postError, /not allowed/);
  assert.ok(notices.some((n) => /Couldn.t post/.test(n.text)));
  assert.equal(await pub.retryFailed(ctx3), 1); assert.equal((await getProduct(ctx3, p3.id)).status, 'queued');
  t += 50_000; assert.equal((await pub.runOnce(ctx3, deps({ now: () => t }))).kind, 'sent');
  ok('permanent error: that target fails (owner told once), the item still counts as posted elsewhere, retry puts it back in the queue');
}

{
  // jobs for items that changed or targets that were removed are skipped, not sent
  const ctx = mkCtx(); await addTarget(ctx, 'A@g.us', 'A'); await addTarget(ctx, 'B@g.us', 'B');
  const sold = mkProduct(); const keep = mkProduct(); await saveProduct(ctx, sold); await saveProduct(ctx, keep);
  await pub.enqueueProduct(ctx, sold.id); await pub.enqueueProduct(ctx, keep.id);
  sold.status = 'soldout'; await saveProduct(ctx, sold);                       // vendor says sold out after approval
  await removeTarget(ctx, 'B@g.us');
  sendLog.length = 0; let t = NOON; const results = [];
  for (let i = 0; i < 6; i++) { results.push((await pub.runOnce(ctx, deps({ now: () => t }))).kind); t += 50_000; }
  assert.deepEqual(sendLog.map((x) => x[1]), ['A@g.us']); assert.ok(results.filter((k) => k === 'skipped').length === 3);
  assert.equal((await getProduct(ctx, sold.id)).status, 'soldout');
  ok('skips: an item that sold out after approval, or a group removed since, is never posted');
}

{
  // a crash mid-send must not lead to a silent double post
  const ctx = mkCtx(); await addTarget(ctx, 'A@g.us', 'A'); const p = mkProduct(); await saveProduct(ctx, p); await pub.enqueueProduct(ctx, p.id);
  const [job] = await q.listJobs(ctx); job.state = 'sending'; job.startedAt = NOON; await q.saveJob(ctx, job);      // simulated crash
  sendLog.length = 0;
  assert.equal(await pub.recoverStale(ctx, NOON + 1000), 1);
  assert.equal((await q.listJobs(ctx, 'failed')).length, 1); assert.match((await q.listJobs(ctx))[0].error, /Interrupted/);
  assert.equal((await pub.runOnce(ctx, deps({ now: () => NOON + 120_000 }))).kind, 'idle'); assert.equal(sendLog.length, 0);
  assert.equal((await getProduct(ctx, p.id)).status, 'approved');
  ok('crash recovery: an interrupted send is marked failed for the owner to check, never re-sent automatically');
}

// ═══ D. commands, the audience, and the Posting dashboard ════════════════════
const RES = '2348022222222', VEND = '2349011111111';
const rsock = fakeSock(`${RES}:3@s.whatsapp.net`, { groupMetadata: async (jid) => (jid === 'CUST@g.us' ? { subject: 'Lagos Buyers', participants: [{ id: '2347011111111@s.whatsapp.net' }, { id: '999@lid', phoneNumber: '2347022222222@s.whatsapp.net' }, { id: `${RES}@s.whatsapp.net` }] } : null) });
const resCtx = online(rec('acme', RES, 0), rsock);
const host = new PluginHost({ sessions: { start: async () => ({}), stop: async () => {}, halt: async () => {}, get: () => undefined, list: () => [] } });
[corePlugin, menuPlugin, { ...publishPlugin, schedules: [] }].forEach((p) => host.register(p));   // no background ticks in tests
host.onSocket(resCtx, rsock); bs.registerPromptListener(rsock);
const own = `${RES}@s.whatsapp.net`; const CUSTG = 'CUST@g.us', VENDG = 'VEND@g.us';
const say = (t, chat = own) => up(rsock, [msg({ chat, fromMe: true, text: t })]);
await addVendor(resCtx, VENDG, 'Shoe Plug');

say('.target add', VENDG); await must(() => rsock.sent.length >= 1);
assert.match(lastText(rsock), /vendor sources/); assert.equal(rsock.sent[0].jid, own); assert.equal((await listTargets(resCtx)).length, 0);
await sleep(1600); say('.target add', own); await must(() => /inside the customer group/.test(lastText(rsock)));
await sleep(1600); say('.target add', CUSTG); await must(() => /Lagos Buyers/.test(lastText(rsock)));                  // name taken from the group subject
assert.deepEqual((await listTargets(resCtx)).map((t) => t.name), ['Lagos Buyers']); assert.ok(rsock.sent.every((x) => x.jid === own));
await sleep(1100); say('.post stop'); await must(() => /Posting is paused/.test(lastText(rsock))); assert.equal((await getSettings(resCtx)).postingEnabled, false);
await sleep(1100); say('.post start'); await must(() => /Posting is on/.test(lastText(rsock)));
await sleep(1100); say('.post status'); await must(() => /Today: 0\/10/.test(lastText(rsock)) || /Today: 0\/40/.test(lastText(rsock)));
ok('.target add (group subject as name, refuses vendor groups and non-groups) and .post stop/start/status, all answered privately');

// the status audience: contacts WhatsApp announces + people who message + members of target groups
rsock.ev.emit('contacts.upsert', [{ id: '2347033333333@s.whatsapp.net' }, { id: 'x@lid' }, { id: `${RES}@s.whatsapp.net` }]);
up(rsock, [msg({ chat: '2347044444444@s.whatsapp.net', from: '2347044444444@s.whatsapp.net', text: 'is the kettle available?' })]);
await sleep(80);
const aud = await buildStatusAudience(resCtx);
assert.deepEqual([...aud].sort(), ['2347011111111@s.whatsapp.net', '2347022222222@s.whatsapp.net', '2347033333333@s.whatsapp.net', '2347044444444@s.whatsapp.net'].sort());
assert.equal((await buildStatusAudience(resCtx, 2)).length, 2);
ok('status audience: announced contacts + people who DM you + target-group members (lid → phone), never yourself or lids, capped');

// items → Approve → queue, bulk approve, status toggle
const A = mkProduct({ rawCaption: 'Kenwood electric kettle 8,000', status: 'new', createdAt: Date.now() - 3000 });
const B = mkProduct({ rawCaption: 'Smp knife set  Ssk50 #8000', status: 'new', createdAt: Date.now() - 2000 });
const C = mkProduct({ rawCaption: 'Mystery item no price', status: 'new', cost: null, needsReview: true, createdAt: Date.now() - 1000 });
for (const p of [A, B, C]) await saveProduct(resCtx, p);

say('.menu'); await must(() => /New items: 3/.test(lastText(rsock)) && /Posting: ✅ on/.test(lastText(rsock)));
say('2'); await must(() => /\*Posting\*/.test(lastText(rsock)) && /Where: 1 group/.test(lastText(rsock)));           // 📣 Posting
say('3'); await must(() => /Status posting on/.test(lastText(rsock)));                                                   // 📱 Status → ON
assert.equal((await getSettings(resCtx)).postToStatus, true);
say('0'); await sleep(40); await sleep(1100);
say('.menu'); await must(() => /New items: 3/.test(lastText(rsock)));
say('1'); await must(() => /waiting/.test(lastText(rsock)));                                                             // 📦 Items (newest first: C, B, A)
say('4'); await must(() => /Approve and queue 2 items/.test(lastText(rsock)));                                           // ✅ Approve all (sure prices only)
say('1'); await must(() => /Approved 2 and queued 2/.test(lastText(rsock)));
assert.deepEqual((await listProducts(resCtx, { status: 'queued' })).map((p) => p.id).sort(), [A.id, B.id].sort());
assert.equal((await getProduct(resCtx, C.id)).status, 'new');                                                            // unsure price stays for review
assert.equal((await q.listJobs(resCtx, 'pending')).length, 4);                                                           // 2 items × (1 group + status)
say('0'); await sleep(40);
ok('dashboard: Posting shows state, Status toggles on; "Approve all" queues only confident prices (2 items × group + status = 4 jobs)');

// single approve through the item screen with no target configured
await sleep(1100);
const ctxNoT = mkCtx(); const solo = mkProduct({ status: 'new' }); await saveProduct(ctxNoT, solo);
const { approveItems } = await import('../dist/core/approve.js');
assert.deepEqual(await approveItems(ctxNoT, [solo.id]), { approved: 1, queuedItems: 0, noTargets: true });
await addTarget(ctxNoT, 'Z@g.us', 'Z');
assert.deepEqual(await pub.enqueueApproved(ctxNoT), { items: 1 });
assert.equal((await getProduct(ctxNoT, solo.id)).status, 'queued');
ok('approve without a target keeps the item "approved"; once a target exists "queue approved" picks it up');

// and the real run of the queue the dashboard created
sendLog.length = 0; let t2 = NOON;
for (let i = 0; i < 8; i++) { await pub.runOnce(resCtx, deps({ now: () => t2 })); t2 += 50_000; }
assert.equal(sendLog.length, 4); assert.equal((await listProducts(resCtx, { status: 'posted' })).length, 2);
assert.equal(sendLog.filter((x) => x[0] === 'status').length, 2);
ok('the queue created from the dashboard drains: 4 posts (2 groups + 2 status), both items become "posted"');

console.log(`\n${passed} stage-4 checks passed`);
process.exit(0);
