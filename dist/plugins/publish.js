import { config } from '../config.js';
import { noteContact, pruneAudience } from '../core/audience.js';
import { autoPostProblems, runAutoPost } from '../core/autopost.js';
import { definePlugin } from '../core/plugin.js';
import { pruneQueue } from '../core/queue.js';
import { queueSummary, recoverStale, retryFailed, runOnce } from '../core/publisher.js';
import { makeSender } from '../core/sender.js';
import { getSettings, updateSettings } from '../core/settings.js';
import { addTarget, listTargets, removeTarget } from '../core/targets.js';
import { getVendor } from '../core/vendors.js';
import { listProducts } from '../core/catalog.js';
/**
 * Posts approved items to the reseller's customer groups (and optionally their status), slowly and
 * within safe limits. Nothing is sent unless the reseller has approved the item AND chosen where.
 */
const sender = makeSender();
export default definePlugin({
    name: 'publish',
    priority: 30,
    onSocket(ctx, sock) {
        // People WhatsApp tells us about become the audience for status posts.
        const note = (contacts) => {
            for (const c of contacts ?? [])
                void noteContact(ctx, c?.id).catch(() => undefined);
        };
        sock.ev.on('contacts.upsert', note);
        sock.ev.on('contacts.update', note);
    },
    async onMessage(m) {
        // Anyone who messages the reseller privately is someone who can see their status.
        if (!m.isGroup && !m.fromMe && !m.isStatus)
            await noteContact(m.ctx, m.senderPn ?? m.senderJid);
    },
    async onTenantStart(ctx) {
        const n = await recoverStale(ctx);
        if (n > 0)
            ctx.log.warn(`${n} post(s) were interrupted by a restart and are marked failed for you to check`);
    },
    schedules: [
        {
            name: 'tick',
            everyMs: config.publishTickMs,
            run: async (ctx) => {
                const r = await runOnce(ctx, { sender });
                if (r.kind === 'sent')
                    ctx.log.info(`posted job ${r.jobId}`);
                else if (r.kind === 'failed' || r.kind === 'retry')
                    ctx.log.warn(`post ${r.kind}: ${r.error}`);
            },
        },
        {
            name: 'autopost',
            everyMs: 30_000,
            run: async (ctx) => {
                const r = await runAutoPost(ctx);
                if (r.approved > 0)
                    ctx.log.info(`auto-post: approved ${r.approved} item(s)${r.held ? `, holding ${r.held} for review` : ''}`);
            },
        },
        {
            name: 'prune',
            everyMs: 6 * 60 * 60_000,
            runWhenOffline: true,
            run: async (ctx) => void (await pruneQueue(ctx), await pruneAudience(ctx)),
        },
    ],
    commands: [
        {
            name: 'target',
            description: 'Where to post: .target add | remove | list (type in your customer group)',
            cooldownMs: 1_500,
            run: async (c) => {
                const [sub = 'list', ...rest] = c.args;
                switch (sub.toLowerCase()) {
                    case 'add': {
                        if (!c.isGroup)
                            return void (await c.replyPrivate('Type *.target add* inside the customer group you want to post to.'));
                        if (await getVendor(c.ctx, c.chatId))
                            return void (await c.replyPrivate('That group is one of your vendor sources, so I won’t post into it. Use a group of your own customers.'));
                        let name = rest.join(' ').trim();
                        if (!name) {
                            try {
                                name = (await c.ctx.groupMetadata(c.chatId))?.subject ?? '';
                            }
                            catch { /* use the id */ }
                        }
                        const t = await addTarget(c.ctx, c.chatId, name);
                        const waiting = (await listProducts(c.ctx, { status: 'approved' })).length;
                        await c.replyPrivate(`✅ I’ll post approved items to *${t.name}*.${waiting ? `\n${waiting} approved item(s) are waiting: .menu → Posting → Queue approved items.` : ''}`);
                        return;
                    }
                    case 'remove':
                    case 'rm': {
                        if (!c.isGroup)
                            return void (await c.replyPrivate('Type *.target remove* inside the group, or remove it from .menu → Posting.'));
                        const had = await removeTarget(c.ctx, c.chatId);
                        await c.replyPrivate(had ? '🗑️ I won’t post to this group any more.' : 'This group wasn’t a posting target.');
                        return;
                    }
                    default: {
                        const all = await listTargets(c.ctx);
                        await c.replyPrivate(all.length ? `*Posting to*\n${all.map((t) => `• ${t.name}${t.enabled ? '' : ' (off)'}`).join('\n')}` : 'No target groups yet. Open one of your customer groups and type *.target add*.');
                    }
                }
            },
        },
        {
            name: 'auto',
            description: 'Hands-off posting: .auto on | off | status | delay <minutes>',
            cooldownMs: 1_000,
            run: async (c) => {
                const sub = (c.args[0] ?? 'status').toLowerCase();
                if (sub === 'on') {
                    const problems = await autoPostProblems(c.ctx);
                    if (problems.length)
                        return void (await c.replyPrivate(`⚠️ Auto-post isn’t on yet:\n${problems.map((p) => `• ${p}`).join('\n')}`));
                    await updateSettings(c.ctx, { autoPost: true });
                    const s = await getSettings(c.ctx);
                    return void (await c.replyPrivate(`🤖 Auto-post is ON. New vendor items with a clear price are approved after ${s.autoPostDelayMin} min and posted gradually. Anything doubtful stays in .menu → Items for you. Turn it off any time with *.auto off*.`));
                }
                if (sub === 'off') {
                    await updateSettings(c.ctx, { autoPost: false });
                    return void (await c.replyPrivate('⏸️ Auto-post is OFF. Items wait for your approval again. Posts already in the queue still go out (use *.post stop* to halt those too).'));
                }
                if (sub === 'delay') {
                    const n = Number(c.args[1]);
                    if (!Number.isFinite(n) || n < 0 || n > 120)
                        return void (await c.replyPrivate('Type it like: *.auto delay 10* (0 to 120 minutes).'));
                    await updateSettings(c.ctx, { autoPostDelayMin: Math.round(n) });
                    return void (await c.replyPrivate(`⏳ Items now wait ${Math.round(n)} min before auto-approval.`));
                }
                const s = await getSettings(c.ctx);
                const problems = s.autoPost ? await autoPostProblems(c.ctx, s) : [];
                await c.replyPrivate(`🤖 Auto-post: ${s.autoPost ? '✅ ON' : '⏸️ OFF'}\nWait before approving: ${s.autoPostDelayMin} min · drop if still queued after ${s.autoPostMaxAgeHrs || '∞'} h${problems.length ? `\n⚠️ Can’t run yet:\n${problems.map((p) => `• ${p}`).join('\n')}` : ''}`);
            },
        },
        {
            name: 'post',
            description: 'Posting control: .post stop | start | status | retry',
            cooldownMs: 1_000,
            run: async (c) => {
                const sub = (c.args[0] ?? 'status').toLowerCase();
                if (sub === 'stop' || sub === 'pause') {
                    await updateSettings(c.ctx, { postingEnabled: false });
                    return void (await c.replyPrivate('⏸️ Posting is paused. Nothing will be sent until you type *.post start*.'));
                }
                if (sub === 'start' || sub === 'resume') {
                    await updateSettings(c.ctx, { postingEnabled: true });
                    return void (await c.replyPrivate('▶️ Posting is on.'));
                }
                if (sub === 'retry') {
                    const n = await retryFailed(c.ctx);
                    return void (await c.replyPrivate(n ? `🔁 ${n} failed post(s) queued again.` : 'Nothing to retry.'));
                }
                const q = await queueSummary(c.ctx);
                await c.replyPrivate(`Posting: ${q.enabled ? '✅ on' : '⏸️ paused'}${q.pausedUntil > Date.now() ? ' (cooling down after errors)' : ''}\nToday: ${q.sentToday}/${q.limitToday}\nQueue: ${q.pending} waiting · ${q.failed} failed`);
            },
        },
    ],
});
