import { config } from '../config.js';
import { canSendNow, dailyLimit, localParts, nextGapMs } from '../lib/postingPolicy.js';
import { buildStatusAudience } from './audience.js';
import { getProduct, listProducts, saveProduct } from './catalog.js';
import { addJobs, countSent, getMeta, jobsForProduct, listJobs, patchMeta, recordSent, saveJob, sentOn, } from './queue.js';
import { renderProduct } from './render.js';
import { classifySendError } from './sender.js';
import { getSettings } from './settings.js';
import { getTarget, listTargets } from './targets.js';
import { getVendor } from './vendors.js';
const RETRY_DELAYS_MS = [2 * 60_000, 10 * 60_000, 30 * 60_000];
const lastNotice = new WeakMap();
export async function notifyOwner(ctx, key, text) {
    let seen = lastNotice.get(ctx);
    if (!seen)
        lastNotice.set(ctx, (seen = new Map()));
    const last = seen.get(key);
    if (last && Date.now() - last < 3_600_000)
        return;
    seen.set(key, Date.now());
    await ctx.trySock()?.sendMessage(`${ctx.tenant.number}@s.whatsapp.net`, { text })?.catch(() => undefined);
}
const nameOf = (p) => (p.rawCaption.split('\n')[0] || 'an item').slice(0, 40);
// ── queueing ────────────────────────────────────────────────────────────────
/** Queue an approved item for every place the reseller posts to. */
export async function enqueueProduct(ctx, productId) {
    const product = await getProduct(ctx, productId);
    if (!product)
        return { queued: 0, reason: 'missing' };
    if ((await jobsForProduct(ctx, productId)).some((j) => j.state === 'pending' || j.state === 'sending'))
        return { queued: 0, reason: 'already-queued' };
    const settings = await getSettings(ctx);
    const targets = (await listTargets(ctx)).filter((t) => t.enabled).map((t) => ({ type: 'group', jid: t.chatId, name: t.name }));
    if (settings.postToStatus)
        targets.push({ type: 'status' });
    if (targets.length === 0)
        return { queued: 0, reason: 'no-targets' };
    await addJobs(ctx, productId, targets);
    product.status = 'queued';
    product.postError = null;
    await saveProduct(ctx, product);
    return { queued: targets.length };
}
/** Queue every approved item that isn't queued yet. Returns how many items were queued. */
export async function enqueueApproved(ctx) {
    let items = 0;
    for (const p of await listProducts(ctx, { status: 'approved' })) {
        const r = await enqueueProduct(ctx, p.id);
        if (r.reason === 'no-targets')
            return { items, reason: 'no-targets' };
        if (r.queued > 0)
            items++;
    }
    return { items };
}
/** Recompute an item's status from its jobs. */
export async function refreshProductStatus(ctx, productId) {
    const p = await getProduct(ctx, productId);
    if (!p || p.status === 'ignored' || p.status === 'soldout')
        return;
    const jobs = await jobsForProduct(ctx, productId);
    if (jobs.length === 0)
        return;
    const failed = jobs.find((j) => j.state === 'failed');
    if (jobs.some((j) => j.state === 'pending' || j.state === 'sending')) {
        p.status = 'queued';
    }
    else if (jobs.some((j) => j.state === 'done')) {
        p.status = 'posted';
        p.postedAt = p.postedAt ?? Date.now();
        p.postError = failed?.error ?? null; // partly posted: keep the reason visible
    }
    else {
        p.status = 'approved'; // nothing went out; the owner can retry
        p.postError = failed?.error ?? 'Nothing was sent.';
    }
    await saveProduct(ctx, p);
}
// ── sending ─────────────────────────────────────────────────────────────────
/**
 * Send at most one due job, if the posting rules allow it right now. Called every few seconds.
 * One job at a time per tenant, with a random human-like gap after each, a daily ceiling that
 * ramps up for new accounts, quiet hours, and automatic pauses when WhatsApp pushes back.
 */
export async function runOnce(ctx, deps) {
    const now = (deps.now ?? Date.now)();
    const rand = deps.rand ?? Math.random;
    const notify = deps.notify ?? notifyOwner;
    if (!ctx.online)
        return { kind: 'blocked', reason: 'offline' };
    const due = (await listJobs(ctx, 'pending')).filter((j) => j.notBefore <= now);
    if (due.length === 0)
        return { kind: 'idle' };
    const settings = await getSettings(ctx);
    const meta = await getMeta(ctx);
    const { day } = localParts(now, config.timeZone);
    const verdict = canSendNow({
        enabled: settings.postingEnabled,
        now,
        timeZone: config.timeZone,
        createdAt: ctx.tenant.createdAt,
        sentToday: await sentOn(ctx, day),
        dailyCap: settings.dailyCap,
        quietStart: settings.quietStart,
        quietEnd: settings.quietEnd,
        nextSendAt: meta.nextSendAt,
        pausedUntil: meta.pausedUntil,
    });
    if (!verdict.ok)
        return { kind: 'blocked', reason: verdict.reason };
    const job = due[0];
    const skip = async (why) => {
        job.state = 'skipped';
        job.error = why;
        job.finishedAt = now;
        await saveJob(ctx, job);
        await refreshProductStatus(ctx, job.productId);
        return { kind: 'skipped', jobId: job.id, why };
    };
    const product = await getProduct(ctx, job.productId);
    if (!product)
        return skip('the item was removed');
    if (product.status === 'ignored' || product.status === 'soldout')
        return skip(`the item is ${product.status}`);
    if (job.target.type === 'group') {
        const t = await getTarget(ctx, job.target.jid);
        if (!t || !t.enabled)
            return skip('that group is no longer a posting target');
    }
    const caption = renderProduct(product, settings, await getVendor(ctx, product.vendorChatId)).caption;
    const toJid = job.target.type === 'group' ? job.target.jid : 'status@broadcast';
    job.state = 'sending';
    job.attempts++;
    job.startedAt = now;
    await saveJob(ctx, job); // saved BEFORE sending: a crash mid-send is detected on restart instead of silently re-sent
    try {
        const ids = job.target.type === 'group'
            ? await deps.sender.sendGroup(ctx, job.target.jid, { media: product.media, caption })
            : await deps.sender.sendStatus(ctx, await buildStatusAudience(ctx), { media: product.media, caption });
        job.state = 'done';
        job.finishedAt = now;
        job.sentIds = ids;
        job.error = null;
        await saveJob(ctx, job);
        await recordSent(ctx, product.id, toJid, ids);
        await countSent(ctx, day);
        await patchMeta(ctx, { nextSendAt: now + nextGapMs(settings.gapMinSec, settings.gapMaxSec, rand), consecutiveFailures: 0, lastSentAt: now });
        await refreshProductStatus(ctx, product.id);
        return { kind: 'sent', jobId: job.id };
    }
    catch (err) {
        const e = classifySendError(err);
        const partial = err.partialIds ?? e.partialIds ?? [];
        if (partial.length)
            await recordSent(ctx, product.id, toJid, partial);
        const where = job.target.type === 'group' ? `“${job.target.name}”` : 'your status';
        let state = 'failed';
        let consecutive = meta.consecutiveFailures;
        let pausedUntil = meta.pausedUntil;
        if (e.kind === 'ratelimit') {
            state = 'pending';
            job.notBefore = now + 30 * 60_000;
            consecutive++;
            pausedUntil = now + 2 * 3_600_000;
            await notify(ctx, 'ratelimit', `🛑 WhatsApp is slowing your account down (rate limit). I've paused posting for 2 hours to protect your number. Consider lowering your daily limit in .menu → Posting → Limits.`);
        }
        else if (e.kind === 'transient') {
            consecutive++;
            if (job.attempts < RETRY_DELAYS_MS.length) {
                state = 'pending';
                job.notBefore = now + RETRY_DELAYS_MS[job.attempts - 1];
            }
            if (consecutive >= 3) {
                pausedUntil = now + 60 * 60_000;
                await notify(ctx, 'failures', `⚠️ Posting failed 3 times in a row (${e.message}). I've paused posting for an hour. Check your connection, then .menu → Posting.`);
            }
        }
        else {
            await notify(ctx, `perm:${e.message}`, `⚠️ Couldn't post ${nameOf(product)} to ${where}: ${e.message}. Open .menu → Posting to retry or fix it.`);
        }
        job.state = state;
        job.error = e.message;
        if (state === 'failed')
            job.finishedAt = now;
        await saveJob(ctx, job);
        await patchMeta(ctx, { nextSendAt: now + nextGapMs(settings.gapMinSec, settings.gapMaxSec, rand), consecutiveFailures: consecutive, pausedUntil });
        await refreshProductStatus(ctx, product.id);
        return state === 'pending' ? { kind: 'retry', jobId: job.id, error: e.message } : { kind: 'failed', jobId: job.id, error: e.message };
    }
}
// ── recovery and housekeeping ───────────────────────────────────────────────
/**
 * Jobs left "sending" by a crash or restart. We can't know whether the post actually went out, and
 * a double post looks worse than a missed one, so they're marked failed for the owner to check.
 */
export async function recoverStale(ctx, now = Date.now()) {
    let n = 0;
    for (const j of await listJobs(ctx, 'sending')) {
        j.state = 'failed';
        j.error = 'Interrupted while sending. Check the group, then retry if it is missing.';
        j.finishedAt = now;
        await saveJob(ctx, j);
        await refreshProductStatus(ctx, j.productId);
        n++;
    }
    return n;
}
export async function retryFailed(ctx, now = Date.now()) {
    let n = 0;
    for (const j of await listJobs(ctx, 'failed')) {
        j.state = 'pending';
        j.attempts = 0;
        j.notBefore = now;
        j.error = null;
        j.finishedAt = undefined;
        await saveJob(ctx, j);
        await refreshProductStatus(ctx, j.productId);
        n++;
    }
    return n;
}
export async function clearFailed(ctx, now = Date.now()) {
    let n = 0;
    for (const j of await listJobs(ctx, 'failed')) {
        j.state = 'skipped';
        j.finishedAt = now;
        await saveJob(ctx, j);
        await refreshProductStatus(ctx, j.productId);
        n++;
    }
    return n;
}
export async function queueSummary(ctx, now = Date.now()) {
    const [jobs, settings, meta] = await Promise.all([listJobs(ctx), getSettings(ctx), getMeta(ctx)]);
    const by = (s) => jobs.filter((j) => j.state === s).length;
    return {
        enabled: settings.postingEnabled,
        pending: by('pending'),
        sending: by('sending'),
        failed: by('failed'),
        sentToday: await sentOn(ctx, localParts(now, config.timeZone).day),
        limitToday: dailyLimit({ dailyCap: settings.dailyCap, createdAt: ctx.tenant.createdAt, now }),
        nextSendAt: meta.nextSendAt,
        pausedUntil: meta.pausedUntil,
    };
}
