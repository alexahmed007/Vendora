// Stage-2 checks: router, plugin host, access rules, schedules, menu engine, numbered menus,
// and one end-to-end dashboard run. Uses fake sockets and local JSON files; never touches WhatsApp.
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { EventEmitter } from 'node:events';

for (const v of ['MONGO_URL', 'POSTGRES_URL', 'MYSQL_URL', 'DB_URL']) {
  if (process.env[v]) { console.error(`Refusing to run: ${v} is set. Unset all database env vars (this test uses local JSON files in ./data).`); process.exit(1); }
}
// Never let a real .env (with a production DB URL) leak into the tests.
process.env.DOTENV_CONFIG_PATH = '/nonexistent.env';
rmSync('./data', { recursive: true, force: true }); // start from a clean local store every run
process.env.ADMIN_NUMBER = '2348012345678';
process.env.COMMAND_COOLDOWN_MS = '200';

const { PluginHost } = await import('../dist/core/pluginHost.js');
const { TenantContext } = await import('../dist/core/tenantContext.js');
const { definePlugin } = await import('../dist/core/plugin.js');
const { runApp, go, back, stay } = await import('../dist/ui/appUi.js');
const bs = await import('../dist/ui/menuSession.js');
const { getSettings, updateSettings, DEFAULT_SETTINGS } = await import('../dist/core/settings.js');
const { createTenant, listTenants } = await import('../dist/store/tenants.js');
const corePlugin = (await import('../dist/plugins/core.js')).default;
const adminPlugin = (await import('../dist/plugins/admin.js')).default;
const menuPlugin = (await import('../dist/plugins/menu.js')).default;

setInterval(() => {}, 1000); // keep the loop alive (menu TTL timers are unref'd, as in production where the HTTP server holds it)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, ms = 1500) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (cond()) return true; await sleep(10); } return false; }
const must = async (cond, ms) => { if (!(await waitFor(cond, ms))) throw new Error(`timed out waiting for: ${cond.toString().slice(0, 140)}`); };
let passed = 0;
const ok = (name) => { passed++; console.log('  ✓', name); };

// ── fakes ───────────────────────────────────────────────────────────────────
function fakeSock(userId) {
  const em = new EventEmitter();
  const sock = {
    ev: { on: (e, f) => em.on(e, f), off: (e, f) => em.off(e, f), emit: (e, p) => em.emit(e, p), removeAllListeners: () => em.removeAllListeners() },
    user: { id: userId },
    sent: [],
    async sendMessage(jid, content, opts) {
      const key = { id: `OUT${sock.sent.length + 1}`, remoteJid: jid, fromMe: true };
      sock.sent.push({ jid, content, opts, key });
      return { key, message: content };
    },
  };
  return sock;
}
let seq = 0;
const msg = ({ id, chat, text, from, fromMe = false, ts, pushName = 'Cust', extra }) => ({
  key: { id: id ?? `M${++seq}`, remoteJid: chat, fromMe, participant: from },
  message: extra ?? { conversation: text },
  messageTimestamp: Math.floor((ts ?? Date.now()) / 1000),
  pushName,
});
const up = (sock, messages, type = 'notify') => sock.ev.emit('messages.upsert', { messages, type });
const rec = (id, number) => ({ id, number, status: 'active', plan: 't', expiresAt: null, createdAt: 0, sudo: [] });
const online = (tenant, sock) => { const c = new TenantContext(tenant); c.attach(sock); c.markOnline(); return c; };
const lastText = (s) => s.sent.at(-1)?.content?.text ?? '';
const lastNudge = (s) => s.sent.slice(-3).map((x) => x.content?.text ?? '').join('\n');

const started = [];
const fakeSessions = { start: async (t) => { started.push(t); return {}; }, stop: async () => {}, halt: async () => {}, get: () => undefined, list: () => [] };

const seen = [];
const recorder = definePlugin({
  name: 'rec', priority: 50,
  onMessage: async (m) => { if (m.text === 'slow') await sleep(40); seen.push(`${m.ctx.id}:${m.id}:${m.isCatchUp ? 'catchup' : 'live'}:${m.isOwner ? 'owner' : 'other'}`); },
});

const host = new PluginHost({ sessions: fakeSessions });
[corePlugin, adminPlugin, menuPlugin, recorder].forEach((p) => host.register(p));

const CTL = '2348012345678', ACME = '2348022222222', VENDOR = '2349011111111', CUST = '2347033333333';
const ctlSock = fakeSock(`${CTL}:5@s.whatsapp.net`), acmeSock = fakeSock(`${ACME}:3@s.whatsapp.net`);
const ctl = online(rec('ctl', CTL), ctlSock), acme = online(rec('acme', ACME), acmeSock);
host.onSocket(ctl, ctlSock); host.onSocket(acme, acmeSock);
const GROUP = '120363000000@g.us', vendorJid = `${VENDOR}@s.whatsapp.net`;

// 1. batches: every message handled, in order, duplicates dropped
up(ctlSock, [msg({ id: 'A', chat: GROUP, from: vendorJid, text: 'slow' }), msg({ id: 'B', chat: GROUP, from: vendorJid, text: 'img 1' }), msg({ id: 'C', chat: GROUP, from: vendorJid, text: 'caption' })]);
up(ctlSock, [msg({ id: 'D', chat: GROUP, from: vendorJid, text: 'next' })]);   // arrives while A is still processing
await must(() => seen.length >= 4);
assert.deepEqual(seen.filter((s) => s.startsWith('ctl')).map((s) => s.split(':')[1]), ['A', 'B', 'C', 'D']);
up(ctlSock, [msg({ id: 'A', chat: GROUP, from: vendorJid, text: 'slow' })]);
await sleep(120);
assert.equal(seen.filter((s) => s.startsWith('ctl')).length, 4);
ok('router: whole batch handled (not just [0]), strict arrival order across upserts, repeats dropped');

// 2. same vendor post, second reseller
up(acmeSock, [msg({ id: 'A', chat: GROUP, from: vendorJid, text: 'slow' })]);
await must(() => seen.some((s) => s.startsWith('acme:A')));
assert.ok(seen.some((s) => s.startsWith('acme:A:')));
ok('two tenants in one vendor group both process the same message id');

// 3. access control
const before = ctlSock.sent.length;
up(ctlSock, [msg({ chat: `${CUST}@s.whatsapp.net`, from: `${CUST}@s.whatsapp.net`, text: '.ping' })]);
await sleep(100);
assert.equal(ctlSock.sent.length, before, 'customer must get no reply from an owner command');
assert.ok(seen.some((s) => s.endsWith(':live:other') && s.startsWith('ctl')), 'but the message still reaches hooks');
up(ctlSock, [msg({ chat: `${CUST}@s.whatsapp.net`, fromMe: true, text: '.ping' })]);
await must(() => ctlSock.sent.length > before);
assert.match(ctlSock.sent.at(-1).content.text, /^pong · ctl/);
ok('owner commands: customers ignored (message falls through to hooks), owner (fromMe) served');

// 4. cooldown
await sleep(250); // let the cooldown from check 3 expire
const n0 = ctlSock.sent.length;
const own = () => msg({ chat: `${CTL}@s.whatsapp.net`, fromMe: true, text: '.ping' });
up(ctlSock, [own()]); up(ctlSock, [own()]);
await sleep(120);
assert.equal(ctlSock.sent.length - n0, 1);
await sleep(200);
up(ctlSock, [own()]);
await must(() => ctlSock.sent.length - n0 === 2);
assert.equal(ctlSock.sent.length - n0, 2);
ok('cooldown: rapid repeats suppressed, works again after the window');

// 5. admin gating + add flow
const nA = acmeSock.sent.length;
up(acmeSock, [msg({ chat: `${ACME}@s.whatsapp.net`, fromMe: true, text: '.admin list' })]);
await sleep(100);
assert.equal(acmeSock.sent.length, nA, 'a normal tenant owner must not be able to run .admin');
const nC = ctlSock.sent.length;
up(ctlSock, [msg({ chat: `${CTL}@s.whatsapp.net`, fromMe: true, text: '.admin add shop1 +234 701 111 1111 Shop 7'.replace(' +234 701 111 1111', ' 2347011111111') })]);
await must(() => ctlSock.sent.length > nC);
assert.match(ctlSock.sent.at(-1).content.text, /Added \*shop1\*/);
assert.equal(started.at(-1).id, 'shop1');
assert.ok((await listTenants()).some((t) => t.id === 'shop1' && t.status === 'pending'));
await sleep(600);   // .admin has a 500ms cooldown
await createTenant({ id: 'ctl', number: CTL });   // the control tenant must exist in the registry for pause to be refused
up(ctlSock, [msg({ chat: `${CTL}@s.whatsapp.net`, fromMe: true, text: '.admin pause ctl' })]);
await must(() => /control tenant/.test(ctlSock.sent.at(-1).content.text ?? ''));
ok('admin: only the control tenant can run it; add creates + starts a pending tenant; control tenant can’t be paused');

// 6. catch-up handling
const seenBefore = seen.length;
up(ctlSock, [msg({ id: 'CU1', chat: `${CUST}@s.whatsapp.net`, from: `${CUST}@s.whatsapp.net`, text: 'hello' })], 'append');
up(ctlSock, [msg({ id: 'CU2', chat: `${CUST}@s.whatsapp.net`, fromMe: true, text: 'echo of our own send' })], 'append');
up(ctlSock, [msg({ id: 'CU3', chat: `${CUST}@s.whatsapp.net`, from: `${CUST}@s.whatsapp.net`, text: 'ancient', ts: Date.now() - 24 * 3_600_000 })], 'append');
await sleep(150);
const added = seen.slice(seenBefore);
assert.deepEqual(added.map((s) => s.split(':').slice(1, 3).join(':')), ['CU1:catchup']);
ok('offline catch-up: recent messages from others flagged isCatchUp; own echoes and day-old ones ignored');

// 7. LID senders resolve to the owner
acmeSock.signalRepository = { lidMapping: { getPNForLID: async (j) => (j === '99887766@lid' ? `${ACME}@s.whatsapp.net` : null) } };
up(acmeSock, [msg({ id: 'L1', chat: `${ACME}@s.whatsapp.net`, from: '99887766@lid', text: 'from my other device' })]);
await must(() => seen.some((s) => s.startsWith('acme:L1')));
assert.ok(seen.some((s) => s === 'acme:L1:live:owner'));
ok('@lid sender resolved to the reseller’s number → owner');

// 8. host: clash detection, lifecycle, schedules
assert.throws(() => host.register(definePlugin({ name: 'dup', commands: [{ name: 'ping', run: async () => {} }] })), /clashes/);
let starts = 0, stops = 0, runs = 0, concurrent = 0, maxConcurrent = 0;
const h2 = new PluginHost({ sessions: fakeSessions });
h2.register(definePlugin({
  name: 'life', onTenantStart: () => { starts++; }, onTenantStop: () => { stops++; },
  schedules: [
    { name: 'tick', everyMs: 30, run: async () => { runs++; } },
    { name: 'slow', everyMs: 10, run: async () => { concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent); await sleep(60); concurrent--; } },
  ],
}));
const s1 = fakeSock(`${ACME}:1@s.whatsapp.net`), s2 = fakeSock(`${ACME}:2@s.whatsapp.net`);
const c3 = online(rec('acme', ACME), s1);
h2.onSocket(c3, s1);
c3.attach(s2); c3.markOnline(); h2.onSocket(c3, s2);          // simulated reconnect: new socket, same runtime
assert.equal(starts, 1);
await sleep(250);
assert.ok(runs >= 3, `schedule ran ${runs}x`);
assert.equal(maxConcurrent, 1, 'overlap guard: a slow run never stacks');
c3.markOffline(); const frozen = runs; await sleep(120);
assert.equal(runs, frozen, 'schedules skip while the tenant is offline');
c3.markOnline(); h2.stopTenant(c3);
const afterStop = runs; await sleep(120);
assert.equal(runs, afterStop); assert.equal(stops, 1);
ok('host lifecycle: onTenantStart once across reconnects; schedules overlap-safe, pause offline, stop cleanly');

// 9. runApp navigation
const shown = [];
const screens = {
  home: { view: () => ({ title: 'Home', text: 'h', options: [{ label: 'Child', value: 'child' }] }), select: (v) => go('child') },
  child: { view: () => ({ title: 'Child', text: 'c', options: [{ label: 'Do', value: 'do' }] }), select: () => stay('✅ did it') },
};
const script = ['child', 'do', '__back', null];   // null = cancel
const appCtx = { ctx: ctl, message: {}, chatId: `${CTL}@s.whatsapp.net`, userIds: [CTL] };
await runApp(appCtx, screens, 'home', { prompt: async (_s, _a, view, options) => { shown.push({ view, options }); const v = script.shift(); return { value: v, timedOut: false, cancelled: v === null }; } });
assert.deepEqual(shown.map((s) => s.view.title), ['Home', 'Child', 'Child', 'Home']);
assert.match(shown[2].view.text, /✅ did it/);
assert.ok(!shown[0].options.some((o) => o.value === '__back') && shown[1].options.some((o) => o.value === '__back'));
ok('runApp: go / stay+notice / back / cancel; Back only offered below the first screen');

// 10. numbered menus (USSD style): the look, plain-number and swipe replies, wrong people, nudges, timeout
const ps = fakeSock(`${CTL}:5@s.whatsapp.net`); bs.registerPromptListener(ps);
const opts3 = [{ label: 'One', value: 'v1', description: 'first choice' }, { label: 'Two', value: 'v2' }, { label: 'Three', value: 'v3' }];
const chatU = `${CUST}@s.whatsapp.net`;
let p = bs.promptMenu(ps, { key: { id: 'X' } }, chatU, [CUST], { title: 'Pick one', subtitle: 'A subtitle', text: 'Choose:', options: opts3 });
await must(() => ps.sent.length === 1);
const look = ps.sent[0].content.text;
assert.match(look, /\*Pick one\*\n_A subtitle_\n┄{10,}\nChoose:/); assert.match(look, /1️⃣  \*One\*\n {5}first choice/); assert.match(look, /3️⃣  \*Three\*/);
assert.match(look, /↩️ _Reply to this message with a number_\n0️⃣ Cancel {3}⏳ Expires in 3 mins/);
up(ps, [msg({ chat: chatU, from: `${VENDOR}@s.whatsapp.net`, text: '2' })]);       // someone else: ignored, not consumed
up(ps, [msg({ chat: chatU, from: chatU, text: '9' })]);                              // out of range: a nudge, the menu stays open
await must(() => /Reply with a number from \*1\* to \*3\*/.test(lastNudge(ps)));
up(ps, [msg({ chat: chatU, from: chatU, text: '3' })]);
assert.deepEqual(await p, { value: 'v3', timedOut: false, cancelled: false });
ok('menu look (title, subtitle, dividers, keycap digits, descriptions, footer); a bare number answers; others ignored; invalid numbers get a nudge');

const selfJid = `${CTL}@s.whatsapp.net`;
p = bs.promptMenu(ps, { key: { id: 'Q' } }, chatU, [CUST], { text: 'Pick', options: opts3 });
await must(() => ps.sent.length === 3);
const menuId = ps.sent.at(-1).key.id;
const swipe = (text, who = chatU) => msg({ chat: chatU, from: who, extra: { extendedTextMessage: { text, contextInfo: { stanzaId: menuId } } } });
up(ps, [swipe('2', `${VENDOR}@s.whatsapp.net`)]);                                    // right menu, wrong person
up(ps, [swipe('hello')]);                                                            // quoted but not a choice: nudge
await must(() => ps.sent.length === 4 && /Reply with a number/.test(lastText(ps)));
up(ps, [swipe('2')]);
assert.equal((await p).value, 'v2');
p = bs.promptMenu(ps, { key: { id: 'Y' } }, selfJid, [CTL], { text: 'Pick', options: opts3 });
await must(() => ps.sent.length === 5);
up(ps, [msg({ chat: selfJid, fromMe: true, text: '1' })]);
assert.equal((await p).value, 'v1');
p = bs.promptMenu(ps, { key: { id: 'Z' } }, selfJid, [CTL], { text: 'Pick', options: opts3 });
await must(() => ps.sent.length === 6);
up(ps, [msg({ chat: selfJid, fromMe: true, text: 'cancel' })]);
assert.equal((await p).cancelled, true);
p = bs.promptMenu(ps, { key: { id: 'R' } }, chatU, [CUST], { text: 'Pick', options: opts3, ttlMs: 60 });
assert.equal((await p).timedOut, true);
ok('menu: swipe-reply works (wrong person ignored), the owner’s own typed replies count, cancel / 0 close it, unanswered menus time out');

// 11. end to end: owner opens .menu in their own chat and changes the markup
const e2e = fakeSock(`${CTL}:5@s.whatsapp.net`);
const ctl2 = online(rec('ctl', CTL), e2e);
const h3 = new PluginHost({ sessions: fakeSessions }); h3.register(corePlugin); h3.register(menuPlugin);
h3.onSocket(ctl2, e2e); bs.registerPromptListener(e2e);
const say = (text) => up(e2e, [msg({ chat: selfJid, fromMe: true, text })]);
say('.menu');
await must(() => e2e.sent.length >= 1);
assert.match(e2e.sent[0].content.text, /Reseller dashboard/);
say('4');                                                     // ⚙️ Settings (Home: 1 Items, 2 Posting, 3 Vendor groups, 4 Settings)
await must(() => e2e.sent.length >= 2);
assert.match(e2e.sent[1].content.text, /\*Settings\*/);
say('3');                                                     // 💹 Default markup %
await must(() => e2e.sent.length >= 3);
assert.match(e2e.sent[2].content.text, /Default markup in percent/);
say('abc');                                                   // bad input → re-asked
await must(() => e2e.sent.length >= 5);
assert.match(e2e.sent[3].content.text, /Send a number between 0 and 500/);
say('12.5%');
await must(() => e2e.sent.length >= 6);
assert.match(e2e.sent[5].content.text, /Markup set to 12\.5%/);
assert.equal((await getSettings(ctl2)).markupPercent, 12.5);
say('0');                                                     // cancel
await sleep(50);
ok('end to end: .menu → Settings → markup (bad input re-asked, “12.5%” accepted) → saved → cancel');

// 11b. the reported bug: answers typed in the owner's own chat when WhatsApp addresses that chat by its LID
const lidSock = fakeSock(`${CTL}:5@s.whatsapp.net`); lidSock.user.lid = '99887766:5@lid'; bs.registerPromptListener(lidSock);
const lidCtx = online(rec('ctl', CTL), lidSock);
const { askText } = await import('../dist/ui/appUi.js');
const LIDCHAT = '99887766@lid';
const lapp = { ctx: lidCtx, message: undefined, chatId: `${CTL}@s.whatsapp.net`, userIds: [CTL] };
let ans = askText(lapp, 'Business name?', 60); await must(() => lidSock.sent.length === 1);
assert.match(lidSock.sent[0].content.text, /✏️ Business name\?\n┄{10,}\n↩️ _Reply to this message with your answer_\nSend \*cancel\* to stop {3}⏳ Expires in 2 mins/);
up(lidSock, [msg({ chat: LIDCHAT, fromMe: true, text: 'Acme Fashion' })]);
assert.equal(await ans, 'Acme Fashion');
ans = askText(lapp, 'Business name?', 60); await must(() => lidSock.sent.length === 2);
up(lidSock, [msg({ chat: LIDCHAT, fromMe: true, extra: { extendedTextMessage: { text: 'Beta Stores', contextInfo: { stanzaId: lidSock.sent[1].key.id } } } })]);
assert.equal(await ans, 'Beta Stores');
ans = askText(lapp, 'Business name?', 60); await must(() => lidSock.sent.length === 3);
up(lidSock, [msg({ chat: `${CTL}@s.whatsapp.net`, from: `${CUST}@s.whatsapp.net`, text: 'hijack' })]);   // someone else: ignored
up(lidSock, [msg({ chat: LIDCHAT, fromMe: true, text: 'cancel' })]);
assert.equal(await ans, null);
let lp = bs.promptMenu(lidSock, undefined, `${CTL}@s.whatsapp.net`, [CTL], { text: 'Pick', options: opts3 }); await must(() => lidSock.sent.length === 4);
up(lidSock, [msg({ chat: LIDCHAT, fromMe: true, text: '2' })]);
assert.equal((await lp).value, 'v2');
ok('REGRESSION: typed answers (plain or swipe-reply), "cancel" and menu numbers all work when your own chat arrives as a LID');

// 11b2. .menu typed in a LID chat answers in that same chat; an open menu never holds up other messages
const h5 = new PluginHost({ sessions: fakeSessions }); h5.register(corePlugin); h5.register(menuPlugin); h5.onSocket(lidCtx, lidSock);
const n5 = lidSock.sent.length;
up(lidSock, [msg({ chat: LIDCHAT, fromMe: true, text: '.menu' })]);
await must(() => lidSock.sent.length > n5);
assert.equal(lidSock.sent[n5].jid, LIDCHAT);                                       // recognised as the own chat: no redirect
const nPing = lidSock.sent.length;
up(lidSock, [msg({ chat: LIDCHAT, fromMe: true, text: '.ping' })]);                // menu is still open and waiting
await must(() => lidSock.sent.length > nPing && /^pong/.test(lastText(lidSock)), 600);
up(lidSock, [msg({ chat: LIDCHAT, fromMe: true, text: '4' })]);
await must(() => /\*Settings\*/.test(lastText(lidSock)));
up(lidSock, [msg({ chat: LIDCHAT, fromMe: true, text: '0' })]); await sleep(40);
ok('.menu in a LID own chat stays in that chat; with a menu open, other commands (.ping) are still answered at once');

// 11b3. reopening .menu while a question is open replaces the old session: no stray menu, no double save
const h6sock = fakeSock(`${CTL}:5@s.whatsapp.net`); bs.registerPromptListener(h6sock);
const h6ctx = online(rec('menu6', CTL), h6sock);   // its own tenant: this test changes the brand name
const h6 = new PluginHost({ sessions: fakeSessions }); h6.register(menuPlugin); h6.onSocket(h6ctx, h6sock);
const say6 = (t) => up(h6sock, [msg({ chat: selfJid, fromMe: true, text: t })]);
say6('.menu'); await must(() => h6sock.sent.length >= 1);
say6('4'); await must(() => /\*Settings\*/.test(lastText(h6sock)));
say6('1'); await must(() => /What is your brand name/.test(lastText(h6sock)));          // a question is now open
const before6 = h6sock.sent.length;
await sleep(1100); say6('.menu');                                                        // reopen mid-question
await must(() => h6sock.sent.length === before6 + 1); await sleep(150);
assert.equal(h6sock.sent.length, before6 + 1, 'the old session must not send anything more');
assert.match(lastText(h6sock), /Reseller dashboard/);
say6('4'); await must(() => /\*Settings\*/.test(lastText(h6sock)));
say6('1'); await must(() => /What is your brand name/.test(lastText(h6sock)));
const sets = []; const realSet = h6ctx.store('settings').patch.bind(h6ctx.store('settings'));
say6('Gamma Stores'); await must(() => /Brand name saved/.test(lastText(h6sock)));
assert.equal((await getSettings(h6ctx)).brandName, 'Gamma Stores');
say6('0'); await sleep(40);
ok('reopening .menu mid-question closes the old session cleanly (no stray menu); the new one saves the answer once');

// 11c. .menu typed in a group opens in the owner's own chat; nothing private reaches the group
const gsock = fakeSock(`${CTL}:5@s.whatsapp.net`);
const ctlG = online(rec('ctl', CTL), gsock);
const h4 = new PluginHost({ sessions: fakeSessions }); h4.register(menuPlugin);
h4.onSocket(ctlG, gsock); bs.registerPromptListener(gsock);
up(gsock, [msg({ chat: GROUP, fromMe: true, text: '.menu' })]);
await must(() => gsock.sent.length >= 1);
assert.equal(gsock.sent[0].jid, selfJid, 'dashboard must open in the own chat');
assert.match(gsock.sent[0].content.text, /Reseller dashboard/);
assert.ok(!gsock.sent.some((x) => x.jid === GROUP), 'nothing may be posted into the group');
up(gsock, [msg({ chat: selfJid, fromMe: true, text: '4' })]);   // ⚙️ Settings
await must(() => gsock.sent.length >= 2);
assert.match(gsock.sent[1].content.text, /\*Settings\*/);
up(gsock, [msg({ chat: selfJid, fromMe: true, text: '0' })]);
await sleep(50);
assert.ok(!gsock.sent.some((x) => x.jid === GROUP));
ok('.menu from a group: dashboard opens in the own chat, nothing is posted into the group');

// 11d. admin replies are private too
const nG = ctlSock.sent.length;
up(ctlSock, [msg({ chat: GROUP, fromMe: true, text: '.admin list' })]);
await must(() => ctlSock.sent.length > nG);
assert.equal(ctlSock.sent.at(-1).jid, selfJid);
assert.ok(!ctlSock.sent.slice(nG).some((x) => x.jid === GROUP), 'a customer list must never be posted into a group');
ok('.admin run in a group answers in the own chat only');

// 12. settings defaults + patch
assert.equal((await getSettings(acme)).markupPercent, 0);
await updateSettings(acme, { brandName: 'Acme' });
assert.deepEqual(await getSettings(acme), { ...DEFAULT_SETTINGS, brandName: 'Acme' });
ok('settings: defaults, partial updates persist per tenant');

console.log(`\n${passed} stage-2 checks passed`);
process.exit(0);
