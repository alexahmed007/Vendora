const store = (ctx) => ctx.store('targets');
export async function listTargets(ctx) {
    return Object.values(await store(ctx).getAll()).sort((a, b) => a.name.localeCompare(b.name));
}
export async function getTarget(ctx, chatId) {
    return (await store(ctx).get(chatId)) ?? null;
}
export async function saveTarget(ctx, t) {
    await store(ctx).set(t.chatId, t);
}
export async function addTarget(ctx, chatId, name) {
    const existing = await getTarget(ctx, chatId);
    const t = existing
        ? { ...existing, name: name || existing.name, enabled: true }
        : { chatId, name: name || chatId, enabled: true, addedAt: Date.now() };
    await saveTarget(ctx, t);
    return t;
}
export async function removeTarget(ctx, chatId) {
    const had = await store(ctx).has(chatId);
    await store(ctx).del(chatId);
    return had;
}
