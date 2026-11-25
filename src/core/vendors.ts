import { TtlCache } from './ttlCache.js';
import type { TenantContext } from './tenantContext.js';

/** A wholesale vendor's WhatsApp group that the reseller pulls items from. */
export interface VendorSource {
  chatId: string;
  name: string;
  /** Overrides the reseller's default markup for this vendor (null = use the default). */
  markupPercent: number | null;
  enabled: boolean;
  addedAt: number;
  /** Watermarks / slogans to strip from this vendor's captions. */
  stripPhrases: string[];
}

// Read on every group message, so keep a short per-tenant cache in front of the store.
const caches = new WeakMap<TenantContext, TtlCache<VendorSource | null>>();
const cacheOf = (ctx: TenantContext) => {
  let c = caches.get(ctx);
  if (!c) caches.set(ctx, (c = new TtlCache<VendorSource | null>(30_000, 500)));
  return c;
};

const store = (ctx: TenantContext) => ctx.store('vendors');

export async function getVendor(ctx: TenantContext, chatId: string): Promise<VendorSource | null> {
  const cache = cacheOf(ctx);
  const hit = cache.get(chatId);
  if (hit !== undefined) return hit;
  const v = ((await store(ctx).get(chatId)) as VendorSource | null) ?? null;
  cache.set(chatId, v);
  return v;
}

export async function listVendors(ctx: TenantContext): Promise<VendorSource[]> {
  const all = await store(ctx).getAll();
  return (Object.values(all) as VendorSource[]).sort((a, b) => a.name.localeCompare(b.name));
}

export async function saveVendor(ctx: TenantContext, v: VendorSource): Promise<void> {
  await store(ctx).set(v.chatId, v);
  cacheOf(ctx).delete(v.chatId);
}

export async function addVendor(ctx: TenantContext, chatId: string, name: string): Promise<VendorSource> {
  const existing = await getVendor(ctx, chatId);
  if (existing) {
    const updated = { ...existing, name: name || existing.name, enabled: true };
    await saveVendor(ctx, updated);
    return updated;
  }
  const v: VendorSource = { chatId, name: name || chatId, markupPercent: null, enabled: true, addedAt: Date.now(), stripPhrases: [] };
  await saveVendor(ctx, v);
  return v;
}

export async function removeVendor(ctx: TenantContext, chatId: string): Promise<boolean> {
  const had = await store(ctx).has(chatId);
  await store(ctx).del(chatId);
  cacheOf(ctx).delete(chatId);
  return had;
}
