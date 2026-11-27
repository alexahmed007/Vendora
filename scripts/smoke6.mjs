// Auto-post checks: the safety gate, the runner (hold period, held items, backlog limits),
// the stale-job drop, and the .auto command. Fakes only, like the other suites.
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

const { autoPostVerdict, leftoverContact } = await import('../dist/lib/autoPost.js');
const { runAutoPost } = await import('../dist/core/autopost.js');
const pub = await import('../dist/core/publisher.js');
const q = await import('../dist/core/queue.js');
const { saveProduct, getProduct, listProducts } = await import('../dist/core/catalog.js');
const { addTarget } = await import('../dist/core/targets.js');
const { getSettings, updateSettings } = await import('../dist/core/settings.js');
const { PluginHost } = await import('../dist/core/pluginHost.js');
const { TenantContext } = await import('../dist/core/tenantContext.js');
const publishPlugin = (await import('../dist/plugins/publish.js')).default;

setInterval(() => {}, 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, ms = 2500) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (cond()) return true; await sleep(10); } return false; }
const must = async (cond, ms) => { if (!(await waitFor(cond, ms))) throw new Error(`timed out waiting for: ${cond.toString().slice(0, 140)}`); };
let passed = 0;
const ok = (n) => { passed++; console.log('  ✓', n); };

// ═══ A. the gate (pure) ══════════════════════════════════════════════════════
assert.equal(leftoverContact('Nike Air Max ₦25,000 size 40 41 42 43 44 45'), null);          // sizes are not phones
assert.equal(leftoverContact('Rice 50kg ₦80,600, 6 pairs ₦23,400'), null);
assert.match(leftoverContact('Call 0801 2345 678'), /phone|number/);                          // the spaced phone the cleaner misses
assert.match(leftoverContact('Call +234 (0) 801 234 5678'), /number|phone/);
assert.match(leftoverContact('mail sales@vendorshop.com'), /email/);
assert.match(leftoverContact('IG: vendorshop_ng'), /social/);
assert.match(leftoverContact('see wa.me/2348099999999'), /link|number/);
assert.match(leftoverContact('chat @vendorshop'), /handle/);
const good = { status: 'new', needsReview: false, cost: 8000, manualPrice: null, mediaCount: 1, createdAt: 0, now: 10 * 60_000, delayMs: 5 * 60_000, markupPercent: 30, vendorName: 'Shoe Plug', caption: 'Item\nPrice ₦10,400', priceText: '10,400' };
assert.deepEqual(autoPostVerdict(good), { ok: true });
assert.deepEqual(autoPostVerdict({ ...good, now: 60_000 }), { wait: true });
assert.equal(autoPostVerdict({ ...good, needsReview: true }).hold, 'review');
assert.equal(autoPostVerdict({ ...good, cost: null }).hold, 'review');
assert.equal(autoPostVerdict({ ...good, mediaCount: 0 }).hold, 'no-media');
assert.equal(autoPostVerdict({ ...good, markupPercent: 0 }).hold, 'markup');
assert.equal(autoPostVerdict({ ...good, caption: 'Item\nPrice ₦10,400\nmail a@b.com' }).hold, 'contact');
assert.equal(autoPostVerdict({ ...good, caption: 'Shoe Plug exclusive\nPrice ₦10,400' }).hold, 'vendor-name');
assert.equal(autoPostVerdict({ ...good, caption: 'Item with no price line' }).hold, 'price-lost');
assert.equal(autoPostVerdict({ ...good, status: 'soldout' }).ok, false);
assert.deepEqual(autoPostVerdict({ ...good, needsReview: true, manualPrice: 12000 }), { ok: true }); // the owner's own price is trusted
ok('gate: clear items pass; no price / shaky price / 0% markup / leftover phone, email, link, handle, vendor name / lost price line are held; the hold period waits');

// ═══ fakes ═══════════════════════════════════════════════════════════════════
function fakeSock(userId) {
  const em = new EventEmitter();
  const sock = { ev: { on: (e, f) => em.on(e, f), off: (e, f) => em.off(e, f), emit: (e, p) => em.emit(e, p), removeAllListeners: () => em.removeAllListeners() }, user: { id: userId }, sent: [],
    async sendMessage(jid, content, opts) { const key = { id: `OUT${sock.sent.length + 1}`, remoteJid: jid, fromMe: true }; sock.sent.push({ jid, content, opts, key }); return { key, message: content }; } };
  return sock;
}
let seq = 0;
const msg = ({ chat, text, from, fromMe = false }) => ({ key: { id: `M${++seq}`, remoteJid: chat, fromMe, participant: from }, message: { conversation: text }, messageTimestamp: Math.floor(Date.now() / 1000), pushName: 'X' });
const up = (sock, messages) => sock.ev.emit('messages.upsert', { messages, type: 'notify' });
const RES = '2348022222222', OWN = `${RES}@s.whatsapp.net`;
const rsock = fakeSock(`${RES}:3@s.whatsapp.net`);
const ctx = new TenantContext({ id: 'acme', number: RES, status: 'active', plan: 't', expiresAt: null, createdAt: 0, sudo: [] });
ctx.attach(rsock); ctx.markOnline();
const img = (sha) => ({ type: 'image', mimetype: 'image/jpeg', sha, mediaKey: 'a2V5', directPath: `/p/${sha}`, url: `https://m/${sha}`, fileEncSha256: '', fileLength: 1000 });
let pid = 0;
const MIN = 60_000;
const mk = (over = {}) => ({ id: `prod${++pid}`, vendorChatId: 'VG@g.us', vendorName: 'Shoe Plug', sender: '2349011111111', createdAt: Date.now() - 30 * MIN, updatedAt: Date.now(), status: 'new',
  media: [img(`S${pid}`)], hashes: [`S${pid}`], rawCaption: `Item ${pid}\nPrice ₦8,000`, parsed: [], cost: 8000, manualPrice: null, needsReview: false, reposts: 0, priceHistory: [], sourceMessageIds: [`m${pid}`], ...over });

// ═══ B. the runner ═══════════════════════════════════════════════════════════
// off by default: nothing is touched
await saveProduct(ctx, mk());
assert.equal((await runAutoPost(ctx)).skipped, 'off');
assert.equal((await listProducts(ctx, { status: 'new' })).length, 1);

// on, but not set up: it explains what is missing and approves nothing
await updateSettings(ctx, { autoPost: true });
let r = await runAutoPost(ctx);
assert.ok(r.skipped); assert.equal((await listProducts(ctx, { status: 'new' })).length, 1);
assert.match(rsock.sent.at(-1).content.text, /Auto-post is on but can’t run yet[\s\S]*contact line[\s\S]*markup[\s\S]*where to post/i);
ok('off = untouched; on but missing contact line / markup / group = approves nothing and tells the owner what to set');

await updateSettings(ctx, { contactLine: '📞 Order: 0803 000 0000', markupPercent: 30 });
await addTarget(ctx, 'CUST@g.us', 'Lagos Buyers');
await pub.notifyOwner(ctx, 'reset', 'x').catch(() => {});
// products: clean ×2, leftover email, contact+price line dropped by the cleaner, too fresh, 0 media, shaky price
await saveProduct(ctx, mk({ rawCaption: 'Ladies sandal\nPrice ₦3,000' }));
const hEmail = mk({ rawCaption: 'Bag\nPrice ₦9,000\nsales@vendorshop.com for orders' }); await saveProduct(ctx, hEmail);
const hLost = mk({ rawCaption: 'Watch\nCall 09012345678 for price 7500' }); await saveProduct(ctx, hLost);
const fresh = mk({ createdAt: Date.now() - 1 * MIN }); await saveProduct(ctx, fresh);
const shaky = mk({ needsReview: true, rawCaption: 'Mystery item' }); await saveProduct(ctx, shaky);
const before = rsock.sent.length;
r = await runAutoPost(ctx);
const byId = async (id) => (await getProduct(ctx, id)).status;
assert.equal(r.approved, 2);                                           // the two clean ones (the 1st product from above + sandals)
assert.equal(await byId(fresh.id), 'new');                              // still inside the hold period
assert.equal(await byId(hEmail.id), 'new'); assert.equal(await byId(hLost.id), 'new'); assert.equal(await byId(shaky.id), 'new');
assert.equal(r.held, 3); assert.equal(r.waiting, 1);
const jobs = await q.listJobs(ctx, 'pending');
assert.equal(jobs.length, 2); assert.ok(jobs.every((j) => j.auto === true && j.target.jid === 'CUST@g.us'));
assert.ok((await listProducts(ctx, { status: 'queued' })).every((p) => p.autoApproved === true));
const notices = rsock.sent.slice(before).filter((s) => s.jid === OWN && /held 3 items/.test(s.content.text));
assert.equal(notices.length, 1); assert.match(notices[0].content.text, /vendor contact|caption lost the price|price missing/);
ok('runner: 2 clear items approved + queued (flagged auto); email / lost-price / shaky items held; fresh item waits; owner told once about what is held');

// a second run: nothing new to approve, no repeat notice, held items stay held
const n2 = rsock.sent.length; r = await runAutoPost(ctx);
assert.equal(r.approved, 0); assert.equal(rsock.sent.length, n2);
ok('runner: running again approves nothing new and does not nag about the same held items');

// a vendor says "sold out" during the hold period → never approved
await saveProduct(ctx, { ...(await getProduct(ctx, fresh.id)), createdAt: Date.now() - 30 * MIN, status: 'soldout' });
r = await runAutoPost(ctx); assert.equal(r.approved, 0); assert.equal(await byId(fresh.id), 'soldout');
ok('an item marked sold out before it is approved is never posted');

// kill switch and per-vendor markup of 0
await saveProduct(ctx, mk({ rawCaption: 'Late item\nPrice ₦2,000' }));
await updateSettings(ctx, { postingEnabled: false });
assert.equal((await runAutoPost(ctx)).skipped, 'paused');
await updateSettings(ctx, { postingEnabled: true });
ok('kill switch (.post stop) also stops auto-approval');

// backlog limit: never queue more than one day's allowance (the cap counts every group)
await updateSettings(ctx, { dailyCap: 3 });
for (let i = 0; i < 6; i++) await saveProduct(ctx, mk({ rawCaption: `Bulk ${i}\nPrice ₦${5000 + i * 100}` }));
await addTarget(ctx, 'CUST2@g.us', 'Abuja Buyers');
const pendingBefore = (await q.listJobs(ctx, 'pending')).length;
r = await runAutoPost(ctx);
const pendingAfter = (await q.listJobs(ctx, 'pending')).length;
assert.ok(pendingAfter <= 3 + 2, `queue grew past the daily allowance: ${pendingBefore} -> ${pendingAfter}`);
assert.equal(r.skipped, 'queue-full');
ok('backlog: the queue never grows past one day’s posting allowance; the rest wait their turn');

// ═══ C. stale auto jobs are dropped, normal ones are not ═════════════════════
await updateSettings(ctx, { dailyCap: 40, autoPostMaxAgeHrs: 12, gapMinSec: 15, gapMaxSec: 15 });
for (const j of await q.listJobs(ctx)) await q.saveJob(ctx, { ...j, state: 'skipped' });
const stale = mk({ status: 'queued' }); const manual = mk({ status: 'queued' });
await saveProduct(ctx, stale); await saveProduct(ctx, manual);
const NOON = Date.UTC(2027, 2, 10, 11, 0, 0);
await q.addJobs(ctx, stale.id, [{ type: 'group', jid: 'CUST@g.us', name: 'Lagos Buyers' }], NOON - 13 * 3_600_000, true);   // auto, waited 13h
await q.addJobs(ctx, manual.id, [{ type: 'group', jid: 'CUST@g.us', name: 'Lagos Buyers' }], NOON - 13 * 3_600_000, false); // owner-approved, same age
await updateSettings(ctx, { quietStart: 3, quietEnd: 3 });
const sender = { sendGroup: async () => ['SENT1'], sendStatus: async () => ['SENT2'] };
const r1 = await pub.runOnce(ctx, { sender, now: () => NOON, notify: async () => {} });
assert.equal(r1.kind, 'skipped'); assert.match(r1.why, /not posted stale/);
const r2 = await pub.runOnce(ctx, { sender, now: () => NOON, notify: async () => {} });
assert.equal(r2.kind, 'sent');
ok('an auto-queued post stuck for 13h is dropped, while an owner-approved post of the same age still goes out');

// ═══ D. the .auto command ════════════════════════════════════════════════════
await updateSettings(ctx, { autoPost: false, contactLine: '', markupPercent: 0 });
const host = new PluginHost({ sessions: { start: async () => ({}), stop: async () => {}, halt: async () => {}, get: () => undefined, list: () => [] } });
host.register({ ...publishPlugin, schedules: [] });
host.onSocket(ctx, rsock);
const say = (t) => up(rsock, [msg({ chat: OWN, fromMe: true, text: t })]);
const last = () => rsock.sent.at(-1)?.content?.text ?? '';
say('.auto on'); await must(() => /isn’t on yet/.test(last()));
assert.equal((await getSettings(ctx)).autoPost, false); assert.match(last(), /contact line/); assert.match(last(), /markup/);
await updateSettings(ctx, { contactLine: '📞 Order: 0803 000 0000', markupPercent: 25 });
await sleep(1100); say('.auto on'); await must(() => /Auto-post is ON/.test(last()));
assert.equal((await getSettings(ctx)).autoPost, true);
await sleep(1100); say('.auto delay 15'); await must(() => /wait 15 min/.test(last())); assert.equal((await getSettings(ctx)).autoPostDelayMin, 15);
await sleep(1100); say('.auto delay abc'); await must(() => /\.auto delay 10/.test(last()));
await sleep(1100); say('.auto status'); await must(() => /Auto-post: ✅ ON/.test(last()));
await sleep(1100); say('.auto off'); await must(() => /Auto-post is OFF/.test(last())); assert.equal((await getSettings(ctx)).autoPost, false);
ok('.auto on refuses until contact line + markup are set, then enables; delay / status / off work, all answered privately');

console.log(`\n${passed} auto-post checks passed`);
process.exit(0);
