import { createStore } from './pluginStore.js';
const TENANT_ID = /^[a-z0-9]{2,24}$/;
export function assertTenantId(id) {
    if (!TENANT_ID.test(id)) {
        throw new Error(`invalid tenant id "${id}": use 2-24 lowercase letters/digits`);
    }
}
/**
 * Returns a store whose tables belong to one tenant only (t_<tenant>_<namespace>).
 *
 * Isolation comes from the table name, so the existing adapters (Mongo, Postgres,
 * MySQL, SQLite, JSON files) work unchanged, and `getAll()` only ever returns
 * that tenant's rows. Namespace rules are the same as createStore().
 */
export function tenantStore(tenantId, namespace) {
    assertTenantId(tenantId);
    return createStore(`t_${tenantId}_${namespace}`);
}
