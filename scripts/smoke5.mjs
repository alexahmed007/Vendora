// Stage-5 checks: plan extension, product search, the reply guard, AI providers, the care engine and
// plugin (DMs, groups, status, hand-offs, caps), and the AI dashboard. Fake sockets and a fake model.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { rmSync } from 'node:fs';

for (const v of ['MONGO_URL', 'POSTGRES_URL', 'MYSQL_URL', 'DB_URL']) {
  if (process.env[v]) { console.error(`Refusing to run: ${v} is set. Unset all database env vars.`); process.exit(1); }
}
process.env.DOTENV_CONFIG_PATH = '/nonexistent.env';
rmSync('./data', { recursive: true, force: true });
Object.assign(process.env, { ADMIN_NUMBER: '2348012345678', COMMAND_COOLDOWN_MS: '1', TIMEZONE: 'Africa/Lagos', AI_SETTINGS_CACHE_MS: '0', AI_GROUP_PER_10_MIN: '3', AI_CUSTOMER_HOURLY_CAP: '4' });

const { SessionManager } = await import('../dist/core/sessionManager.js');
const { ensureControlTenant, controlFirst } = await import('../dist/core/bootstrap.js');
const { PluginHost } = await import('../dist/core/pluginHost.js');
const { TenantContext } = await import('../dist/core/tenantContext.js');
const { createTenant, getTenant, patchTenant } = await import('../dist/store/tenants.js');
const { saveProduct, listProducts } = await import('../dist/core/catalog.js');
const { addVendor } = await import('../dist/core/vendors.js');
const { addTarget } = await import('../dist/core/targets.js');
const { recordSent } = await import('../dist/core/queue.js');
const { getSettings, updateSettings } = await import('../dist/core/settings.js');
const { listLeads, listAiLog } = await import('../dist/core/leads.js');
const { aiSentOn } = await import('../dist/core/aicare.js');
const { localParts } = await import('../dist/lib/postingPolicy.js');
const ps = await import('../dist/lib/productSearch.js');
const rg = await import('../dist/lib/replyGuard.js');
const { buildSystemPrompt, buildMessages } = await import('../dist/lib/aiPrompt.js');
const aiMod = await import('../dist/core/ai.js');
const bs = await import('../dist/ui/menuSession.js');
const aic = await import('../dist/plugins/aicare.js');
const corePlugin = (await import('../dist/plugins/core.js')).default;
const adminPlugin = (await import('../dist/plugins/admin.js')).default;
const menuPlugin = (await import('../dist/plugins/menu.js')).default;

setInterval(() => {}, 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, ms = 2500) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (cond()) return true; await sleep(10); } return false; }
const must = async (cond, ms) => { if (!(await waitFor(cond, ms))) throw new Error(`timed out waiting for: ${cond.toString().slice(0, 140)}`); };
let passed = 0; const ok = (n) => { passed++; console.log('  ✓', n); };
const DAY = 86_400_000;

// ── fakes ───────────────────────────────────────────────────────────────────
function fakeSock(userId) {
  const em = new EventEmitter();
  const sock = { ev: { on: (e, f) => em.on(e, f), off: (e, f) => em.off(e, f), emit: (e, p) => em.emit(e, p), removeAllListeners: () => em.removeAllListeners() }, user: { id: userId }, sent: [],
    async sendMessage(jid, content, opts) { const key = { id: `OUT${sock.sent.length + 1}`, remoteJid: jid, fromMe: true }; sock.sent.push({ jid, content, opts, key }); return { key, message: content }; } };
  return sock;
}
let seq = 0;
const msg = ({ id, chat, text, from, fromMe = false, ts = Date.now(), extra, pushName = 'Amaka' }) => ({ key: { id: id ?? `M${++seq}`, remoteJid: chat, fromMe, participant: from }, message: extra ?? { conversation: text }, messageTimestamp: Math.floor(ts / 1000), pushName });
const up = (sock, messages, type = 'notify') => sock.ev.emit('messages.upsert', { messages, type });
const rec = (id, number, createdAt = 0) => ({ id, number, status: 'active', plan: 't', expiresAt: null, createdAt, sudo: [] });
const online = (tenant, sock) => { const c = new TenantContext(tenant); c.attach(sock); c.markOnline(); return c; };
const lastText = (s) => s.sent.at(-1)?.content?.text ?? '';
const started = [], halted = [];
const fakeSessions = { start: async (t) => { started.push(t); return {}; }, stop: async () => {}, halt: async (id, st) => { halted.push([id, st]); }, get: () => undefined, list: () => [] };

// ═══ 00. the admin account is created from ADMIN_NUMBER ═════════════════════
{
  const { listTenants } = await import('../dist/store/tenants.js');
  assert.equal(await ensureControlTenant(''), null);                                           // no ADMIN_NUMBER: nothing to do
  const made = await ensureControlTenant('2347099999999');
  assert.deepEqual([made.id, made.number, made.status, made.plan, made.expiresAt], ['control', '2347099999999', 'pending', 'admin', null]);
  const again = await ensureControlTenant('2347099999999');                                    // every boot: idempotent
  assert.equal(again.id, 'control'); assert.equal((await listTenants()).filter((t) => t.number === '2347099999999').length, 1);
  assert.equal(await ensureControlTenant('2347088888888'), null);                              // "control" exists for another number: never overwritten
  assert.equal((await getTenant('control')).number, '2347099999999');
  const list = [{ number: '1', id: 'a' }, { number: '2347099999999', id: 'control' }, { number: '3', id: 'c' }];
  assert.deepEqual(controlFirst(list, '2347099999999').map((t) => t.id), ['control', 'a', 'c']);
  ok('ADMIN_NUMBER alone creates the control tenant on an empty database (idempotent, never overwrites a different "control"), and it starts first');
  await patchTenant('control', { status: 'paused' }); // keep the shared registry tidy for the sections below
}

// ═══ 0. plan extension ═══════════════════════════════════════════════════════
const CTL = '2348012345678';
await createTenant({ id: 'ctl', number: CTL });
for (const [id, num] of [['lapsed', '2347000000011'], ['lapsed2', '2347000000012'], ['active1', '2347000000013'], ['paused1', '2347000000014']]) await createTenant({ id, number: num });
const oldActive = Date.now() + 5 * DAY;
await patchTenant('lapsed', { status: 'expired', expiresAt: Date.now() - 7 * DAY });
await patchTenant('lapsed2', { status: 'expired', expiresAt: Date.now() - 7 * DAY });
await patchTenant('active1', { status: 'active', expiresAt: oldActive });
await patchTenant('paused1', { status: 'paused', expiresAt: Date.now() - DAY });
const asock = fakeSock(`${CTL}:5@s.whatsapp.net`); const actl = online(rec('ctl', CTL), asock);
const ah = new PluginHost({ sessions: { ...fakeSessions, list: () => [actl], get: (id) => (id === 'ctl' ? actl : undefined) } });
[corePlugin, adminPlugin].forEach((p) => ah.register(p)); ah.onSocket(actl, asock); bs.registerPromptListener(asock);
const ctlChat = `${CTL}@s.whatsapp.net`; const sayA = (t) => up(asock, [msg({ chat: ctlChat, fromMe: true, text: t })]);

started.length = 0; sayA('.admin extend lapsed 30'); await must(() => /Extended by 30 days/.test(lastText(asock)));
const lapsed = await getTenant('lapsed');
assert.ok(Math.abs(lapsed.expiresAt - (Date.now() + 30 * DAY)) < 10_000, 'an expired plan restarts from NOW, not from the old date');
assert.equal(lapsed.status, 'active'); assert.equal(started.at(-1).id, 'lapsed'); assert.equal(started.at(-1).status, 'active');
assert.match(lastText(asock), /starting now/);
await sleep(600); sayA('.admin extend active1 30'); await must(() => /Extended by 30 days/.test(lastText(asock)) && /active1/.test(lastText(asock)));
assert.equal((await getTenant('active1')).expiresAt, oldActive + 30 * DAY);                 // an active plan adds on top, to the millisecond
assert.ok(!started.some((t) => t.id === 'active1'));
await sleep(600); sayA('.admin extend paused1 7'); await must(() => /paused1/.test(lastText(asock)));
assert.equal((await getTenant('paused1')).status, 'paused'); assert.ok(!started.some((t) => t.id === 'paused1'));   // paused on purpose: stays paused
await sleep(600); sayA('.admin'); await must(() => /Admin/.test(lastText(asock)));
sayA('1'); await must(() => /Customers/.test(lastText(asock)) && /lapsed2/.test(lastText(asock)));
assert.match(lastText(asock), /5️⃣  \*lapsed2 · expired\*/);   // active1, control, ctl, lapsed, lapsed2, paused1
sayA('5'); await must(() => /Number: 2347000000012/.test(lastText(asock)));
assert.match(lastText(asock), /3️⃣  \*📅 Extend 30 days\*/);
sayA('3'); await must(() => /starting now/.test(lastText(asock)));
assert.equal((await getTenant('lapsed2')).status, 'active'); assert.equal(started.at(-1).id, 'lapsed2');
sayA('0'); await sleep(40);
ok('extending: an expired plan restarts from now (+N days) and the session starts at once; an active plan adds on top; a paused customer stays paused; menu and text command agree');

{ // a running customer extended early must not be cut off at the OLD date
  const sm = new SessionManager(); const mkrt = (ctx) => ({ ctx, retries: 0, connecting: false, stopping: false, pairRequested: false, pairAttempts: 0 });
  const r1 = await createTenant({ id: 'run1', number: '2347000000021' }); const r2 = await createTenant({ id: 'run2', number: '2347000000022' });
  await patchTenant('run1', { status: 'active', expiresAt: Date.now() + 30 * DAY });            // extended in the store...
  await patchTenant('run2', { status: 'active', expiresAt: Date.now() - 1000 });                // genuinely expired
  const c1 = online({ ...r1, status: 'active', expiresAt: Date.now() - 1000 }, fakeSock('1:1@s.whatsapp.net'));   // ...but the live copy still has the old date
  const c2 = online({ ...r2, status: 'active', expiresAt: Date.now() - 1000 }, fakeSock('2:1@s.whatsapp.net'));
  sm.runtimes.set('run1', mkrt(c1)); sm.runtimes.set('run2', mkrt(c2));
  await sm.enforcePlans();
  assert.ok(sm.get('run1'), 'the extended customer must keep running'); assert.ok(c1.tenant.expiresAt > Date.now() + 29 * DAY, 'live copy refreshed');
  assert.equal(sm.get('run2'), undefined); assert.equal((await getTenant('run2')).status, 'expired');
  ok('REGRESSION: the expiry sweep re-reads the stored plan, so extending a running customer is not undone at the old date');
}

// ═══ A. pure logic ═══════════════════════════════════════════════════════════
const items = [
  { id: 'k', text: 'Kenwood electric kettle 8,000', createdAt: 1 }, { id: 't', text: 'laptop table with drawer,8.000', createdAt: 2 },
  { id: 's', text: 'Smp knife set  Ssk50 #8000', createdAt: 3 }, { id: 'sofa', text: 'Inflatable sofa with leg rest  # 21,000', createdAt: 4 },
];
assert.deepEqual(ps.tokenize('How much is the Kenwood kettles 8000?'), ['kenwood', 'kettle']);
const top = (q) => ps.searchProducts(q, items)[0]?.item.id;
assert.equal(top('how much is the kenwood kettle?'), 'k'); assert.equal(top('do you have laptop table'), 't');
assert.equal(top('price of the sofa pls'), 'sofa'); assert.equal(top('abeg wetin be the price of knife'), 's');
assert.deepEqual(ps.searchProducts('do you have shoes', items), []); assert.deepEqual(ps.searchProducts('hello good morning sir', items), []);
ok('product search: finds the item from the customer’s own words (English and Pidgin), ignores greetings, never invents a match');

const good = (reply, extra = {}) => rg.checkReply({ reply, allowedAmounts: [9600, 19200, 2000], forbiddenTerms: ['Shoe Plug', ...rg.GENERIC_FORBIDDEN], ...extra });
assert.deepEqual(good('The kettle is ₦9,600 😊 and two are ₦19,200. Delivery in Lagos is ₦2,000. Call 0801 234 5678'), { ok: true, text: 'The kettle is ₦9,600 😊 and two are ₦19,200. Delivery in Lagos is ₦2,000. Call 0801 234 5678' });
assert.equal(good('It is ₦7,000 only').reason, 'price'); assert.equal(good('Only 12k for you').reason, 'price');
assert.equal(good('We get it from Shoe Plug').reason, 'leak'); assert.equal(good('Our wholesale price is lower').reason, 'leak');
assert.equal(good('As an AI language model I cannot').reason, 'ai-talk'); assert.equal(good('   ').reason, 'empty'); assert.equal(good('x'.repeat(901)).reason, 'too-long');
assert.equal(good('**Yes** it is available').text, '*Yes* it is available');
assert.deepEqual(rg.parseHandoff('[HANDOFF] I will check the warranty with the owner'), { handoff: true, text: 'I will check the warranty with the owner' });
assert.deepEqual(rg.parseHandoff('It is ₦9,600'), { handoff: false, text: 'It is ₦9,600' });
for (const t of ['ok', 'Thanks!', '👍', '🙏🙏', 'k', 'thank you 😊', 'ok thanks', 'okay noted, thank you', 'thanks a lot 🙏', 'ok bye']) assert.equal(rg.isNoReplyText(t), true, t);
for (const t of ['ok how much', 'how much?', 'is it available', 'yes please', 'ok is it available', 'thanks but how much']) assert.equal(rg.isNoReplyText(t), false, t);
for (const t of ['yes', 'Yes please', 'yeah sure', 'go ahead', 'abeg yes']) assert.equal(rg.isAffirmative(t), true, t);
for (const t of ['yes the kettle is nice', 'no', 'how much']) assert.equal(rg.isAffirmative(t), false, t);
for (const t of ['I want to speak to the owner', 'this is a scam', 'where is my order']) assert.equal(rg.needsHuman(t), true, t);
for (const t of ['I want to buy the kettle', 'send me your account number', 'how do I pay', 'i go take am', 'I will take 2']) assert.equal(rg.isOrderIntent(t), true, t);
for (const t of ['last price?', 'abeg reduce am', 'it is too expensive', 'any discount']) assert.equal(rg.isBargain(t), true, t);
for (const t of ['how much is the kettle', 'is it available', 'what colours']) assert.ok(!rg.isOrderIntent(t) && !rg.isBargain(t) && !rg.needsHuman(t), t);
ok('reply guard: invented prices, leaks of vendor/wholesale, "as an AI" and empty/long replies are blocked; hand-off token; rules for no-reply, human, order and bargain messages');

const sys = buildSystemPrompt({ brand: 'Acme Home', products: [{ title: 'Kenwood electric kettle', caption: 'Kenwood electric kettle ₦9,600\n\nOrder: 0901 111 2222', price: '₦9,600', soldOut: false }, { title: 'Table', caption: 'Table ₦9,600', price: null, soldOut: true }], shopInfo: 'Delivery ₦2,000', instructions: 'Use light Pidgin', hours: '8:00 to 21:00 (Africa/Lagos)', channel: 'group', closed: true });
assert.match(sys, /"Acme Home"/); assert.match(sys, /Price: ₦9,600 \| Status: available/); assert.match(sys, /Price: not set \| Status: SOLD OUT/); assert.match(sys, /\[HANDOFF\]/);
assert.match(sys, /public in a group/); assert.match(sys, /closed right now/); assert.match(sys, /Delivery ₦2,000/); assert.match(sys, /Use light Pidgin/); assert.ok(!/wholesale price|cost price/i.test(sys.split('RULES')[1].split('SHOP INFO')[0].replace(/Never mention[^\n]*/i, '')));
assert.equal(buildMessages(Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `t${i}` })), ' hi ').length, 7);
ok('prompt: rules, item facts with price/status, shop info, hours and channel notes; history trimmed to the last 6 turns');

// ═══ B. AI providers ═════════════════════════════════════════════════════════
{
  const calls = []; const mkRes = (status, body) => ({ ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.includes('groq')) return mkRes(500, { error: 'overloaded' });
    if (url.includes('generativelanguage')) return mkRes(200, { candidates: [{ content: { parts: [{ text: 'Hello from gemini' }] } }] });
    return mkRes(200, { choices: [{ message: { content: 'Hello from custom' } }] });
  };
  await assert.rejects(aiMod.makeAiClient({ env: {}, fetchImpl }).complete({ system: 's', messages: [] }), (e) => e instanceof aiMod.AiUnavailableError);
  const client = aiMod.makeAiClient({ env: { GROQ_API_KEY: 'gk', GEMINI_API_KEY: 'mk' }, fetchImpl });
  assert.equal(client.providers, 2);
  assert.equal(await client.complete({ system: 'SYS', messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }, { role: 'user', content: 'again' }] }), 'Hello from gemini');
  const g = calls.find((c) => c.url.includes('groq')), m = calls.find((c) => c.url.includes('generativelanguage'));
  assert.equal(g.init.headers.authorization, 'Bearer gk'); assert.equal(JSON.parse(g.init.body).messages[0].content, 'SYS');
  const mb = JSON.parse(m.init.body); assert.equal(mb.systemInstruction.parts[0].text, 'SYS'); assert.deepEqual(mb.contents.map((c) => c.role), ['user', 'model', 'user']); assert.equal(mb.generationConfig.thinkingConfig.thinkingBudget, 0);
  calls.length = 0; await client.complete({ system: 'S', messages: [{ role: 'user', content: 'x' }] });
  assert.ok(calls[0].url.includes('generativelanguage'), 'a provider that just failed is skipped for a while');
  const custom = aiMod.makeAiClient({ env: { AI_BASE_URL: 'https://llm.example/v1/', AI_API_KEY: 'ck', AI_MODEL: 'm1', GROQ_API_KEY: 'gk' }, fetchImpl }); calls.length = 0;
  assert.equal(await custom.complete({ system: 'S', messages: [{ role: 'user', content: 'x' }] }), 'Hello from custom'); assert.equal(calls[0].url, 'https://llm.example/v1/chat/completions');
  const hang = aiMod.makeAiClient({ env: { GROQ_API_KEY: 'gk' }, timeoutMs: 40, fetchImpl: (u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted')))) });
  await assert.rejects(hang.complete({ system: 'S', messages: [] }), /timed out after 40ms/);
  let live = 0, peak = 0; await Promise.all(Array.from({ length: 6 }, () => aiMod.throughAiGate(2, async () => { live++; peak = Math.max(peak, live); await sleep(15); live--; })));
  assert.equal(peak, 2);
  ok('AI client: no keys = unavailable; failover groq → gemini with the right request shapes; failed provider cooled down; custom endpoint first; timeouts; at most 2 calls at once');
}

// ═══ C. the care engine and plugin ═══════════════════════════════════════════
const aiCalls = []; let aiScript = [];
const fakeAi = { providers: 1, async complete(req) { aiCalls.push(req); const n = aiScript.shift(); if (n instanceof Error) throw n; return n ?? 'The Kenwood electric kettle is ₦9,600. Want me to tell the owner you’d like it? 😊'; } };
aiMod.setAiClient(fakeAi);
const nowHour = localParts(Date.now(), 'Africa/Lagos').hour;
const CLOSED = { hoursStart: (nowHour + 2) % 24, hoursEnd: (nowHour + 4) % 24 };   // the shop is closed right now, whatever time the test runs
let shopN = 0, pid = 0;
const mkProduct = (over = {}) => ({ id: `ai${++pid}`, vendorChatId: 'VG@g.us', vendorName: 'Shoe Plug', sender: '1', createdAt: Date.now() - pid, updatedAt: Date.now(), status: 'posted', media: [], hashes: [`H${pid}`], rawCaption: 'Kenwood electric kettle 8,000', parsed: [], cost: 8000, manualPrice: null, needsReview: false, reposts: 0, priceHistory: [], sourceMessageIds: [`m${pid}`], ...over });
async function shop(opts = {}) {
  const n = ++shopN; const number = `23480100${String(n).padStart(5, '0')}`;
  const sock = fakeSock(`${number}:1@s.whatsapp.net`); const ctx = online(rec(`shop${n}`, number), sock);
  const host = new PluginHost({ sessions: fakeSessions }); [corePlugin, menuPlugin, { ...aic.default, schedules: [] }].forEach((p) => host.register(p));
  host.onSocket(ctx, sock); bs.registerPromptListener(sock);
  await updateSettings(ctx, { markupPercent: 20, roundingStep: 100, brandName: 'Acme Home', contactLine: 'Order: 0901 111 2222', hoursStart: 0, hoursEnd: 0, shopInfo: 'Delivery within Lagos is ₦2,000. Pay by bank transfer.', aiMode: 'away', aiAwayDelaySec: 90, ...opts });
  const kettle = mkProduct(); const table = mkProduct({ rawCaption: 'laptop table with drawer,8.000' }); await saveProduct(ctx, kettle); await saveProduct(ctx, table);
  await addVendor(ctx, 'VG@g.us', 'Shoe Plug'); await addTarget(ctx, 'CUST@g.us', 'Buyers');
  await recordSent(ctx, kettle.id, 'CUST@g.us', ['GMSG1']); await recordSent(ctx, kettle.id, 'status@broadcast', ['STMSG1']);
  const own = `${number}@s.whatsapp.net`;
  const cust = (k) => `23470200${String(k).padStart(5, '0')}@s.whatsapp.net`;
  const dm = (k, text, extra = {}) => up(sock, [msg({ chat: cust(k), from: undefined, text, ...extra })]);
  const run = (now, ai = fakeAi) => aic.sweep(ctx, { ai, now, sleep: async () => {} });
  return { n, number, sock, ctx, host, kettle, table, own, cust, dm, run };
}
const owners = (S) => S.sock.sent.filter((x) => x.jid === S.own);          // private notices to the owner
const toCust = (S, k) => S.sock.sent.filter((x) => x.jid === S.cust(k));

{ // off / away / owner takeover / answering from the catalog
  const S = await shop({ aiMode: 'off' }); const T = Date.now();
  S.dm(1, 'how much is the kenwood kettle?'); await sleep(60);
  assert.deepEqual(await S.run(T + 200_000), []); assert.equal(aiCalls.length, 0);
  await updateSettings(S.ctx, { aiMode: 'away' });
  S.dm(2, 'how much is the kenwood kettle?'); await sleep(60);
  assert.deepEqual(await S.run(T + 10_000), []);                                   // still inside the 90 seconds: you get the first go
  up(S.sock, [msg({ chat: S.cust(2), fromMe: true, text: 'Hello, it is available 😊' })]); await sleep(60);   // you answered yourself
  assert.deepEqual(await S.run(T + 120_000), []); assert.equal(aiCalls.length, 0);
  S.dm(2, 'and the delivery?'); await sleep(60);                                   // you're still handling this chat
  assert.deepEqual(await S.run(T + 300_000), []); assert.equal(aiCalls.length, 0);
  S.dm(3, 'how much is the kenwood kettle?'); await sleep(60);
  const out = await S.run(Date.now() + 95_000);
  assert.deepEqual(out.map((o) => o.kind), ['reply']); assert.equal(aiCalls.length, 1);
  const prompt = aiCalls[0].system;
  assert.match(prompt, /Price: ₦9,600 \| Status: available/); assert.match(prompt, /Delivery within Lagos is ₦2,000/);
  assert.ok(!/8,000|8000|Shoe Plug/.test(prompt), 'the model must never see the vendor price or name');
  assert.ok(!/laptop table/i.test(prompt), 'only the item they asked about is in the prompt');
  assert.deepEqual(toCust(S, 3).map((x) => x.content.text), ['The Kenwood electric kettle is ₦9,600. Want me to tell the owner you’d like it? 😊']);
  assert.equal(await aiSentOn(S.ctx, localParts(Date.now(), 'Africa/Lagos').day), 1); assert.equal((await listAiLog(S.ctx))[0].kind, 'reply');
  ok('DMs: off = silent; away = waits 90s and cancels when you answer; stays quiet while you handle a chat; otherwise answers from the item facts only (no vendor name or cost in the prompt)');
}

{ // hand-offs: rules, model token, hallucinated price, AI down, media
  const S = await shop(); aiCalls.length = 0;
  const go = async (k, text, extra) => { S.dm(k, text, extra); await sleep(60); return S.run(Date.now() + 95_000); };
  let o = await go(11, 'I want to buy the kenwood kettle');
  assert.deepEqual(o.map((x) => x.reason), ['order-intent']); assert.equal(aiCalls.length, 0);
  assert.match(toCust(S, 11)[0].content.text, /Great choice! 🎉 I’ve let the owner know you’d like the Kenwood electric kettle/);
  const notice = owners(S).at(-1).content.text; assert.match(notice, /\*Amaka\* wants to order/); assert.match(notice, /Item: Kenwood electric kettle/); assert.match(notice, /https:\/\/wa\.me\/2347020000011/);
  o = await go(12, 'abeg last price for the kettle?'); assert.equal(o[0].reason, 'bargain'); assert.match(toCust(S, 12)[0].content.text, /check with the owner about the price/);
  o = await go(13, 'I want to speak to the owner'); assert.equal(o[0].reason, 'asked-for-human');
  S.dm(14, '', { extra: { imageMessage: { mimetype: 'image/jpeg' } } }); await sleep(60); o = await S.run(Date.now() + 95_000);
  assert.equal(o[0].reason, 'media'); assert.match(toCust(S, 14)[0].content.text, /passed this to the owner/);
  assert.equal(aiCalls.length, 0, 'orders, bargains, complaints and photos never reach the model');
  aiScript = ['It’s ₦7,000 only for you my friend'];
  o = await go(15, 'how much is the kenwood kettle?'); assert.equal(o[0].reason, 'guard:price'); assert.match(toCust(S, 15)[0].content.text, /confirm that with the owner/);
  assert.ok(!/7,000/.test(toCust(S, 15)[0].content.text));
  aiScript = ['We buy it from Shoe Plug at a wholesale price']; o = await go(16, 'where is the kettle from?'); assert.equal(o[0].reason, 'guard:leak');
  aiScript = ['[HANDOFF] I will check the warranty with the owner']; o = await go(17, 'does the kenwood kettle have warranty?');
  assert.equal(o[0].kind, 'handoff'); assert.equal(o[0].reason, 'model-handoff'); assert.equal(toCust(S, 17)[0].content.text, 'I will check the warranty with the owner');
  aiScript = [new Error('all AI providers failed')]; o = await go(18, 'how much is the kenwood kettle?'); assert.equal(o[0].reason, 'ai-unavailable');
  const leads = await listLeads(S.ctx, { open: true }); const kinds = leads.map((l) => l.kind).sort();
  assert.deepEqual(kinds, ['bargain', 'human', 'media', 'order', 'question', 'question', 'question', 'question'].sort());
  ok('hand-offs: order / bargain / complaint / photo go straight to you (no model); an invented price, a vendor leak, a model [HANDOFF] or an AI outage become a safe holding reply + a lead + a private notice with a wa.me link');
}

{ // after a hand-off the assistant steps back; hours; always; no-reply text; follow-ups; stale messages
  const S = await shop(); aiCalls.length = 0;
  S.dm(21, 'I want to buy the kettle'); await sleep(60); await S.run(Date.now() + 95_000);
  S.dm(21, 'hello are you there?'); await sleep(60);
  assert.deepEqual(await S.run(Date.now() + 400_000), []);                          // handed over: the owner takes it from here
  S.dm(22, 'ok thanks'); await sleep(60); assert.deepEqual((await S.run(Date.now() + 95_000)).map((o) => o.reason), ['no-reply-needed']); assert.equal(toCust(S, 22).length, 0);
  const T = Date.now();
  S.dm(23, 'how much is the kenwood kettle?'); await sleep(60); await S.run(T + 95_000); aiCalls.length = 0;
  S.dm(23, 'and is it available?'); await sleep(60); await S.run(T + 200_000);
  assert.match(aiCalls[0].system, /Kenwood electric kettle/); assert.deepEqual(aiCalls[0].messages.map((m) => m.role), ['user', 'assistant', 'user']);
  aiCalls.length = 0; S.dm(23, 'yes please'); await sleep(60);
  assert.deepEqual((await S.run(T + 300_000)).map((o) => o.reason), ['order-intent']); assert.equal(aiCalls.length, 0);   // "yes" to the owner offer = an order, no model call
  assert.match(toCust(S, 23).at(-1).content.text, /Great choice/);
  up(S.sock, [msg({ chat: S.cust(24), from: S.cust(24), text: 'how much is the kettle', ts: Date.now() - 2 * 3_600_000 })], 'append'); await sleep(60);
  assert.deepEqual(await S.run(Date.now() + 95_000), []);                           // a message that sat unanswered for hours is not answered now
  await updateSettings(S.ctx, CLOSED); S.dm(25, 'how much is the kenwood kettle?'); await sleep(60);
  assert.deepEqual((await S.run(Date.now() + 5_000)).map((o) => o.kind), ['reply']);   // closed: no 90-second wait
  await updateSettings(S.ctx, { hoursStart: 0, hoursEnd: 0, aiMode: 'always' }); S.dm(26, 'how much is the kenwood kettle?'); await sleep(60);
  assert.deepEqual((await S.run(Date.now() + 5_000)).map((o) => o.kind), ['reply']);
  ok('assistant steps back after a hand-off; "ok/thanks" gets no reply; follow-ups use the conversation; hours-old messages are ignored; closed hours and "always" answer within seconds');
}

{ // groups and status
  const S = await shop({ aiMode: 'away' }); aiCalls.length = 0; const T = Date.now();
  const inGroup = (k, text, quoted, chat = 'CUST@g.us') => up(S.sock, [msg({ chat, from: S.cust(k), text: undefined, extra: quoted ? { extendedTextMessage: { text, contextInfo: { stanzaId: quoted, remoteJid: chat } } } : { conversation: text } })]);
  inGroup(31, 'who is coming tonight?', null); inGroup(31, 'is this still available?', 'SOMEONE_ELSES_MSG');          // chatter / unknown post
  inGroup(31, 'is this available?', 'GMSG1', 'OTHER@g.us'); inGroup(31, 'price?', 'GMSG1', 'VG@g.us');                // wrong group / a vendor group
  await sleep(60); assert.deepEqual(await S.run(T + 20_000), []);
  inGroup(32, 'how much for 2?', 'GMSG1'); await sleep(60);
  const out = await S.run(T + 20_000);
  assert.deepEqual(out.map((o) => o.kind), ['reply']); assert.match(aiCalls[0].system, /public in a group/); assert.ok(!/laptop table/.test(aiCalls[0].system));
  const sent = S.sock.sent.filter((x) => x.jid === 'CUST@g.us'); assert.equal(sent.length, 1); assert.ok(sent[0].opts.quoted, 'public replies quote the customer’s message');
  // a group is never flooded: spacing, then a cap of 3 per 10 minutes
  for (const k of [33, 34, 35, 36]) inGroup(k, 'price please?', 'GMSG1');
  await sleep(60);
  let now = T + 21_000; const kinds = [];
  for (let i = 0; i < 8; i++) { kinds.push(...(await S.run(now)).map((o) => o.kind)); now += 9_000; }
  assert.equal(kinds.length, 2); assert.equal(S.sock.sent.filter((x) => x.jid === 'CUST@g.us').length, 3);
  await updateSettings(S.ctx, { aiReplyInGroups: false }); inGroup(37, 'is it available?', 'GMSG1'); await sleep(60); assert.deepEqual(await S.run(now + 20_000), []);
  // status replies arrive as DMs that quote the status
  await updateSettings(S.ctx, { aiReplyInGroups: true });
  up(S.sock, [msg({ chat: S.cust(41), from: undefined, extra: { extendedTextMessage: { text: 'how much?', contextInfo: { stanzaId: 'STMSG1', remoteJid: 'status@broadcast' } } } })]); await sleep(60);
  aiCalls.length = 0; const so = await S.run(Date.now() + 20_000);
  assert.deepEqual(so.map((o) => o.kind), ['reply']); assert.match(aiCalls[0].system, /Kenwood electric kettle/);   // the status id led to the right item
  assert.equal(toCust(S, 41).length, 1);
  ok('groups: only replies that quote one of YOUR posts in a posting group are answered (publicly, quoted), never vendor groups or chatter; spaced out and capped; status replies are matched to the item');
}

{ // caps and pause
  const S = await shop({ aiDailyCap: 2, aiMode: 'always' });
  for (const k of [51, 52, 53]) { S.dm(k, 'how much is the kenwood kettle?'); await sleep(60); await S.run(Date.now() + 5_000); }
  assert.equal(toCust(S, 51).length + toCust(S, 52).length, 2); assert.equal(toCust(S, 53).length, 0);
  assert.ok(owners(S).some((x) => /reached today’s limit of 2 replies/.test(x.content.text)));
  const P = await shop({ aiMode: 'always' });
  for (const text of ['how much is the kenwood kettle?', 'is it available?', 'what about delivery?', 'does it come in white?', 'and the colour?']) { P.dm(61, text); await sleep(60); await P.run(Date.now() + 5_000); }
  assert.equal(toCust(P, 61).length, 4);                                            // 4 an hour per customer (set above), then silence
  ok('limits: the daily cap stops replies and tells you once; one customer can’t get more than the hourly cap');
}

{ // .ai commands
  const S = await shop(); aiCalls.length = 0; const say = (t, chat = S.own) => up(S.sock, [msg({ chat, fromMe: true, text: t })]);
  say('.ai status'); await must(() => /Assistant: \*away\*/.test(lastText(S.sock)) && /AI provider: connected/.test(lastText(S.sock)));
  await sleep(900); say('.ai off'); await must(() => /Assistant is OFF/.test(lastText(S.sock))); assert.equal((await getSettings(S.ctx)).aiMode, 'off');
  await sleep(900); say('.ai always'); await must(() => /always\* mode/.test(lastText(S.sock))); assert.equal((await getSettings(S.ctx)).aiMode, 'always');
  await sleep(900); say('.ai pause', S.cust(71)); await must(() => /won’t answer in this chat/.test(lastText(S.sock)));
  S.dm(71, 'how much is the kenwood kettle?'); await sleep(60); assert.deepEqual(await S.run(Date.now() + 5_000), []);       // paused for this chat only
  S.dm(72, 'how much is the kenwood kettle?'); await sleep(60); assert.equal((await S.run(Date.now() + 5_000)).length, 1);
  await sleep(900); say('.ai resume', S.cust(71)); await must(() => /can answer in this chat again/.test(lastText(S.sock)));
  S.dm(71, 'how much is the kenwood kettle?'); await sleep(60); assert.equal((await S.run(Date.now() + 5_000)).length, 1);
  const before = { leads: (await listLeads(S.ctx)).length, log: (await listAiLog(S.ctx)).length, sent: await aiSentOn(S.ctx, localParts(Date.now(), 'Africa/Lagos').day), toCustomers: S.sock.sent.filter((x) => x.jid.includes('70200')).length };
  await sleep(900); say('.ai test how much is the kenwood kettle?'); await must(() => /🧪 \*Test\* \(nothing was sent to anyone\)/.test(lastText(S.sock)));
  assert.match(lastText(S.sock), /Assistant: The Kenwood electric kettle is ₦9,600/); assert.match(lastText(S.sock), /Item matched: Kenwood electric kettle/); assert.equal(S.sock.sent.at(-1).jid, S.own);
  assert.deepEqual({ leads: (await listLeads(S.ctx)).length, log: (await listAiLog(S.ctx)).length, sent: await aiSentOn(S.ctx, localParts(Date.now(), 'Africa/Lagos').day), toCustomers: S.sock.sent.filter((x) => x.jid.includes('70200')).length }, before);
  ok('.ai on/off/always/status, pause/resume per chat, and .ai test (answers privately; leaves no lead, no log, no count, sends nothing to customers)');
}

// ═══ D. the dashboard ════════════════════════════════════════════════════════
{
  const S = await shop({ aiMode: 'off' }); aiCalls.length = 0;
  S.dm(81, 'I want to buy the kenwood kettle'); await sleep(60); await updateSettings(S.ctx, { aiMode: 'always' }); S.dm(82, 'I want to buy the kettle'); await sleep(60); await S.run(Date.now() + 5_000);
  const say = (t) => up(S.sock, [msg({ chat: S.own, fromMe: true, text: t })]);
  say('.menu'); await must(() => /AI care: ✅ always · 🙋 1 lead/.test(lastText(S.sock)));
  say('3'); await must(() => /\*AI customer care\*/.test(lastText(S.sock)) && /Assistant: ✅ ALWAYS/.test(lastText(S.sock)));
  say('1'); await must(() => /Assistant mode/.test(lastText(S.sock))); say('2'); await must(() => /Assistant is on \(away\)/.test(lastText(S.sock)));
  assert.equal((await getSettings(S.ctx)).aiMode, 'away');
  say('2'); await must(() => /It won’t reply in groups/.test(lastText(S.sock))); assert.equal((await getSettings(S.ctx)).aiReplyInGroups, false);
  say('5'); await must(() => /Send your shop info/.test(lastText(S.sock))); say('Delivery is free over ₦20,000. We are in Ikeja.'); await must(() => /Shop info saved/.test(lastText(S.sock)));
  assert.equal((await getSettings(S.ctx)).shopInfo, 'Delivery is free over ₦20,000. We are in Ikeja.');
  say('4'); await must(() => /\*Timing & limits\*\n/.test(lastText(S.sock))); say('1'); await must(() => /how many seconds/i.test(lastText(S.sock))); say('120'); await must(() => /Wait time: 120/.test(lastText(S.sock)));
  assert.equal((await getSettings(S.ctx)).aiAwayDelaySec, 120);
  say('0'); await sleep(40);
  ok('dashboard: AI care status on Home; mode, group toggle, shop info and timing are editable and saved');
}
{
  const S = await shop({ aiMode: 'always' }); aiCalls.length = 0;
  S.dm(91, 'I want to buy the kenwood kettle', { pushName: 'Chioma' }); await sleep(60); await S.run(Date.now() + 5_000);
  const say = (t) => up(S.sock, [msg({ chat: S.own, fromMe: true, text: t })]);
  say('.menu'); await must(() => /🙋 1 lead/.test(lastText(S.sock)));
  say('3'); await must(() => /\*AI customer care\*/.test(lastText(S.sock)));
  say('7'); await must(() => /\*Leads\*/.test(lastText(S.sock)) && /Chioma/.test(lastText(S.sock)));
  say('1'); await must(() => /wa\.me\/2347020000091/.test(lastText(S.sock)) && /Wants: order · Kenwood electric kettle/.test(lastText(S.sock)));
  say('1'); await must(() => /Marked as done/.test(lastText(S.sock))); assert.equal((await listLeads(S.ctx, { open: true })).length, 0);
  say('1'); await must(() => /\*AI customer care\*/.test(lastText(S.sock)) && /open leads: 0/.test(lastText(S.sock)));   // Back from the (now empty) Leads list
  say('8'); await must(() => /Recent replies/.test(lastText(S.sock)) && /Chioma/.test(lastText(S.sock)) && /Great choice/.test(lastText(S.sock)));
  say('0'); await sleep(40);
  ok('dashboard: a lead shows the customer, phone link, item and what they wrote, and can be marked done; Recent replies shows what the assistant said');
}

console.log(`\n${passed} stage-5 checks passed`);
process.exit(0);
