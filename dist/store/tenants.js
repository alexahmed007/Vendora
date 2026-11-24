import { createStore } from './pluginStore.js';
import { assertTenantId } from './tenantStore.js';
const registry = createStore('core').table('tenants');
export const digits = (value) => (value || '').replace(/\D/g, '');
export function isRunnable(t, now = Date.now()) {
    if (t.status !== 'active' && t.status !== 'pending')
        return false;
    return t.expiresAt === null || t.expiresAt > now;
}
export async function listTenants() {
    const all = await registry.getAll();
    return Object.values(all);
}
export async function getTenant(id) {
    return (await registry.get(id));
}
export async function createTenant(input) {
    assertTenantId(input.id);
    const number = digits(input.number);
    if (number.length < 8 || number.length > 15)
        throw new Error('number must be 8-15 digits, country code first');
    if (await getTenant(input.id))
        throw new Error(`tenant "${input.id}" already exists`);
    const record = {
        id: input.id,
        number,
        label: input.label,
        status: 'pending',
        plan: input.plan ?? 'trial',
        expiresAt: input.expiresAt ?? null,
        createdAt: Date.now(),
        sudo: [],
    };
    await registry.set(record.id, record);
    return record;
}
export async function patchTenant(id, patch) {
    await registry.patch(id, patch);
}
