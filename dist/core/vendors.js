import { TtlCache } from './ttlCache.js';
// Read on every group message, so keep a short per-tenant cache in front of the store.
const caches = new WeakMap();
const cacheOf = (ctx) => {
    let c = caches.get(ctx);
    if (!c)
        caches.set(ctx, (c = new TtlCache(30_000, 500)));
    return c;
};
const store = (ctx) => ctx.store('vendors');
export async function getVendor(ctx, chatId) {
    const cache = cacheOf(ctx);
    const hit = cache.get(chatId);
    if (hit !== undefined)
        return hit;
    const v = (await store(ctx).get(chatId)) ?? null;
    cache.set(chatId, v);
    return v;
}
export async function listVendors(ctx) {
    const all = await store(ctx).getAll();
    return Object.values(all).sort((a, b) => a.name.localeCompare(b.name));
}
export async function saveVendor(ctx, v) {
    await store(ctx).set(v.chatId, v);
    cacheOf(ctx).delete(v.chatId);
}
export async function addVendor(ctx, chatId, name) {
    const existing = await getVendor(ctx, chatId);
    if (existing) {
        const updated = { ...existing, name: name || existing.name, enabled: true };
        await saveVendor(ctx, updated);
        return updated;
    }
    const v = { chatId, name: name || chatId, markupPercent: null, enabled: true, addedAt: Date.now(), stripPhrases: [] };
    await saveVendor(ctx, v);
    return v;
}
export async function removeVendor(ctx, chatId) {
    const had = await store(ctx).has(chatId);
    await store(ctx).del(chatId);
    cacheOf(ctx).delete(chatId);
    return had;
}
