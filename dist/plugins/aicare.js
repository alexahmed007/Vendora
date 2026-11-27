import { config } from '../config.js';
import { getAi } from '../core/ai.js';
import { aiSentOn, answerInquiry, isOpenNow, isVendorChat } from '../core/aicare.js';
import { cleanJid } from '../core/jid.js';
import { listLeads, pruneLeads } from '../core/leads.js';
import { definePlugin } from '../core/plugin.js';
import { findSent } from '../core/queue.js';
import { getSettings, updateSettings } from '../core/settings.js';
import { getTarget } from '../core/targets.js';
import { TtlCache } from '../core/ttlCache.js';
import { localParts } from '../lib/postingPolicy.js';
const HOUR = 3_600_000;
const pendings = new WeakMap();
const ownerActive = new WeakMap(); // chat -> when the owner last typed there
const handoffQuiet = new WeakMap(); // chat -> quiet for 2h after a hand-off
const pausedChats = new WeakMap();
const groupSends = new WeakMap();
const settingsCache = new WeakMap();
const bag = (m, ctx, make) => {
    let v = m.get(ctx);
    if (!v)
        m.set(ctx, (v = make()));
    return v;
};
const ownerCache = (ctx) => bag(ownerActive, ctx, () => new TtlCache(6 * HOUR, 2_000));
const quietCache = (ctx) => bag(handoffQuiet, ctx, () => new TtlCache(2 * HOUR, 2_000));
const pendingOf = (ctx) => bag(pendings, ctx, () => new Map());
async function settingsOf(ctx) {
    const hit = settingsCache.get(ctx);
    if (hit && Date.now() - hit.at < config.aiSettingsCacheMs)
        return hit.s;
    const s = await getSettings(ctx);
    settingsCache.set(ctx, { at: Date.now(), s });
    return s;
}
async function isChatPaused(ctx, chatId) {
    const cache = bag(pausedChats, ctx, () => new TtlCache(30_000, 2_000));
    const hit = cache.get(chatId);
    if (hit !== undefined)
        return hit;
    const paused = Boolean(await ctx.store('ai_chats').get(chatId));
    cache.set(chatId, paused);
    return paused;
}
async function setChatPaused(ctx, chatId, paused) {
    if (paused)
        await ctx.store('ai_chats').set(chatId, { paused: true, at: Date.now() });
    else
        await ctx.store('ai_chats').del(chatId);
    bag(pausedChats, ctx, () => new TtlCache(30_000, 2_000)).set(chatId, paused);
}
/** The owner is handling this chat (typed there recently, or the assistant just handed it over). */
function ownerHasIt(ctx, chatId, s, now) {
    const last = ownerCache(ctx).get(chatId);
    if (last !== undefined && now - last < s.aiOwnerQuietMin * 60_000)
        return true;
    return quietCache(ctx).get(chatId) === true;
}
const MEDIA_TYPES = new Set(['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage', 'ptvMessage']);
/** Answer every pending customer whose wait is over. Exported so tests (and shutdown) can drive it. */
export async function sweep(ctx, deps = {}) {
    const map = pendings.get(ctx);
    if (!map || map.size === 0)
        return [];
    const ai = deps.ai ?? getAi();
    const now = deps.now ?? Date.now();
    const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const outcomes = [];
    for (const [key, p] of [...map]) {
        if (p.dueAt > now)
            continue;
        map.delete(key);
        const s = await settingsOf(ctx);
        if (s.aiMode === 'off')
            continue;
        if (p.kind !== 'group' && ownerHasIt(ctx, p.chatId, s, now))
            continue; // you answered meanwhile
        if (await isChatPaused(ctx, p.chatId))
            continue;
        const sock = ctx.trySock();
        if (!sock) { // offline: try again shortly while the question is still fresh
            if (now - p.dueAt < 10 * 60_000) {
                p.dueAt = now + 15_000;
                map.set(key, p);
            }
            continue;
        }
        if (p.kind === 'group') {
            const sends = bag(groupSends, ctx, () => []);
            const recent = sends.filter((t) => now - t < 10 * 60_000);
            groupSends.set(ctx, recent);
            if (recent.length >= config.aiGroupPer10Min)
                continue; // a group is never flooded
            if (recent.length && now - recent[recent.length - 1] < 8_000) {
                p.dueAt = now + 8_000;
                map.set(key, p);
                continue;
            }
        }
        const outcome = await answerInquiry(ctx, {
            channel: p.kind, chatId: p.chatId, customerId: p.customerId, customerName: p.customerName, customerPhone: p.customerPhone,
            texts: p.texts, productId: p.productId, media: p.media,
        }, { ai, now: () => now });
        outcomes.push(outcome);
        if (outcome.kind === 'skip' || !outcome.reply)
            continue;
        await sleep(800 + Math.round(Math.random() * 1_800)); // not instant, like a person typing
        try {
            await sock.sendMessage(p.chatId, { text: outcome.reply }, p.kind === 'dm' ? undefined : { quoted: p.raw });
        }
        catch (err) {
            ctx.log.error(`ai reply failed: ${err.message}`);
            continue;
        }
        if (p.kind === 'group')
            bag(groupSends, ctx, () => []).push(now);
        if (outcome.kind === 'handoff')
            quietCache(ctx).set(p.chatId, true); // the owner takes it from here
    }
    return outcomes;
}
export default definePlugin({
    name: 'aicare',
    priority: 40,
    async onMessage(m) {
        if (m.isStatus)
            return;
        const ctx = m.ctx;
        // You typed in a chat: the assistant steps back there, and anything waiting to be sent is cancelled.
        if (m.fromMe) {
            if (!m.isGroup)
                ownerCache(ctx).set(m.chatId, Date.now());
            for (const k of [...pendingOf(ctx).keys()])
                if (k.startsWith(`${m.chatId}|`))
                    pendingOf(ctx).delete(k);
            return;
        }
        const s = await settingsOf(ctx);
        if (s.aiMode === 'off' || m.isOwner)
            return;
        if (await isVendorChat(ctx, m.chatId))
            return; // never answer inside a vendor's group
        const now = Date.now();
        if (m.isCatchUp && now - m.timestamp > config.aiMaxMessageAgeMin * 60_000)
            return; // stale: don't answer hours late
        if (await isChatPaused(ctx, m.chatId))
            return;
        let kind;
        let productId = null;
        if (m.isGroup) {
            // Only customers replying to one of OUR posts, in a group we post to. Group chatter is none of our business.
            if (!s.aiReplyInGroups || !m.quotedId)
                return;
            const sent = await findSent(ctx, m.quotedId);
            if (!sent || sent.jid !== m.chatId)
                return;
            if (!(await getTarget(ctx, m.chatId))?.enabled)
                return;
            kind = 'group';
            productId = sent.productId;
        }
        else if (m.quotedChat === 'status@broadcast' && m.quotedId) {
            if (!s.aiReplyToStatus)
                return;
            productId = (await findSent(ctx, m.quotedId))?.productId ?? null;
            kind = 'status';
            if (ownerHasIt(ctx, m.chatId, s, now))
                return;
        }
        else {
            kind = 'dm';
            if (ownerHasIt(ctx, m.chatId, s, now))
                return;
        }
        const media = !m.text && MEDIA_TYPES.has(m.type);
        if (!m.text && !media)
            return;
        // "away": give the owner a chance first, unless the shop is closed. Others: a short pause to collect a burst of messages.
        const waitMs = kind === 'dm' && s.aiMode === 'away' && isOpenNow(s, now) ? s.aiAwayDelaySec * 1_000 : 4_000;
        const key = `${m.chatId}|${m.userId}`;
        const existing = pendingOf(ctx).get(key);
        if (existing) {
            if (m.text)
                existing.texts.push(m.text);
            existing.media = existing.media || media;
            existing.raw = m.raw;
            existing.dueAt = Math.max(existing.dueAt, now + 3_000); // still typing: wait a little longer
            return;
        }
        const pn = m.senderPn && m.senderPn.endsWith('@s.whatsapp.net') ? cleanJid(m.senderPn) : null;
        if (pendingOf(ctx).size > 200)
            return; // a flood can't grow memory
        pendingOf(ctx).set(key, {
            kind, chatId: m.chatId, customerId: m.userId, customerName: m.pushName, customerPhone: pn,
            texts: m.text ? [m.text] : [], productId, media, raw: m.raw, dueAt: now + waitMs,
        });
    },
    onTenantStop(ctx) {
        pendingOf(ctx).clear();
    },
    schedules: [
        { name: 'sweep', everyMs: 2_000, run: async (ctx) => void (await sweep(ctx)) },
        { name: 'prune', everyMs: 6 * HOUR, runWhenOffline: true, run: async (ctx) => void (await pruneLeads(ctx)) },
    ],
    commands: [
        {
            name: 'ai',
            description: 'AI customer care: .ai on | off | always | status | pause | resume | test <question>',
            cooldownMs: 800,
            interactive: true,
            run: async (c) => {
                const [sub = 'status', ...rest] = c.args;
                const ctx = c.ctx;
                const set = async (mode, msg) => {
                    await updateSettings(ctx, { aiMode: mode });
                    settingsCache.delete(ctx);
                    await c.replyPrivate(msg);
                };
                switch (sub.toLowerCase()) {
                    case 'on':
                    case 'away':
                        return set('away', '🤖 Assistant is ON in *away* mode: it answers when you don’t reply within a minute or two, or when you’re closed.');
                    case 'always':
                        return set('always', '🤖 Assistant is ON in *always* mode: it answers every customer straight away.');
                    case 'off':
                        return set('off', '🤖 Assistant is OFF. It will not answer anyone.');
                    case 'pause':
                        await setChatPaused(ctx, c.chatId, true);
                        return void (await c.replyPrivate('⏸️ The assistant won’t answer in this chat until you type *.ai resume* here.'));
                    case 'resume':
                        await setChatPaused(ctx, c.chatId, false);
                        return void (await c.replyPrivate('▶️ The assistant can answer in this chat again.'));
                    case 'test': {
                        const question = rest.join(' ').trim();
                        if (!question)
                            return void (await c.replyPrivate('Type it like: *.ai test how much is the kettle?*'));
                        const ai = getAi();
                        if (ai.providers === 0)
                            return void (await c.replyPrivate('⚠️ No AI provider is configured on this server yet (an admin must set GROQ_API_KEY or GEMINI_API_KEY).'));
                        const o = await answerInquiry(ctx, { channel: 'dm', chatId: c.ownChatId, customerId: 'test', customerName: 'Test', customerPhone: null, texts: [question], productId: null }, { ai, test: true });
                        return void (await c.replyPrivate(`🧪 *Test* (nothing was sent to anyone)\nCustomer: ${question}\n${o.kind === 'skip' ? `Assistant: (no reply: ${o.reason})` : `Assistant: ${o.reply}`}\n${o.item ? `Item matched: ${o.item}\n` : 'Item matched: none\n'}Decision: ${o.kind === 'handoff' ? `hand over to you (${o.reason})` : o.kind} `));
                    }
                    default: {
                        const s = await getSettings(ctx);
                        const now = Date.now();
                        const day = localParts(now, config.timeZone).day;
                        await c.replyPrivate(`🤖 Assistant: *${s.aiMode}*\nToday: ${await aiSentOn(ctx, day)}/${s.aiDailyCap} replies · open leads: ${(await listLeads(ctx, { open: true })).length}\n` +
                            `Groups: ${s.aiReplyInGroups ? 'on' : 'off'} · Status: ${s.aiReplyToStatus ? 'on' : 'off'} · ${isOpenNow(s, now) ? 'open now' : 'closed now'}\n` +
                            `AI provider: ${getAi().providers ? 'connected' : 'NOT configured'}`);
                    }
                }
            },
        },
    ],
});
