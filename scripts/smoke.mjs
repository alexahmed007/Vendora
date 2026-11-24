import assert from 'node:assert/strict';
// Safety: this test creates and deletes tenants. Never run it against a real database.
for (const v of ['MONGO_URL', 'POSTGRES_URL', 'MYSQL_URL', 'DB_URL']) {
  if (process.env[v]) { console.error(`Refusing to run: ${v} is set. Unset all database env vars (smoke uses local JSON files in ./data).`); process.exit(1); }
}

import { createTenant, listTenants, patchTenant, getTenant } from '../dist/store/tenants.js';
import { tenantStore } from '../dist/store/tenantStore.js';
import { getAdapter } from '../dist/store/pluginStore.js';
import { useStoreAuthState } from '../dist/core/dbAuthState.js';
import { TenantContext } from '../dist/core/tenantContext.js';
import { TtlCache } from '../dist/core/ttlCache.js';

let passed = 0;
const ok = (name) => { passed++; console.log('  ✓', name); };

// 1. registry
await createTenant({ id: 'alpha', number: '+234 801 234 5678', label: 'Alpha' });
await createTenant({ id: 'beta', number: '2348099999999' });
await assert.rejects(createTenant({ id: 'alpha', number: '2348011111111' }), /already exists/);
await assert.rejects(createTenant({ id: 'Bad_ID', number: '2348011111111' }), /invalid tenant id/);
await patchTenant('beta', { status: 'active' });
const all = await listTenants();
assert.equal(all.length, 2);
assert.equal((await getTenant('alpha')).number, '2348012345678');
ok('tenant registry: create / reject duplicates & bad ids / patch / digits-only number');

// 2. isolation
await tenantStore('alpha', 'catalog').set('p1', { name: 'alpha shoe' });
await tenantStore('beta', 'catalog').set('p1', { name: 'beta bag' });
assert.deepEqual(await tenantStore('alpha', 'catalog').get('p1'), { name: 'alpha shoe' });
assert.deepEqual(Object.keys(await tenantStore('beta', 'catalog').getAll()), ['p1']);
assert.equal((await tenantStore('beta', 'catalog').get('p1')).name, 'beta bag');
ok('tenant stores are isolated (same key, same namespace, different tenants)');

// 3. lock still serialises after the leak patch
const counter = tenantStore('alpha', 'counters');
await Promise.all(Array.from({ length: 50 }, () => counter.mutate('n', (c) => (c ?? 0) + 1)));
assert.equal(await counter.get('n'), 50);
ok('mutate(): 50 concurrent increments → exactly 50 (lock intact)');

// 4. auth state round-trips Buffers
const a1 = await useStoreAuthState('alpha');
const noise = Buffer.from(a1.state.creds.noiseKey.private);
await a1.saveCreds();
await a1.state.keys.set({ 'pre-key': { '7': { private: Buffer.from([1, 2, 3]), public: Buffer.from([4, 5, 6]) } } });
const a2 = await useStoreAuthState('alpha');
assert.ok(Buffer.from(a2.state.creds.noiseKey.private).equals(noise));
const got = await a2.state.keys.get('pre-key', ['7', '8']);
assert.ok(Buffer.from(got['7'].private).equals(Buffer.from([1, 2, 3])));
assert.equal(got['8'], null);
await a2.state.keys.set({ 'pre-key': { '7': null } });
assert.equal((await a2.state.keys.get('pre-key', ['7']))['7'], null);
ok('auth state: creds + signal keys survive a save/reload with Buffers; null deletes');

// 5. auth state is isolated per tenant
const b1 = await useStoreAuthState('beta');
assert.ok(!Buffer.from(b1.state.creds.noiseKey.private).equals(noise));
ok('auth state: tenants get independent credentials');

// 6. a failed DB read must never mint fresh credentials, and must not overwrite data
const adapter = await getAdapter();
const realGet = adapter.get;
adapter.get = async () => { throw new Error('db down'); };
await assert.rejects(useStoreAuthState('alpha'), /db down/);
await assert.rejects(tenantStore('alpha', 'counters').mutate('n', (c) => (c ?? 0) + 1000), /db down/);
await assert.rejects(tenantStore('alpha', 'counters').patch('x', { a: 1 }), /db down/);
adapter.get = realGet;
assert.equal(await tenantStore('alpha', 'counters').get('n'), 50);
ok('DB read failure: auth state & mutate()/patch() throw instead of overwriting real data');

// 7. wipe on logout
await a2.clear();
const a3 = await useStoreAuthState('alpha');
assert.ok(!Buffer.from(a3.state.creds.noiseKey.private).equals(noise));
ok('clear(): wipes a tenant’s keys (fresh creds afterwards)');

// 8. per-tenant message dedupe
const A = new TenantContext(await getTenant('alpha'));
const B = new TenantContext(await getTenant('beta'));
assert.equal(A.firstSight('MSG1'), true);
assert.equal(B.firstSight('MSG1'), true);   // same vendor-group message, second reseller: must NOT be dropped
assert.equal(A.firstSight('MSG1'), false);
ok('dedupe: two tenants seeing the same vendor message both process it; repeats are dropped');

// 9. owner check + live-socket getter
assert.equal(A.isOwnerJid('2348012345678:12@s.whatsapp.net'), true);
assert.equal(A.isOwnerJid('2348099999999@s.whatsapp.net'), false);
assert.throws(() => A.getSock(), /offline/);
const fake1 = { id: 1 }, fake2 = { id: 2 };
A.attach(fake1); A.markOnline(); assert.equal(A.getSock(), fake1);
A.attach(fake2); A.markOnline(); assert.equal(A.getSock(), fake2);   // after "reconnect" callers get the NEW socket
ok('context: owner matching ignores device suffix; getSock() always returns the live socket');

// 10. bounded cache
const c = new TtlCache(60_000, 3);
['a', 'b', 'c', 'd'].forEach((k) => c.set(k, 1));
assert.equal(c.size, 3); assert.equal(c.get('a'), undefined); assert.equal(c.get('d'), 1);
ok('TtlCache: hard size cap evicts oldest');

console.log(`\n${passed}/10 checks passed`);
process.exit(0);
