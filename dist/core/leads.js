const leads = (ctx) => ctx.store('leads');
const log = (ctx) => ctx.store('ai_log');
const newId = () => `l${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
/** One open lead per customer + kind within 30 minutes: a burst of messages doesn't create a pile of leads. */
export async function addLead(ctx, input, now = Date.now()) {
    const all = Object.values(await leads(ctx).getAll());
    const same = all.find((l) => !l.done && l.customerId === input.customerId && l.kind === input.kind && now - l.at < 30 * 60_000);
    if (same) {
        const updated = { ...same, text: input.text, productId: input.productId ?? same.productId, productTitle: input.productTitle || same.productTitle, at: now };
        await leads(ctx).set(same.id, updated);
        return updated;
    }
    const lead = { ...input, id: newId(), at: now, done: false };
    await leads(ctx).set(lead.id, lead);
    return lead;
}
export async function listLeads(ctx, opts = {}) {
    const all = Object.values(await leads(ctx).getAll());
    return all.filter((l) => !opts.open || !l.done).sort((a, b) => b.at - a.at);
}
export async function getLead(ctx, id) {
    return (await leads(ctx).get(id)) ?? null;
}
export async function setLeadDone(ctx, id, done) {
    await leads(ctx).patch(id, { done });
}
export async function pruneLeads(ctx, maxAgeMs = 30 * 86_400_000, now = Date.now()) {
    let n = 0;
    for (const l of await listLeads(ctx))
        if (now - l.at > maxAgeMs) {
            await leads(ctx).del(l.id);
            n++;
        }
    return n;
}
export async function addAiLog(ctx, entry) {
    await log(ctx).mutate('recent', (cur) => [...(cur ?? []), entry].slice(-50));
}
export async function listAiLog(ctx) {
    return ((await log(ctx).get('recent')) ?? []).slice().reverse();
}
