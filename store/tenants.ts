import { createStore } from './pluginStore.js';
import { assertTenantId } from './tenantStore.js';

export type TenantStatus = 'pending' | 'active' | 'paused' | 'needs_relink' | 'expired';

export interface TenantRecord {
  id: string;
  /** The reseller's WhatsApp number, digits only (country code, no +). */
  number: string;
  label?: string;
  status: TenantStatus;
  plan: string;
  /** Epoch ms, or null for no expiry. */
  expiresAt: number | null;
  createdAt: number;
  /** Extra numbers (digits only) allowed to run owner commands. */
  sudo: string[];
}

const registry = createStore('core').table!('tenants');

export const digits = (value: string): string => (value || '').replace(/\D/g, '');

export function isRunnable(t: TenantRecord, now = Date.now()): boolean {
  if (t.status !== 'active' && t.status !== 'pending') return false;
  return t.expiresAt === null || t.expiresAt > now;
}

export async function listTenants(): Promise<TenantRecord[]> {
  const all = await registry.getAll();
  return Object.values(all) as TenantRecord[];
}

export async function getTenant(id: string): Promise<TenantRecord | null> {
  return (await registry.get(id)) as TenantRecord | null;
}

export async function createTenant(input: {
  id: string;
  number: string;
  label?: string;
  plan?: string;
  expiresAt?: number | null;
}): Promise<TenantRecord> {
  assertTenantId(input.id);
  const number = digits(input.number);
  if (number.length < 8 || number.length > 15) throw new Error('number must be 8-15 digits, country code first');
  if (await getTenant(input.id)) throw new Error(`tenant "${input.id}" already exists`);

  const record: TenantRecord = {
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

export async function patchTenant(id: string, patch: Partial<TenantRecord>): Promise<void> {
  await registry.patch(id, patch as Record<string, any>);
}
