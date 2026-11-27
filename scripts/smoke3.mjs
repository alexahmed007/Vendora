// Stage-3 checks: price parsing, caption cleaning, pricing, album grouping, vendor-post ingestion,
// the dashboard (items / vendors / settings) and the admin menu. Fake sockets, local JSON files.
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

const { parsePrices, pickPrimary } = await import('../dist/lib/priceParser.js');
const { cleanCaption } = await import('../dist/lib/captionCleaner.js');
const { resalePrice, DEFAULT_RULES, formatMoney } = await import('../dist/lib/pricingEngine.js');
const { AlbumGrouper } = await import('../dist/lib/albumGrouper.js');
const { detectStockSignal } = await import('../dist/lib/stockSignals.js');
const { mediaOf, albumExpected } = await import('../dist/lib/mediaInfo.js');
const { PluginHost } = await import('../dist/core/pluginHost.js');
const { TenantContext } = await import('../dist/core/tenantContext.js');
const bs = await import('../dist/ui/menuSession.js');
const ingest = await import('../dist/plugins/ingest.js');
const { listProducts, getProduct, countByStatus, pruneCatalog } = await import('../dist/core/catalog.js');
const { listVendors, getVendor } = await import('../dist/core/vendors.js');
const { getSettings, updateSettings } = await import('../dist/core/settings.js');
const { renderProduct } = await import('../dist/core/render.js');
const { createTenant, getTenant, listTenants } = await import('../dist/store/tenants.js');
const corePlugin = (await import('../dist/plugins/core.js')).default;
const adminPlugin = (await import('../dist/plugins/admin.js')).default;
const menuPlugin = (await import('../dist/plugins/menu.js')).default;

setInterval(() => {}, 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, ms = 2500) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (cond()) return true; await sleep(10); } return false; }
const must = async (cond, ms) => { if (!(await waitFor(cond, ms))) throw new Error(`timed out waiting for: ${cond.toString().slice(0, 140)}`); };
let passed = 0;
const ok = (n) => { passed++; console.log('  ✓', n); };

// ═══ A. pure logic ═══════════════════════════════════════════════════════════
const rules = { ...DEFAULT_RULES, markupPercent: 20, roundingStep: 100 };
const clean = (t, extra = {}) => cleanCaption(t, { contactLine: 'Order: 0901 111 2222', currencySymbol: '₦', resale: (c) => resalePrice(c, rules), ...extra });
const vals = (t) => parsePrices(t).map((m) => `${m.value}:${m.kind}`);

assert.deepEqual(vals('Brand new Nike Air Max\nSize 40-45\nPrice: ₦25,000\nCall 08012345678'), ['25000:unspecified']);
assert.deepEqual(vals('Ladies bags 8500 each, 6 pieces 45k'), ['8500:unspecified', '45000:unspecified']);
assert.deepEqual(vals('N15,000 only\nDM +234 801 234 5678'), ['15000:unspecified']);
assert.deepEqual(vals('500ml bottle, 10pcs carton, price 4500'), ['4500:unspecified']);
assert.deepEqual(vals('iPhone 13 128GB 💰 350k'), ['350000:unspecified']);
assert.deepEqual(vals('Size 38 39 40 41\nQty available: 12\nContact: 08098765432'), []);
assert.deepEqual(vals('Price - #7,000 / dozen'), ['7000:unspecified']);
assert.deepEqual(vals('Model 2023 imported, price 18000'), ['18000:unspecified']);
assert.deepEqual(vals('Only 40% off today, 3 colours'), []);
assert.deepEqual(vals('₦12.5k wholesale\n₦15k retail'), ['12500:wholesale', '15000:retail']);
assert.deepEqual(vals('Wholesale price:\n₦4,500'), ['4500:wholesale']);
assert.deepEqual(vals('Was 10,000 now 8,000'), ['10000:old', '8000:unspecified']);
assert.deepEqual(vals('~12,000~ 9,500 only'), ['12000:old', '9500:unspecified']);
assert.equal(pickPrimary(parsePrices('₦15k retail\n₦12.5k wholesale')).value, 12500);
assert.equal(pickPrimary(parsePrices('Was 10,000 now 8,000')).value, 8000);
// real vendor captions (from screenshots): no "price" word, dot-thousands, plain commas, "#8000", "# 21,000"
assert.deepEqual(vals('laptop table with drawer,8.000'), ['8000:unspecified']);
assert.deepEqual(vals('Kenwood electric kettle 8,000'), ['8000:unspecified']);
assert.deepEqual(vals('Smp knife set  Ssk50 #8000'), ['8000:unspecified']);
assert.deepEqual(vals('Inflatable sofa with leg rest  # 21,000'), ['21000:unspecified']);
assert.deepEqual(vals('Samsung A54 5G 128GB 85000'), ['85000:unspecified']);
assert.deepEqual(vals('Hair dryer 12000'), ['12000:unspecified']);
assert.deepEqual(vals('3.5mm jack cable 2.500'), ['2500:unspecified']);
assert.deepEqual(vals('Size 42 pair'), []); assert.deepEqual(vals('Room 305 available'), []);
for (const c of ['laptop table with drawer,8.000', 'Kenwood electric kettle 8,000']) assert.notEqual(parsePrices(c)[0].confidence, 'low');   // not flagged for review
assert.equal(parsePrices('12.5k wholesale')[0].value, 12500);   // a one-digit decimal is still a decimal
assert.equal(clean('laptop table with drawer,8.000', { contactLine: '' }).text, 'laptop table with drawer,₦9,600');
ok('price parser: ₦/#/N/k, dot-thousands (8.000), plain "name + price" lines, model codes, sizes, quantities, units, years, %, phones, wholesale vs retail, old prices');

let r = clean('Brand new Nike Air Max 👟\nSize 40-45\nPrice: ₦25,000\nCall/WhatsApp 08012345678 to order');
assert.equal(r.text, 'Brand new Nike Air Max 👟\nSize 40-45\nPrice: ₦30,000\n\nOrder: 0901 111 2222');
assert.ok(!/0801|2345678/.test(r.text) && r.removed.phones === 1);
r = clean('₦12.5k wholesale\n₦15k retail\nChat wa.me/2348012345678');
assert.equal(r.text, '₦15,000\n\nOrder: 0901 111 2222');
r = clean('Fresh stock\nOrder @2348012345678 now\nFollow us on IG @gadgets_hub\nPrice 6500\nJoin our group https://chat.whatsapp.com/AbCdEf');
assert.equal(r.text, 'Fresh stock\nPrice ₦7,800\n\nOrder: 0901 111 2222');
r = clean('Ladies bags 8500 each, 6 pieces 45k\n📞 0803 456 7890');
assert.equal(r.text, 'Ladies bags ₦10,200 each, 6 pieces ₦54,000\n\nOrder: 0901 111 2222');
r = clean('Sneakers 12000\n*BEST SHOES NG* quality', { stripPhrases: ['best shoes ng'] });
assert.ok(!/best shoes/i.test(r.text) && r.text.includes('₦14,400'));
r = clean('Nice dress\nPrice 5000', { contactLine: '' });
assert.equal(r.text, 'Nice dress\nPrice ₦6,000');
r = clean('Was 10,000 now 8,000');
assert.ok(!/10,000|10000/.test(r.text) && /₦9,600/.test(r.text));
ok('caption cleaner: removes phones/links/handles/promo lines, replaces every price, drops retail & old prices, strips watermarks, adds your contact line');

assert.equal(resalePrice(12500, { ...DEFAULT_RULES, markupPercent: 20, roundingStep: 100 }), 15000);
assert.equal(resalePrice(12340, { ...DEFAULT_RULES, markupPercent: 15, roundingStep: 100 }), 14200);   // 14191 → up to 14200
assert.equal(resalePrice(12340, { ...DEFAULT_RULES, markupPercent: 15, roundingStep: 100, roundingMode: 'nearest' }), 14200);
assert.equal(resalePrice(5000, { ...DEFAULT_RULES, markupPercent: 2, minMargin: 500, roundingStep: 0 }), 5500);
assert.equal(resalePrice(3000, { ...DEFAULT_RULES, markupPercent: 0, fixedAdd: 250, roundingStep: 50 }), 3250);
const tiers = { ...DEFAULT_RULES, tiers: [{ upTo: 5000, markupPercent: 40 }, { upTo: 20000, markupPercent: 25 }, { upTo: null, markupPercent: 10 }], roundingStep: 0 };
assert.deepEqual([4000, 10000, 100000].map((c) => resalePrice(c, tiers)), [5600, 12500, 110000]);
assert.equal(formatMoney(15000, '₦'), '₦15,000'); assert.equal(formatMoney(12.5, '$'), '$12.50');
ok('pricing engine: percent, fixed add, minimum margin, tiers, rounding up/nearest, formatting');

// grouper: images then caption, a second product, interleaved vendors, album header, caps
const img = (sha, extra = {}) => ({ type: 'image', mimetype: 'image/jpeg', sha, mediaKey: '', directPath: '', url: '', fileEncSha256: '', fileLength: 1, ...extra });
const G = new AlbumGrouper({ quietMs: 20_000, burstMs: 8_000, albumGraceMs: 4_000, maxItems: 5, maxOpen: 2 });
const it = (id, at, text = '', media = null, extra = {}) => ({ id, at, text, media, quotedId: null, ...extra });
let closed = [];
closed.push(...G.add('c', 'v1', it('a', 0, '', img('A'))), ...G.add('c', 'v1', it('b', 3000, '', img('B'))), ...G.add('c', 'v1', it('c', 6000, 'Nike\nPrice 5k')));
closed.push(...G.add('c', 'v1', it('d', 26_000, 'Bag 8500', img('C'))));           // 20s later, product 1 already has media+caption → split
closed.push(...G.add('c', 'v2', it('e', 26_500, '', img('D'))));                   // another vendor interleaved
assert.equal(closed.length, 1); assert.equal(closed[0].reason, 'split');
assert.deepEqual(closed[0].media.map((m) => m.sha), ['A', 'B']); assert.equal(closed[0].caption, 'Nike\nPrice 5k');
const later = G.sweep(100_000);
assert.deepEqual(later.map((g) => [g.sender, g.media.length]).sort(), [['v1', 1], ['v2', 1]]);
// bulk forward: four captioned photos one second apart are FOUR products, not one
const GB = new AlbumGrouper({}); const bulk = [];
['Table 8.000', 'Kettle 8,000', 'Knife set #8000', 'Sofa # 21,000'].forEach((cap, n) => bulk.push(...GB.add('c', 'v', it(`b${n}`, n * 1000, cap, img(`B${n}`)))));
bulk.push(...GB.sweep(100_000));
assert.deepEqual(bulk.map((g) => [g.media.length, g.caption]), [[1, 'Table 8.000'], [1, 'Kettle 8,000'], [1, 'Knife set #8000'], [1, 'Sofa # 21,000']]);
// photo, caption text, photo, caption text (quick succession) → two products
const GP = new AlbumGrouper({}); const pairs = [];
pairs.push(...GP.add('c', 'v', it('p1', 0, '', img('P1'))), ...GP.add('c', 'v', it('p2', 800, 'Item one 5k')), ...GP.add('c', 'v', it('p3', 1600, '', img('P2'))), ...GP.add('c', 'v', it('p4', 2400, 'Item two 6k')));
pairs.push(...GP.sweep(100_000));
assert.deepEqual(pairs.map((g) => [g.media.length, g.caption]), [[1, 'Item one 5k'], [1, 'Item two 6k']]);
// the same caption on every photo of an album is ONE product
const GS = new AlbumGrouper({}); const same = [];
for (let n = 0; n < 3; n++) same.push(...GS.add('c', 'v', it(`s${n}`, n * 500, 'Sneakers 12k', img(`S${n}`))));
same.push(...GS.sweep(100_000));
assert.deepEqual(same.map((g) => g.media.length), [3]);
const G2 = new AlbumGrouper({ quietMs: 20_000, albumGraceMs: 4_000 });
G2.add('c', 'v', it('h', 0, '', null, { expected: 3 })); G2.add('c', 'v', it('i', 1000, '', img('X'))); G2.add('c', 'v', it('j', 1500, '', img('Y'))); G2.add('c', 'v', it('k', 2000, 'Shoes 9k', img('Z')));
assert.equal(G2.sweep(5000).length, 0); assert.equal(G2.sweep(6500).length, 1);   // album complete → closes after the 4s grace, not 20s
const G3 = new AlbumGrouper({ maxItems: 3 }); const full = [];
for (let n = 0; n < 3; n++) full.push(...G3.add('c', 'v', it(`m${n}`, n * 100, '', img(`S${n}`))));
assert.equal(full[0].reason, 'full');
const G4 = new AlbumGrouper({ maxOpen: 2 }); const ev = [];
for (const v of ['a', 'b', 'c']) ev.push(...G4.add('c', v, it(v, 0, 'x')));
assert.equal(ev.length, 1); assert.equal(ev[0].reason, 'evicted'); assert.equal(G4.size, 2);
ok('album grouper: photos+caption merge, back-to-back and bulk-forwarded products split (even 1s apart), same caption stays one product, vendors kept apart, album header closes early, size caps');

assert.equal(detectStockSignal('Sold out!'), 'soldout'); assert.equal(detectStockSignal('na finish o'), 'soldout');
assert.equal(detectStockSignal('Restocked, available again'), 'restock'); assert.equal(detectStockSignal('Brand new Nike Air Max, price 25k, available in all sizes and colours, call to order now now now please'), null);
const m1 = mediaOf({ imageMessage: { mimetype: 'image/png', fileSha256: new Uint8Array([1, 2, 3]), mediaKey: new Uint8Array([4]), directPath: '/d', url: 'u', fileLength: { toNumber: () => 99 }, width: 10, height: 20 } });
assert.equal(m1.sha, 'AQID'); assert.equal(m1.fileLength, 99); assert.equal(mediaOf({ conversation: 'hi' }), null);
assert.equal(albumExpected({ albumMessage: { expectedImageCount: 3, expectedVideoCount: 1 } }), 4);
ok('stock signals + media fingerprints (WhatsApp sha, no download)');

// ═══ B. ingestion through the router ═════════════════════════════════════════
function fakeSock(userId) {
  const em = new EventEmitter();
  const sock = { ev: { on: (e, f) => em.on(e, f), off: (e, f) => em.off(e, f), emit: (e, p) => em.emit(e, p), removeAllListeners: () => em.removeAllListeners() }, user: { id: userId }, sent: [],
    async sendMessage(jid, content, opts) { const key = { id: `OUT${sock.sent.length + 1}`, remoteJid: jid, fromMe: true }; sock.sent.push({ jid, content, opts, key }); return { key, message: content }; } };
  return sock;
}
let seq = 0;
const msg = ({ id, chat, text, from, fromMe = false, ts = Date.now(), extra }) => ({ key: { id: id ?? `M${++seq}`, remoteJid: chat, fromMe, participant: from }, message: extra ?? { conversation: text }, messageTimestamp: Math.floor(ts / 1000), pushName: 'V' });
const pic = (sha, caption) => ({ imageMessage: { mimetype: 'image/jpeg', fileSha256: Buffer.from(sha), mediaKey: Buffer.from('k'), directPath: `/p/${sha}`, url: `https://m/${sha}`, fileLength: 1000, ...(caption ? { caption } : {}) } });
const up = (sock, messages, type = 'notify') => sock.ev.emit('messages.upsert', { messages, type });
const rec = (id, number) => ({ id, number, status: 'active', plan: 't', expiresAt: null, createdAt: 0, sudo: [] });
const online = (tenant, sock) => { const c = new TenantContext(tenant); c.attach(sock); c.markOnline(); return c; };
const lastText = (s) => s.sent.at(-1)?.content?.text ?? '';
const recent = (s, re, n = 4) => s.sent.slice(-n).some((x) => re.test(x.content?.text ?? ''));   // the hint is followed at once by the re-prompt

const started = [], halted = [];
const fakeSessions = { start: async (t) => { started.push(t); return {}; }, stop: async () => {}, halt: async (id, st) => { halted.push([id, st]); }, get: () => undefined, list: () => [] };
const RES = '2348022222222', CTL = '2348012345678', VEND = '2349011111111', STRANGER = '2349022222222';
const VG = '120363111@g.us', OTHER = '120363999@g.us';
const rsock = fakeSock(`${RES}:3@s.whatsapp.net`);
const resCtx = online(rec('acme', RES), rsock);
const host = new PluginHost({ sessions: fakeSessions });
[corePlugin, menuPlugin, ingest.default].forEach((p) => host.register(p));
host.onSocket(resCtx, rsock); bs.registerPromptListener(rsock);
const ownChat = `${RES}@s.whatsapp.net`;
const vj = `${VEND}@s.whatsapp.net`;

await updateSettings(resCtx, { contactLine: 'Order: 0901 111 2222', markupPercent: 20, roundingStep: 100 });

up(rsock, [msg({ chat: VG, from: vj, extra: pic('A1') })]);                    // before the group is a source: must be ignored
await sleep(60);
assert.equal((await listProducts(resCtx)).length + (await ingest.sweep(resCtx, Date.now() + 120_000)).length, 0);
up(rsock, [msg({ chat: VG, fromMe: true, text: '.source add Shoe Plug' })]);
await must(() => rsock.sent.length >= 1);
assert.match(lastText(rsock), /Shoe Plug.*vendor source/); assert.equal(rsock.sent.at(-1).jid, ownChat);
assert.equal((await getVendor(resCtx, VG)).name, 'Shoe Plug');
ok('.source add (typed in the vendor group) registers it and answers privately; posts before that were ignored');

const T = Date.now() - 600_000;                                                  // vendor posts happened 10 minutes ago
up(rsock, [
  msg({ id: 'V1', chat: VG, from: vj, extra: pic('SHA-A'), ts: T }),
  msg({ id: 'V2', chat: VG, from: vj, extra: pic('SHA-B'), ts: T + 2000 }),
  msg({ id: 'V3', chat: VG, from: vj, text: 'Nike Air Max 👟\nSize 40-45\nPrice: ₦25,000\nCall/WhatsApp 08012345678', ts: T + 4000 }),
  msg({ id: 'V4', chat: VG, from: vj, extra: pic('SHA-C', 'Ladies bag 8500 each\n📞 0803 456 7890'), ts: T + 40_000 }),   // a second product, 36s later
  msg({ id: 'V5', chat: OTHER, from: vj, extra: pic('SHA-X', 'Not a vendor group ₦1,000'), ts: T }),                 // not a source
  msg({ id: 'V6', chat: VG, fromMe: true, extra: pic('SHA-ME', 'my own post ₦5,000'), ts: T }),                      // my own message
  msg({ id: 'V7', chat: `${VEND}@s.whatsapp.net`, from: vj, extra: pic('SHA-DM', 'dm ₦1,000'), ts: T }),             // a DM, not a group
]);
await sleep(150);
const res1 = await ingest.sweep(resCtx, Date.now());
const prods = (await listProducts(resCtx)).sort((a, b) => a.cost - b.cost);
assert.equal(prods.length, 2, `expected 2 products, got ${prods.length}`);
const [bag, shoe] = prods;
assert.equal(shoe.cost, 25000); assert.deepEqual(shoe.hashes.sort(), ['U0hBLUE='.length ? Buffer.from('SHA-A').toString('base64') : '', Buffer.from('SHA-B').toString('base64')].sort());
assert.equal(bag.cost, 8500); assert.equal(shoe.vendorName, 'Shoe Plug'); assert.equal(shoe.status, 'new'); assert.equal(shoe.needsReview, false);
assert.equal(shoe.media.length, 2); assert.equal(bag.media.length, 1);
ok('ingestion: 3 messages → 1 item with 2 photos + caption; the next product splits off; non-source groups, own posts and DMs are ignored');

// re-post of the same photo with a new price, then a sold-out reply that quotes the bag post
up(rsock, [msg({ id: 'V8', chat: VG, from: vj, extra: pic('SHA-A', 'Nike Air Max price 27,000'), ts: T + 100_000 })]);
await sleep(80); await ingest.sweep(resCtx, Date.now());
const shoe2 = await getProduct(resCtx, shoe.id);
assert.equal((await listProducts(resCtx)).length, 2); assert.equal(shoe2.reposts, 1); assert.equal(shoe2.cost, 27000); assert.equal(shoe2.priceHistory.length, 2);
up(rsock, [msg({ id: 'V9', chat: VG, from: vj, ts: T + 200_000, extra: { extendedTextMessage: { text: 'Sold out!', contextInfo: { stanzaId: 'V4' } } } })]);
await sleep(80); await ingest.sweep(resCtx, Date.now());
assert.equal((await getProduct(resCtx, bag.id)).status, 'soldout');
up(rsock, [msg({ id: 'V10', chat: VG, from: vj, ts: T + 300_000, text: 'sold out' })]);   // no quote: can't tell which item, so nothing changes
await sleep(80); await ingest.sweep(resCtx, Date.now());
assert.equal((await countByStatus(resCtx)).soldout, 1);
ok('re-posts update the existing item (new price recorded); a quoted "sold out" marks the right item; an unquoted one is ignored');

// what the reseller's customers would see
const view = renderProduct(await getProduct(resCtx, shoe.id), await getSettings(resCtx), await getVendor(resCtx, VG));
assert.equal(view.price, 32400); assert.match(view.caption, /₦32,400/); assert.ok(!/0801|27,000|27000/.test(view.caption)); assert.match(view.caption, /Order: 0901 111 2222$/);
await updateSettings(resCtx, { markupPercent: 10 });
assert.equal(renderProduct(await getProduct(resCtx, shoe.id), await getSettings(resCtx), await getVendor(resCtx, VG)).price, 29700);
await updateSettings(resCtx, { markupPercent: 20 });
ok('rendering uses your CURRENT settings: change markup and every unposted item follows');

// catalog housekeeping
const removed = await pruneCatalog(resCtx, 0, 1000);                          // everything is older than "now"
assert.equal(removed, 2); assert.equal((await listProducts(resCtx)).length, 0);
ok('catalog prune removes old items and their index entries');

// re-ingest two products for the dashboard run
up(rsock, [msg({ id: 'W1', chat: VG, from: vj, extra: pic('SHA-N1', 'Nike Air Max\nPrice ₦25,000\nCall 08012345678'), ts: T }), msg({ id: 'W2', chat: VG, from: vj, extra: pic('SHA-N2', 'Mystery item no price here'), ts: T + 60_000 })]);
await sleep(80); await ingest.sweep(resCtx, Date.now());

// ═══ C. the reseller dashboard, end to end (numbered, in the own chat) ═══════
const say = (t, chat = ownChat) => up(rsock, [msg({ chat, fromMe: true, text: t })]);
const n0 = rsock.sent.length;
say('.menu', VG);                                                                // typed in a group → opens in the own chat
await must(() => rsock.sent.length > n0);
assert.equal(rsock.sent[n0].jid, ownChat); assert.match(lastText(rsock), /New items: 2/);
say('1');                                                                        // 📦 Items
await must(() => /New items/.test(lastText(rsock)) && /waiting/.test(lastText(rsock)));
assert.match(lastText(rsock), /₦25,000 → ₦30,000/); assert.match(lastText(rsock), /no price found/);
say('2');                                                                        // second listed (newest first): the item with no price? order = newest first
await must(() => /What your customers will see/.test(lastText(rsock)));
const itemText = lastText(rsock);
const isShoe = /₦30,000/.test(itemText);
ok('dashboard: .menu typed in a group opens in the own chat; Items lists "vendor price → your price" and flags items with no price');

// work on whichever item we landed on: set own price, approve
say('2');                                                                        // 💰 Set my own price
await must(() => /selling price for this item/.test(lastText(rsock)));
say('abc'); await must(() => recent(rsock, /Send a number between/));
say('18,500'); await must(() => /Price set/.test(lastText(rsock)));
const withPrice = (await listProducts(resCtx, { status: 'new' })).find((p) => p.manualPrice === 18500);
assert.ok(withPrice); assert.match(lastText(rsock), /18,500/);
say('1');                                                                        // ✅ Approve
await must(() => /Approved/.test(lastText(rsock)));
assert.equal((await getProduct(resCtx, withPrice.id)).status, 'approved');
say('0'); await sleep(40);
ok('dashboard: bad price re-asked, own price saved (₦18,500), item approved');

// vendors + settings through the menu
await sleep(1100);
say('.menu'); await must(() => /New items: 1/.test(lastText(rsock)));
say('4'); await must(() => /Vendor groups/.test(lastText(rsock)) && /Shoe Plug/.test(lastText(rsock)));
say('1'); await must(() => /importing/.test(lastText(rsock)));
say('1'); await must(() => /Markup % for this vendor/.test(lastText(rsock)));
say('35'); await must(() => /Markup for this vendor: 35%/.test(lastText(rsock)));
assert.equal((await getVendor(resCtx, VG)).markupPercent, 35);
say('3'); await must(() => /exact text to remove/.test(lastText(rsock)));
say('BEST SHOES NG'); await must(() => /remove that text/i.test(lastText(rsock)));
assert.deepEqual((await getVendor(resCtx, VG)).stripPhrases, ['BEST SHOES NG']);
say('0'); await sleep(40);
ok('dashboard: per-vendor markup and watermark text saved');

// ═══ C2. bulk-forwarded items like the real vendor screenshots ═══════════════
const VG2 = '120363222@g.us'; const { addVendor } = await import('../dist/core/vendors.js');
await addVendor(resCtx, VG2, 'Home & Kitchen Vendor');
const T2 = Date.now() - 400_000;
const fwd = (sha, caption) => ({ imageMessage: { mimetype: 'image/jpeg', fileSha256: Buffer.from(sha), mediaKey: Buffer.from('k'), directPath: `/p/${sha}`, url: `https://m/${sha}`, fileLength: 1000, caption, contextInfo: { isForwarded: true, forwardingScore: 1 } } });
const shots = [['laptop table with drawer,8.000', 8000], ['Kenwood electric kettle 8,000', 8000], ['Smp knife set  Ssk50 #8000', 8000], ['Inflatable sofa with leg rest  # 21,000', 21000]];
up(rsock, shots.map(([cap], n) => msg({ id: `F${n}`, chat: VG2, from: vj, extra: fwd(`SHA-F${n}`, cap), ts: T2 + n * 1000 })));
await sleep(80); await ingest.sweep(resCtx, Date.now());
const forwarded = (await listProducts(resCtx)).filter((p) => p.vendorChatId === VG2).sort((a, b) => a.rawCaption.localeCompare(b.rawCaption));
assert.equal(forwarded.length, 4, `expected 4 separate products, got ${forwarded.length}`);
assert.deepEqual(forwarded.map((p) => p.cost).sort((a, b) => a - b), [8000, 8000, 8000, 21000]);
assert.ok(forwarded.every((p) => p.media.length === 1 && !p.needsReview));
const sofa = forwarded.find((p) => /sofa/i.test(p.rawCaption));
assert.match(renderProduct(sofa, await getSettings(resCtx), await getVendor(resCtx, VG2)).caption, /^Inflatable sofa with leg rest ₦25,200\n\nOrder: 0901 111 2222$/);
ok('real vendor posts: four forwarded photos in one second → four items (₦8,000 ×3, ₦21,000), none flagged for review; sofa previews at ₦25,200');

// ═══ D. the admin menu, end to end ═══════════════════════════════════════════
await createTenant({ id: 'alpha', number: '2347011111111' }); await createTenant({ id: 'beta', number: '2347022222222' });
await createTenant({ id: 'ctl', number: CTL }); await sleep(5);
const asock = fakeSock(`${CTL}:5@s.whatsapp.net`);
const actl = online(rec('ctl', CTL), asock);
const h2 = new PluginHost({ sessions: { ...fakeSessions, list: () => [actl], get: (id) => (id === 'ctl' ? actl : undefined) } });
[corePlugin, adminPlugin].forEach((p) => h2.register(p));
h2.onSocket(actl, asock); bs.registerPromptListener(asock);
const ctlChat = `${CTL}@s.whatsapp.net`;
const sayA = (t, chat = ctlChat) => up(asock, [msg({ chat, fromMe: true, text: t })]);

sayA('.admin', VG);                                                              // typed inside a group
await must(() => asock.sent.length >= 1);
assert.equal(asock.sent[0].jid, ctlChat); assert.match(lastText(asock), /Admin/); assert.ok(!asock.sent.some((x) => x.jid === VG));
sayA('1'); await must(() => /Customers/.test(lastText(asock)) && /beta/.test(lastText(asock)));
assert.match(lastText(asock), /1️⃣  \*alpha · pending\*/); assert.match(lastText(asock), /2️⃣  \*beta · pending\*/);
sayA('2'); await must(() => /Number: 2347022222222/.test(lastText(asock)));
assert.match(lastText(asock), /Start \/ resume/);
sayA('1'); await must(() => /Started/.test(lastText(asock)));
assert.equal(started.at(-1).id, 'beta'); assert.equal((await getTenant('beta')).status, 'active');
sayA('1'); await must(() => /Paused/.test(lastText(asock)));                  // now active → option 1 is Pause
assert.deepEqual(halted.at(-1), ['beta', 'paused']);
sayA('0'); await sleep(40);
ok('admin menu: opens in your own chat even from a group; customers list, customer detail, start and pause work');

await sleep(600);
const nA = asock.sent.length;
sayA('.admin'); await must(() => asock.sent.length > nA);
sayA('2'); await must(() => /Customer id/.test(lastText(asock)));            // ➕ Add customer
sayA('Bad Id!'); await must(() => recent(asock, /lowercase letters or digits, no spaces/));
sayA('gamma'); await must(() => /WhatsApp number/.test(lastText(asock)));
sayA('2347033333333'); await must(() => /Business name/.test(lastText(asock)));
sayA('Gamma Gadgets'); await must(() => /Trial days/.test(lastText(asock)));
sayA('14'); await must(() => /Added \*gamma\*/.test(lastText(asock)));
const gamma = await getTenant('gamma');
assert.equal(gamma.number, '2347033333333'); assert.equal(gamma.label, 'Gamma Gadgets'); assert.equal(started.at(-1).id, 'gamma');
assert.ok(Math.abs(gamma.expiresAt - (Date.now() + 14 * 86_400_000)) < 60_000);
sayA('0'); await sleep(40);
ok('admin menu: add-customer flow (validates the id, number, name, trial days) creates the tenant and starts its session');

console.log(`\n${passed} stage-3 checks passed`);
process.exit(0);
