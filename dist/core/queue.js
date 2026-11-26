const DEFAULT_META = { nextSendAt: 0, pausedUntil: 0, consecutiveFailures: 0, lastSentAt: 0 };
const jobs = (ctx) => ctx.store('queue');
const stats = (ctx) => ctx.store('post_stats');
const meta = (ctx) => ctx.store('post_meta');
const sentIndex = (ctx) => ctx.store('sent_index');
export const newJobId = () => `j${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
export async function addJobs(ctx, productId, targets, now = Date.now()) {
    const created = [];
    for (const target of targets) {
        const job = { id: newJobId(), productId, target, state: 'pending', attempts: 0, notBefore: now, createdAt: now + created.length };
        await jobs(ctx).set(job.id, job);
        created.push(job);
    }
    return created;
}
export const saveJob = (ctx, job) => jobs(ctx).set(job.id, job);
export async function listJobs(ctx, state) {
    const all = Object.values(await jobs(ctx).getAll());
    return all.filter((j) => !state || j.state === state).sort((a, b) => a.createdAt - b.createdAt);
}
export const jobsForProduct = async (ctx, productId) => (await listJobs(ctx)).filter((j) => j.productId === productId);
export async function getMeta(ctx) {
    return { ...DEFAULT_META, ...((await meta(ctx).get('main')) ?? {}) };
}
export const patchMeta = (ctx, patch) => meta(ctx).patch('main', patch);
/** How many posts went out on this local day. */
export async function sentOn(ctx, day) {
    return ((await stats(ctx).get(`day:${day}`))?.sent) ?? 0;
}
export async function countSent(ctx, day) {
    const next = await stats(ctx).mutate(`day:${day}`, (cur) => ({ sent: (cur?.sent ?? 0) + 1 }));
    return next.sent;
}
/** Remember which product a sent message belongs to (customer replies are matched through this). */
export async function recordSent(ctx, productId, jid, ids) {
    await Promise.all(ids.map((id) => sentIndex(ctx).set(id, { productId, jid, at: Date.now() })));
}
export const findSent = async (ctx, messageId) => (await sentIndex(ctx).get(messageId)) ?? null;
/** Housekeeping: finished jobs and old counters don't need to live forever. */
export async function pruneQueue(ctx, now = Date.now()) {
    let removed = 0;
    for (const j of await listJobs(ctx)) {
        const age = now - (j.finishedAt ?? j.createdAt);
        const old = (j.state === 'done' || j.state === 'skipped') ? age > 3 * 86_400_000 : j.state === 'failed' ? age > 14 * 86_400_000 : false;
        if (old) {
            await jobs(ctx).del(j.id);
            removed++;
        }
    }
    return removed;
}
