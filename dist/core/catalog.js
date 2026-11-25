const catalog = (ctx) => ctx.store('catalog');
const mediaIndex = (ctx) => ctx.store('media_index');
const msgIndex = (ctx) => ctx.store('msg_index');
export const newProductId = () => `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
export async function saveProduct(ctx, p) {
    p.updatedAt = Date.now();
    await catalog(ctx).set(p.id, p);
}
export async function getProduct(ctx, id) {
    return (await catalog(ctx).get(id)) ?? null;
}
export async function listProducts(ctx, opts = {}) {
    const all = Object.values(await catalog(ctx).getAll());
    return all.filter((p) => !opts.status || p.status === opts.status).sort((a, b) => b.createdAt - a.createdAt);
}
export async function countByStatus(ctx) {
    const counts = { new: 0, approved: 0, queued: 0, posted: 0, soldout: 0, ignored: 0 };
    for (const p of Object.values(await catalog(ctx).getAll()))
        counts[p.status]++;
    return counts;
}
/** Register a product's fingerprints and source message ids so re-posts and replies can find it. */
export async function indexProduct(ctx, p) {
    await Promise.all([
        ...p.hashes.filter(Boolean).map((h) => mediaIndex(ctx).set(h, p.id)),
        ...p.sourceMessageIds.map((m) => msgIndex(ctx).set(m, p.id)),
    ]);
}
/** The id of an existing product that shares any media fingerprint, if there is one. */
export async function findByHashes(ctx, hashes) {
    for (const h of hashes.filter(Boolean)) {
        const id = (await mediaIndex(ctx).get(h));
        if (id)
            return id;
    }
    return null;
}
export async function findByMessage(ctx, messageId) {
    return (await msgIndex(ctx).get(messageId)) ?? null;
}
/** Keep the catalog bounded: drop old items and anything beyond the newest `maxItems`. Returns how many were removed. */
export async function pruneCatalog(ctx, maxAgeMs, maxItems) {
    const all = Object.values(await catalog(ctx).getAll()).sort((a, b) => b.createdAt - a.createdAt);
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
