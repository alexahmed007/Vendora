import type { PriceMatch } from '../lib/priceParser.js';
import type { MediaDescriptor } from '../lib/mediaInfo.js';
import type { TenantContext } from './tenantContext.js';

export type ProductStatus = 'new' | 'approved' | 'queued' | 'posted' | 'soldout' | 'ignored';

/** One vendor item: its photos/videos (as descriptors, never bytes), caption and parsed price. */
export interface Product {
  id: string;
  vendorChatId: string;
  vendorName: string;
  /** Digits of the vendor member who posted it. */
  sender: string;
  createdAt: number;
  updatedAt: number;
  status: ProductStatus;
  media: MediaDescriptor[];
  /** Media fingerprints (WhatsApp's SHA-256), used to recognise re-posts. */
  hashes: string[];
  rawCaption: string;
  parsed: PriceMatch[];
  /** The vendor's cost for this item (null if no price could be read). */
  cost: number | null;
  /** Reseller override of the selling price. */
  manualPrice: number | null;
  /** True when the price is missing, low-confidence, or the post was ambiguous. */
  needsReview: boolean;
  reposts: number;
  priceHistory: Array<{ at: number; cost: number }>;
  /** Vendor message ids that made up this item (used to match "sold out" replies). */
  sourceMessageIds: string[];
  /** When every target finished (set when status becomes 'posted'). */
  postedAt?: number | null;
  /** Why the last attempt failed, if it did. */
  postError?: string | null;
}

const catalog = (ctx: TenantContext) => ctx.store('catalog');
const mediaIndex = (ctx: TenantContext) => ctx.store('media_index');
const msgIndex = (ctx: TenantContext) => ctx.store('msg_index');

export const newProductId = (): string => `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export async function saveProduct(ctx: TenantContext, p: Product): Promise<void> {
  p.updatedAt = Date.now();
  await catalog(ctx).set(p.id, p);
}

export async function getProduct(ctx: TenantContext, id: string): Promise<Product | null> {
  return ((await catalog(ctx).get(id)) as Product | null) ?? null;
}

export async function listProducts(ctx: TenantContext, opts: { status?: ProductStatus } = {}): Promise<Product[]> {
  const all = Object.values(await catalog(ctx).getAll()) as Product[];
  return all.filter((p) => !opts.status || p.status === opts.status).sort((a, b) => b.createdAt - a.createdAt);
}

export async function countByStatus(ctx: TenantContext): Promise<Record<ProductStatus, number>> {
  const counts: Record<ProductStatus, number> = { new: 0, approved: 0, queued: 0, posted: 0, soldout: 0, ignored: 0 };
  for (const p of Object.values(await catalog(ctx).getAll()) as Product[]) counts[p.status]++;
  return counts;
}

/** Register a product's fingerprints and source message ids so re-posts and replies can find it. */
export async function indexProduct(ctx: TenantContext, p: Product): Promise<void> {
  await Promise.all([
    ...p.hashes.filter(Boolean).map((h) => mediaIndex(ctx).set(h, p.id)),
    ...p.sourceMessageIds.map((m) => msgIndex(ctx).set(m, p.id)),
  ]);
}

/** The id of an existing product that shares any media fingerprint, if there is one. */
export async function findByHashes(ctx: TenantContext, hashes: string[]): Promise<string | null> {
  for (const h of hashes.filter(Boolean)) {
    const id = (await mediaIndex(ctx).get(h)) as string | null;
    if (id) return id;
  }
  return null;
}

export async function findByMessage(ctx: TenantContext, messageId: string): Promise<string | null> {
  return ((await msgIndex(ctx).get(messageId)) as string | null) ?? null;
}

/** Keep the catalog bounded: drop old items and anything beyond the newest `maxItems`. Returns how many were removed. */
export async function pruneCatalog(ctx: TenantContext, maxAgeMs: number, maxItems: number): Promise<number> {
  const all = (Object.values(await catalog(ctx).getAll()) as Product[]).sort((a, b) => b.createdAt - a.createdAt);
  const cutoff = Date.now() - maxAgeMs;
  const doomed = all.filter((p, i) => p.createdAt < cutoff || i >= maxItems);
  for (const p of doomed) {
    await catalog(ctx).del(p.id);
    await Promise.all([
      ...p.hashes.filter(Boolean).map((h) => mediaIndex(ctx).del(h)),
      ...p.sourceMessageIds.map((m) => msgIndex(ctx).del(m)),
    ]);
  }
  return doomed.length;
}
