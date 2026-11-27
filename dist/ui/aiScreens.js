import { getAi } from '../core/ai.js';
import { aiSentOn, answerInquiry } from '../core/aicare.js';
import { getLead, listAiLog, listLeads, setLeadDone } from '../core/leads.js';
import { getSettings, updateSettings } from '../core/settings.js';
import { config } from '../config.js';
import { localParts } from '../lib/postingPolicy.js';
import { askNumber, askText, back, go, stay } from './appUi.js';
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const MODE_LABEL = { off: '⏸️ OFF', away: '✅ AWAY (steps in when you don’t answer)', always: '✅ ALWAYS (answers everyone)' };
const KIND_ICON = { order: '🛒', human: '🙋', question: '❓', media: '📎', bargain: '💬' };
const ago = (ts) => {
    const m = Math.max(0, Math.round((Date.now() - ts) / 60_000));
    return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};
/** Dashboard screens for the AI customer-care assistant. */
export const aiScreens = {
    ai: {
        async view({ ctx }) {
            const s = await getSettings(ctx);
            const [leads, today] = await Promise.all([listLeads(ctx, { open: true }), aiSentOn(ctx, localParts(Date.now(), config.timeZone).day)]);
            const providers = getAi().providers;
            return {
                title: 'AI customer care',
                text: [
                    `Assistant: ${MODE_LABEL[s.aiMode]}`,
                    `Answers: DMs${s.aiReplyInGroups ? ' · replies to your posts in groups' : ''}${s.aiReplyToStatus ? ' · replies to your status' : ''}`,
                    `Today: ${today} of ${s.aiDailyCap} replies · open leads: ${leads.length}`,
                    providers ? '' : '⚠️ No AI provider is set up on this server yet, so it can’t answer. Ask your admin to add an AI key.',
                    'It only uses your items and your Shop info, never guesses a price, and hands orders, discounts and complaints to you.',
                ].filter(Boolean).join('\n'),
                options: [
                    { label: '🔀 Mode', value: 'mode', description: 'Off, away, or always' },
                    { label: `👥 Replies in groups: ${s.aiReplyInGroups ? 'ON' : 'OFF'}`, value: 'groups', description: 'Only to replies on your posts' },
                    { label: `📱 Replies to status: ${s.aiReplyToStatus ? 'ON' : 'OFF'}`, value: 'status' },
                    { label: '⏱️ Timing & limits', value: 'timing', description: 'Wait time, hours, daily limit' },
                    { label: '🏪 Shop info', value: 'info', description: s.shopInfo ? `${s.shopInfo.length} characters saved` : 'Delivery, payment, location (it can only quote this)' },
                    { label: '✍️ Style notes', value: 'style', description: s.aiInstructions ? 'saved' : 'Optional tone tips' },
                    { label: `🙋 Leads (${leads.length})`, value: 'leads', description: 'Customers who need you' },
                    { label: '📜 Recent replies', value: 'log', description: 'What it said, so you can check' },
                    { label: '🧪 Test it', value: 'test', description: 'Ask it a question as a customer would' },
                ],
            };
        },
        async select(value, app) {
            const s = await getSettings(app.ctx);
            switch (value) {
                case 'mode': return go('aimode');
                case 'groups':
                    await updateSettings(app.ctx, { aiReplyInGroups: !s.aiReplyInGroups });
                    return stay(s.aiReplyInGroups ? '👥 It won’t reply in groups.' : '👥 It will answer customers who reply to your posts in your groups.');
                case 'status':
                    await updateSettings(app.ctx, { aiReplyToStatus: !s.aiReplyToStatus });
                    return stay(s.aiReplyToStatus ? '📱 It won’t reply to status replies.' : '📱 It will answer customers who reply to your status.');
                case 'timing': return go('aitiming');
                case 'leads': return go('leads');
                case 'log': return go('ailog');
                case 'info': {
                    const v = await askText(app, 'Send your shop info: delivery, payment, location, returns. The assistant may quote ONLY this (and your items). Max 600 characters. Send - to clear.', 600);
                    if (v === null)
                        return stay('Cancelled.');
                    await updateSettings(app.ctx, { shopInfo: v === '-' ? '' : v });
                    return stay(v === '-' ? '🧹 Shop info cleared.' : '✅ Shop info saved.');
                }
                case 'style': {
                    const v = await askText(app, 'Any tone notes? e.g. "Be warm and use light Pidgin when the customer does." Max 300 characters. Send - to clear.', 300);
                    if (v === null)
                        return stay('Cancelled.');
                    await updateSettings(app.ctx, { aiInstructions: v === '-' ? '' : v });
                    return stay('✅ Saved.');
                }
                case 'test': {
                    const ai = getAi();
                    if (ai.providers === 0)
                        return stay('⚠️ No AI provider is set up on this server yet.');
                    const q = await askText(app, 'Type a question as a customer would, e.g. "how much is the kettle?"', 300);
                    if (q === null)
                        return stay('Cancelled.');
                    const o = await answerInquiry(app.ctx, { channel: 'dm', chatId: 'test', customerId: 'test', customerName: 'Test', customerPhone: null, texts: [q], productId: null }, { ai, test: true });
                    return stay(`🧪 “${cut(q, 60)}”\n🤖 ${o.kind === 'skip' ? `(no reply: ${o.reason})` : o.reply}\n${o.item ? `Item: ${o.item} · ` : ''}${o.kind === 'handoff' ? `would hand over to you (${o.reason})` : 'would reply'}. Nothing was sent.`);
                }
                default: return stay();
            }
        },
    },
    aimode: {
        async view({ ctx }) {
            const s = await getSettings(ctx);
            return {
                title: 'Assistant mode',
                text: `Now: ${MODE_LABEL[s.aiMode]}`,
                options: [
                    { label: 'Off', value: 'off', description: 'It never answers anyone' },
                    { label: 'Away (recommended)', value: 'away', description: 'Waits for you first; answers at once when you’re closed' },
                    { label: 'Always', value: 'always', description: 'Answers every customer straight away' },
                ],
            };
        },
        async select(value, app) {
            if (value !== 'off' && value !== 'away' && value !== 'always')
                return stay();
            await updateSettings(app.ctx, { aiMode: value });
            app.notice = value === 'off' ? '⏸️ Assistant is off.' : `✅ Assistant is on (${value}).`;
            return back();
        },
    },
    aitiming: {
        async view({ ctx }) {
            const s = await getSettings(ctx);
            const hours = s.hoursStart === s.hoursEnd ? 'always open' : `${s.hoursStart}:00 to ${s.hoursEnd}:00`;
            return {
                title: 'Timing & limits',
                text: [
                    `Wait for you first (away mode): ${s.aiAwayDelaySec} seconds`,
                    `Quiet after you type in a chat: ${s.aiOwnerQuietMin} minutes`,
                    `Business hours: ${hours}`,
                    `Daily limit: ${s.aiDailyCap} replies`,
                ].join('\n'),
                options: [
                    { label: '⏳ Wait time (seconds)', value: 'delay' },
                    { label: '🤫 Quiet minutes after you type', value: 'quiet' },
                    { label: '🕗 Opening hour', value: 'open', description: '0-23' },
                    { label: '🕘 Closing hour', value: 'close', description: 'Same as opening = always open' },
                    { label: '📊 Daily limit', value: 'cap' },
                ],
            };
        },
        async select(value, app) {
            const ask = async (prompt, min, max, key, done) => {
                const n = await askNumber(app, prompt, min, max);
                if (n === null)
                    return stay('Cancelled.');
                await updateSettings(app.ctx, { [key]: Math.round(n) });
                return stay(`✅ ${done} ${Math.round(n)}.`);
            };
            switch (value) {
                case 'delay': return ask('How many seconds should the assistant wait for you to answer first? (10 to 900)', 10, 900, 'aiAwayDelaySec', 'Wait time:');
                case 'quiet': return ask('After you type in a chat, stay quiet there for how many minutes? (1 to 600)', 1, 600, 'aiOwnerQuietMin', 'Quiet time:');
                case 'open': return ask('Opening hour, 0 to 23 (e.g. 8).', 0, 23, 'hoursStart', 'Opening hour:');
                case 'close': return ask('Closing hour, 0 to 23 (e.g. 21). Same as opening = always open.', 0, 23, 'hoursEnd', 'Closing hour:');
                case 'cap': return ask('Most AI replies per day (1 to 1000).', 1, 1000, 'aiDailyCap', 'Daily limit:');
                default: return stay();
            }
        },
    },
    leads: {
        async view({ ctx }) {
            const open = await listLeads(ctx, { open: true });
            return {
                title: 'Leads',
                text: open.length ? 'Customers who need you. Newest first.' : 'No open leads. When a customer wants to order, asks for you, or asks something the assistant can’t answer, they appear here.',
                options: open.slice(0, 8).map((l) => ({
                    label: `${KIND_ICON[l.kind]} ${cut(l.customerName || l.customerId, 22)}`,
                    value: `l:${l.id}`,
                    description: `${cut(l.text || '(photo/file)', 40)} · ${ago(l.at)}`,
                })),
            };
        },
        select: (value) => (value.startsWith('l:') ? go('lead', { id: value.slice(2) }) : stay()),
    },
    lead: {
        async view({ ctx }, params) {
            const l = await getLead(ctx, params.id);
            if (!l)
                return { title: 'Lead', text: 'This lead is gone.', options: [] };
            return {
                title: `${KIND_ICON[l.kind]} ${l.customerName || l.customerId}`,
                text: [
                    l.phone ? `Phone: +${l.phone}\nChat: https://wa.me/${l.phone}` : 'Phone: (not known)',
                    `Wants: ${l.kind}${l.productTitle ? ` · ${l.productTitle}` : ''}`,
                    `They wrote: ${l.text || '(a photo or file)'}`,
                    `${ago(l.at)}${l.done ? ' · ✅ done' : ''}`,
                ].join('\n'),
                options: [l.done ? { label: '↩️ Reopen', value: 'open' } : { label: '✅ Mark as done', value: 'done' }],
            };
        },
        async select(value, app, params) {
            await setLeadDone(app.ctx, params.id, value === 'done');
            app.notice = value === 'done' ? '✅ Marked as done.' : '↩️ Reopened.';
            return back();
        },
    },
    ailog: {
        async view({ ctx }) {
            const log = (await listAiLog(ctx)).slice(0, 6);
            return {
                title: 'Recent replies',
                text: log.length
                    ? log.map((e) => `${e.kind === 'handoff' ? '🙋' : '🤖'} ${e.customer} (${e.channel}, ${ago(e.at)})\n“${cut(e.asked, 70)}”\n→ ${cut(e.answered, 110)}`).join('\n\n')
                    : 'Nothing yet. Replies the assistant sends will be listed here.',
                options: [],
            };
        },
        select: () => stay(),
    },
};
