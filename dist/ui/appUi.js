import { cleanJid } from '../core/jid.js';
import { promptMenu } from './buttonSession.js';
export const appCtxFrom = (m) => ({
    ctx: m.ctx,
    message: m.raw,
    chatId: m.chatId,
    userIds: m.userIds,
});
export const go = (to, params) => ({ kind: 'go', to, params });
export const back = () => ({ kind: 'back' });
/** Swap the current screen (e.g. next page of a list) without adding a Back step. */
export const replace = (to, params) => ({ kind: 'replace', to, params });
export const stay = (notice) => ({ kind: 'stay', notice });
export const exit = (message) => ({ kind: 'exit', message });
// One live app per tenant + chat: opening .menu again replaces the old session instead of stacking a second one.
const activeApps = new Map();
const BACK = '__back';
const EXIT = '__exit';
const MAX_STEPS = 60;
const defaultPrompt = (sock, app, view, options) => promptMenu(sock, app.message, app.chatId, app.userIds, {
    title: view.title,
    subtitle: view.subtitle,
    text: view.text,
    footer: view.footer,
    options,
});
/** Run an app until the user exits, cancels, times out, or the tenant goes offline. */
export async function runApp(app, screens, start, opts = {}) {
    const key = `${app.ctx.id}|${app.chatId}`;
    const token = Symbol('app');
    activeApps.set(key, token);
    try {
        await runLoop(app, screens, start, opts, () => activeApps.get(key) === token);
    }
    finally {
        if (activeApps.get(key) === token)
            activeApps.delete(key);
    }
}
async function runLoop(app, screens, start, opts, isCurrent) {
    const prompt = opts.prompt ?? defaultPrompt;
    const stack = [{ name: start, params: undefined }];
    for (let step = 0; step < MAX_STEPS && stack.length > 0; step++) {
        const { name, params } = stack[stack.length - 1];
        const screen = screens[name];
        if (!screen)
            throw new Error(`unknown screen "${name}"`);
        let sock;
        try {
            sock = app.ctx.getSock(); // live socket each step, so a reconnect mid-session doesn't strand us
        }
        catch {
            return; // tenant went offline; nothing to talk to
        }
        const view = await screen.view(app, params);
        const withNotice = app.notice ? { ...view, text: `${app.notice}\n\n${view.text}` } : view;
        app.notice = undefined;
        const options = [...view.options];
        if (stack.length > 1)
            options.push({ label: '⬅️ Back', value: BACK });
        const result = await prompt(sock, app, withNotice, options);
        if (!isCurrent())
            return; // a newer session took over while we were waiting; stay quiet
        if (result.timedOut || result.cancelled || result.value === null) {
            if (result.timedOut)
                await sock.sendMessage(app.chatId, { text: '⌛ Menu closed (no response).' }).catch(() => undefined);
            return;
        }
        if (result.value === BACK) {
            stack.pop();
            continue;
        }
        if (result.value === EXIT)
            return;
        const nav = await screen.select(result.value, app, params);
        switch (nav.kind) {
            case 'go':
                stack.push({ name: nav.to, params: nav.params });
                break;
            case 'back':
                stack.pop();
                break;
            case 'replace':
                stack[stack.length - 1] = { name: nav.to, params: nav.params };
                break;
            case 'stay':
                if (nav.notice)
                    app.notice = nav.notice;
                break;
            case 'exit':
                if (nav.message)
                    await app.ctx.getSock().sendMessage(app.chatId, { text: nav.message }).catch(() => undefined);
                return;
        }
    }
}
/**
 * Ask a question in free text and wait for the reply (in the same chat, from the same person).
 * Returns null on cancel, timeout, or after too many bad replies.
 */
export async function askValue(app, o) {
    const attempts = o.attempts ?? 3;
    const timeoutMs = o.timeoutMs ?? 2 * 60_000;
    const allowed = new Set(app.userIds);
    for (let attempt = 1; attempt <= attempts; attempt++) {
        let sock;
        try {
            sock = app.ctx.getSock();
        }
        catch {
            return null;
        }
        await sock.sendMessage(app.chatId, { text: `${o.prompt}\n\n_Reply here, or send *cancel*._` }, { quoted: app.message });
        const reply = await new Promise((resolve) => {
            const done = (v) => {
                clearTimeout(timer);
                sock.ev.off('messages.upsert', onUpsert);
                resolve(v);
            };
            const onUpsert = (upsert) => {
                if (upsert?.type !== 'notify')
                    return;
                for (const msg of upsert.messages ?? []) {
                    if (msg?.key?.remoteJid !== app.chatId || !msg.message)
                        continue;
                    const sender = msg.key.fromMe ? cleanJid(sock.user?.id) : cleanJid(msg.key.participant || msg.key.remoteJid);
                    if (!allowed.has(sender))
                        continue;
                    const text = msg.message.conversation ?? msg.message.extendedTextMessage?.text;
                    if (typeof text === 'string' && text.trim() !== '')
                        return done(text.trim());
                }
            };
            const timer = setTimeout(() => done(null), timeoutMs);
            timer.unref();
            sock.ev.on('messages.upsert', onUpsert);
        });
        if (reply === null || /^cancel$/i.test(reply))
            return null;
        const parsed = o.parse(reply);
        if (parsed !== null)
            return parsed;
        if (attempt < attempts) {
            await app.ctx.getSock().sendMessage(app.chatId, { text: `❌ ${o.hint ?? "I couldn't read that."} Try again.` }).catch(() => undefined);
        }
    }
    return null;
}
export const askText = (app, prompt, maxLen = 200) => askValue(app, { prompt, parse: (t) => (t.length <= maxLen ? t : null), hint: `Keep it under ${maxLen} characters.` });
/** A number, e.g. "15" or "12.5", within [min, max]. */
export const askNumber = (app, prompt, min, max) => askValue(app, {
    prompt,
    hint: `Send a number between ${min} and ${max}.`,
    parse: (t) => {
        const n = Number(t.replace(/[,%\s]/g, ''));
        return Number.isFinite(n) && n >= min && n <= max ? n : null;
    },
});
