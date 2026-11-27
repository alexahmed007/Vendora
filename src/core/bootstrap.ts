import { config } from '../config.js';
import { createTenant, getTenant, listTenants, type TenantRecord } from '../store/tenants.js';

/**
 * Make sure the platform admin's own account exists as the "control" tenant, so setting
 * ADMIN_NUMBER is enough on a brand-new database (no CLI step). Safe to run on every boot:
 *  - already there (matched by number)  -> nothing changes
 *  - missing                            -> created as "control", status pending (a pairing code is printed)
 *  - an id "control" exists with another number -> left alone and reported, never overwritten
 */
export async function ensureControlTenant(adminNumber: string = config.adminNumber): Promise<TenantRecord | null> {
  if (!adminNumber) return null;

  const existing = (await listTenants()).find((t) => t.number === adminNumber);
  if (existing) return existing;

  if (await getTenant('control')) {
    console.error(
      `[bootstrap] ADMIN_NUMBER is ${adminNumber}, but a tenant called "control" already exists with a different number. ` +
        'Fix ADMIN_NUMBER, or change that tenant, then restart. Not creating anything.',
    );
    return null;
  }

  const created = await createTenant({ id: 'control', number: adminNumber, label: 'Control (admin)', plan: 'admin' });
  console.log(`[bootstrap] created the control tenant for ADMIN_NUMBER (${adminNumber}); a pairing code will print next`);
  return created;
}

/** Start the admin's own session first: every other customer's pairing code and notices are delivered through it. */
export function controlFirst<T extends { number: string }>(tenants: T[], adminNumber: string = config.adminNumber): T[] {
  return [...tenants].sort((a, b) => Number(b.number === adminNumber) - Number(a.number === adminNumber));
}
