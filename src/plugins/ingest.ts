import { config } from '../config.js';
import {
  findByHashes, findByMessage, getProduct, indexProduct, newProductId, pruneCatalog, saveProduct, type Product,
} from '../core/catalog.js';
import { definePlugin } from '../core/plugin.js';
import type { TenantContext } from '../core/tenantContext.js';
import { addVendor, getVendor, listVendors, removeVendor } from '../core/vendors.js';
import { AlbumGrouper, type GroupItem, type ItemGroup } from '../lib/albumGrouper.js';
import { albumExpected, mediaOf } from '../lib/mediaInfo.js';
import { parsePrices, pickPrimary } from '../lib/priceParser.js';
import { detectStockSignal } from '../lib/stockSignals.js';

/**
 * Turns vendor-group posts into catalog items: groups photos + caption per product, reads the
 * price, recognises re-posts and "sold out" replies. It never posts anything itself.
 */

export type IngestResult =
  | { kind: 'created'; productId: string }
  | { kind: 'repost'; productId: string; priceChanged: boolean }
  | { kind: 'stock'; productId: string; signal: 'soldout' | 'restock' }
  | { kind: 'ignored' };

const groupers = new WeakMap<TenantContext, AlbumGrouper>();
export function grouperFor(ctx: TenantContext): AlbumGrouper {
  let g = groupers.get(ctx);
  if (!g) groupers.set(ctx, (g = new AlbumGrouper({ quietMs: config.albumQuietMs, burstMs: config.albumBurstMs })));
  return g;
}

/** Turn one closed group into a product, a re-post update, or a stock update. */
export async function processGroup(ctx: TenantContext, g: ItemGroup): Promise<IngestResult> {
  const vendor = await getVendor(ctx, g.chatId);
  if (!vendor || !vendor.enabled) return { kind: 'ignored' };

  // Text only: a "sold out" / "restocked" reply to an earlier post.
  if (g.media.length === 0) {
    const signal = detectStockSignal(g.caption);
    if (!signal || !g.quotedId) return { kind: 'ignored' };
    const id = await findByMessage(ctx, g.quotedId);
    const product = id ? await getProduct(ctx, id) : null;
    if (!product) return { kind: 'ignored' };
    if (signal === 'soldout') product.status = 'soldout';
    else if (product.status === 'soldout') product.status = 'new';
    await saveProduct(ctx, product);
    return { kind: 'stock', productId: product.id, signal };
  }

  const parsed = parsePrices(g.caption);
  const primary = pickPrimary(parsed);
  const hashes = [...new Set(g.media.map((m) => m.sha).filter(Boolean))];
  const messageIds = g.items.map((i) => i.id);

  // The same photo again: update the existing item instead of creating a duplicate.
  const dupId = await findByHashes(ctx, hashes);
  const existing = dupId ? await getProduct(ctx, dupId) : null;
  if (existing) {
    existing.reposts++;
    existing.sourceMessageIds.push(...messageIds);
    let priceChanged = false;
    if (primary && primary.value !== existing.cost) {
      priceChanged = existing.cost !== null;
      existing.priceHistory.push({ at: Date.now(), cost: primary.value });
      existing.cost = primary.value;
      existing.parsed = parsed;
      existing.rawCaption = g.caption || existing.rawCaption;
      existing.needsReview = primary.confidence === 'low';
    }
    if (existing.status === 'soldout') existing.status = 'new'; // vendor is selling it again
    await saveProduct(ctx, existing);
    await indexProduct(ctx, existing);
    return { kind: 'repost', productId: existing.id, priceChanged };
  }

  const now = Date.now();
  const product: Product = {
    id: newProductId(),
    vendorChatId: g.chatId,
    vendorName: vendor.name,
    sender: g.sender,
    createdAt: now,
    updatedAt: now,
    status: 'new',
    media: g.media,
    hashes,
    rawCaption: g.caption,
    parsed,
    cost: primary?.value ?? null,
    manualPrice: null,
    needsReview: !primary || primary.confidence === 'low',
    reposts: 0,
    priceHistory: primary ? [{ at: now, cost: primary.value }] : [],
    sourceMessageIds: messageIds,
  };
  await saveProduct(ctx, product);
  await indexProduct(ctx, product);
  return { kind: 'created', productId: product.id };
}

/** Close and process every group that has gone quiet. Exported so tests (and shutdown) can drive it. */
export async function sweep(ctx: TenantContext, now = Date.now()): Promise<IngestResult[]> {
  const results: IngestResult[] = [];
  for (const g of grouperFor(ctx).sweep(now)) {
    results.push(await processGroup(ctx, g).catch((e) => { ctx.log.error(`ingest: ${(e as Error).message}`); return { kind: 'ignored' } as IngestResult; }));
  }
  return results;
}

export default definePlugin({
  name: 'ingest',
  priority: 20,

  async onMessage(m) {
    if (!m.isGroup || m.fromMe || m.isStatus) return;
    const vendor = await getVendor(m.ctx, m.chatId);
    if (!vendor?.enabled) return;

    const media = mediaOf(m.content);
    const expected = albumExpected(m.content);
    if (!media && !m.text && !expected) return; // stickers, audio, reactions...

    const item: GroupItem = { id: m.id, at: m.timestamp, text: m.text, media, quotedId: m.quotedId, expected: expected ?? undefined };
    for (const g of grouperFor(m.ctx).add(m.chatId, m.userId, item)) {
      await processGroup(m.ctx, g).catch((e) => m.ctx.log.error(`ingest: ${(e as Error).message}`));
    }
    // Never consume: later hooks may still look at the message.
  },

  onTenantStop(ctx) {
    // Don't lose half-collected items when a session stops.
    for (const g of grouperFor(ctx).flushAll()) void processGroup(ctx, g).catch(() => undefined);
  },

  schedules: [
    { name: 'sweep', everyMs: 5_000, run: async (ctx) => void (await sweep(ctx)) },
    { name: 'prune', everyMs: 6 * 60 * 60_000, runWhenOffline: true, run: async (ctx) => void (await pruneCatalog(ctx, config.catalogMaxAgeMs, config.catalogMaxItems)) },
  ],

  commands: [
    {
      name: 'source',
      description: 'Vendor groups: .source add | remove | list',
      cooldownMs: 1_500,
      run: async (c) => {
        const [sub = 'list', ...rest] = c.args;
        switch (sub.toLowerCase()) {
          case 'add': {
            if (!c.isGroup) return void (await c.replyPrivate('Type *.source add* inside the vendor’s group.'));
            let name = rest.join(' ').trim();
            if (!name) {
              try { name = (await c.ctx.groupMetadata(c.chatId))?.subject ?? ''; } catch { /* use the id */ }
            }
            const v = await addVendor(c.ctx, c.chatId, name);
            await c.replyPrivate(`✅ *${v.name}* is now a vendor source. New posts there will appear under Items in your dashboard (.menu).`);
            return;
          }
          case 'remove':
          case 'rm':
          case 'delete': {
            if (!c.isGroup) return void (await c.replyPrivate('Type *.source remove* inside the vendor’s group, or remove it from .menu → Vendor groups.'));
            const had = await removeVendor(c.ctx, c.chatId);
            await c.replyPrivate(had ? '🗑️ This group is no longer a vendor source.' : 'This group wasn’t a vendor source.');
            return;
          }
          default: {
            const all = await listVendors(c.ctx);
            await c.replyPrivate(
              all.length
                ? `*Vendor groups*\n${all.map((v) => `• ${v.name}${v.enabled ? '' : ' (off)'}${v.markupPercent !== null ? ` · markup ${v.markupPercent}%` : ''}`).join('\n')}`
                : 'No vendor groups yet. Open a vendor’s group and type *.source add*.',
            );
          }
        }
      },
    },
  ],
});
