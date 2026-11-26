import type { IncomingMessage } from '../core/message.js';
import type { TenantContext } from '../core/tenantContext.js';
import { chatKey } from '../core/jid.js';
import { plainTextOf, promptMenu, quotedIdOf, renderAsk, senderOf, warnOnce, type MenuOption, type MenuResult } from './menuSession.js';

/**
 * A tiny screen router for numbered menus, generalized from the old bank app.
 * A Screen describes what to show (view) and what each choice does (select).
 * runApp() loops: show a screen, wait for a choice, follow it. Back and exit are built in.
 */

export interface AppCtx {
  ctx: TenantContext;
  /** The message that opened the app; menus are quoted against it. */
  message: any;
  chatId: string;
  /** Everyone allowed to answer (the opener's phone and lid ids). */
  userIds: string[];
  /** One-shot line shown above the next screen (e.g. "✅ Saved"). */
  notice?: string;
  /** Set while a free-text question is open, so a newer session can close it. */
  cancelAsk?: () => void;
}

export const appCtxFrom = (m: IncomingMessage): AppCtx => ({
  ctx: m.ctx,
  message: m.raw,
  chatId: m.chatId,
  userIds: m.userIds,
});

export interface ScreenView {
  title: string;
  subtitle?: string;
  text: string;
  footer?: string;
  options: MenuOption[];
}

export type Nav =
  | { kind: 'go'; to: string; params?: unknown }
  | { kind: 'back' }
  | { kind: 'replace'; to: string; params?: unknown }
  | { kind: 'stay'; notice?: string }
  | { kind: 'exit'; message?: string };

export const go = (to: string, params?: unknown): Nav => ({ kind: 'go', to, params });
export const back = (): Nav => ({ kind: 'back' });
/** Swap the current screen (e.g. next page of a list) without adding a Back step. */
export const replace = (to: string, params?: unknown): Nav => ({ kind: 'replace', to, params });
export const stay = (notice?: string): Nav => ({ kind: 'stay', notice });
export const exit = (message?: string): Nav => ({ kind: 'exit', message });

export interface Screen<P = any> {
  view(app: AppCtx, params: P): Promise<ScreenView> | ScreenView;
  select(value: string, app: AppCtx, params: P): Promise<Nav> | Nav;
}
export type ScreenMap = Record<string, Screen>;

// One live app per tenant + chat: opening .menu again replaces the old session (and closes any
// question it was waiting on) instead of stacking a second one.
const activeApps = new Map<string, { token: symbol; abort: () => void }>();

const BACK = '__back';
const EXIT = '__exit';
const MAX_STEPS = 60;

export interface RunOptions {
  /** Inject a different prompt (tests). */
  prompt?: (sock: any, app: AppCtx, view: ScreenView, options: MenuOption[]) => Promise<MenuResult>;
}

const defaultPrompt: NonNullable<RunOptions['prompt']> = (sock, app, view, options) =>
  promptMenu(sock, app.message, app.chatId, app.userIds, {
    title: view.title,
    subtitle: view.subtitle,
    text: view.text,
    footer: view.footer,
    options,
    cancelLabel: 'Close',
  });

/** Run an app until the user exits, cancels, times out, or the tenant goes offline. */
export async function runApp(app: AppCtx, screens: ScreenMap, start: string, opts: RunOptions = {}): Promise<void> {
  const key = `${app.ctx.id}|${app.chatId}`;
  const token = Symbol('app');
  activeApps.get(key)?.abort();
  activeApps.set(key, { token, abort: () => app.cancelAsk?.() });
  try {
    await runLoop(app, screens, start, opts, () => activeApps.get(key)?.token === token);
  } finally {
    if (activeApps.get(key)?.token === token) activeApps.delete(key);
  }
}

async function runLoop(app: AppCtx, screens: ScreenMap, start: string, opts: RunOptions, isCurrent: () => boolean): Promise<void> {
  const prompt = opts.prompt ?? defaultPrompt;
  const stack: Array<{ name: string; params: unknown }> = [{ name: start, params: undefined }];

  for (let step = 0; step < MAX_STEPS && stack.length > 0; step++) {
    if (!isCurrent()) return;
    const { name, params } = stack[stack.length - 1];
    const screen = screens[name];
    if (!screen) throw new Error(`unknown screen "${name}"`);

    let sock: any;
    try {
      sock = app.ctx.getSock(); // live socket each step, so a reconnect mid-session doesn't strand us
    } catch {
      return; // tenant went offline; nothing to talk to
    }

    const view = await screen.view(app, params);
    const withNotice = app.notice ? { ...view, text: `${app.notice}\n\n${view.text}` } : view;
    app.notice = undefined;

    const options = [...view.options];
    if (stack.length > 1) options.push({ label: '⬅️ Back', value: BACK });

    const result = await prompt(sock, app, withNotice, options);
    if (!isCurrent()) return; // a newer session took over while we were waiting; stay quiet
    if (result.timedOut || result.cancelled || result.value === null) {
      if (result.timedOut) await sock.sendMessage(app.chatId, { text: '⌛ Menu closed (no response).' }).catch(() => undefined);
      return;
    }
    if (result.value === BACK) {
      stack.pop();
      continue;
    }
    if (result.value === EXIT) return;

    const nav = await screen.select(result.value, app, params);
    if (!isCurrent()) return; // replaced while we were busy (e.g. a question was cancelled): do nothing more
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
        if (nav.notice) app.notice = nav.notice;
        break;
      case 'exit':
        if (nav.message) await app.ctx.getSock().sendMessage(app.chatId, { text: nav.message }).catch(() => undefined);
        return;
    }
  }
}

// ── typed replies ───────────────────────────────────────────────────────────

export interface AskOptions<T> {
  prompt: string;
  /** Return the parsed value, or null if the reply isn't acceptable. */
  parse: (text: string) => T | null;
  /** Shown when a reply can't be parsed. */
  hint?: string;
  attempts?: number;
  timeoutMs?: number;
}

/**
 * Ask a question in free text and wait for the answer from the same person. The answer can be a
 * swipe-reply to the question OR simply typed in the same chat (the owner's own chat counts
 * whether WhatsApp addresses it by phone number or LID). Returns null on cancel, timeout, or
 * after too many unusable answers.
 */
export async function askValue<T>(app: AppCtx, o: AskOptions<T>): Promise<T | null> {
  const attempts = o.attempts ?? 3;
  const timeoutMs = o.timeoutMs ?? 2 * 60_000;
  const allowed = new Set(app.userIds);

  for (let attempt = 1; attempt <= attempts; attempt++) {
    let sock: any;
    try {
      sock = app.ctx.getSock();
    } catch {
      return null;
    }
    const prompt = await sock.sendMessage(app.chatId, { text: renderAsk(o.prompt, timeoutMs) }, app.message ? { quoted: app.message } : undefined);
    const promptId: string | undefined = prompt?.key?.id;
    const here = chatKey(sock, app.chatId);

    const reply = await new Promise<string | null>((resolve) => {
      const done = (v: string | null) => {
        clearTimeout(timer);
        sock.ev.off('messages.upsert', onUpsert);
        if (app.cancelAsk === cancel) app.cancelAsk = undefined;
        resolve(v);
      };
      const cancel = () => done(null);
      app.cancelAsk = cancel;
      const onUpsert = (upsert: any) => {
        if (upsert?.type !== 'notify') return;
        for (const msg of upsert.messages ?? []) {
          if (!msg?.message) continue;
          const text = plainTextOf(msg.message)?.trim();
          if (!text) continue;
          if (!allowed.has(senderOf(sock, msg))) continue;
          const quoted = promptId !== undefined && quotedIdOf(msg.message) === promptId;
          if (!quoted && chatKey(sock, msg.key?.remoteJid) !== here) {
            warnOnce(`ask:${msg.key?.remoteJid}`, `[ask] ignored a reply from the right person in a different chat (${msg.key?.remoteJid} vs ${app.chatId}). Swipe-reply the question, or tell the developer.`);
            continue;
          }
          return done(text);
        }
      };
      const timer = setTimeout(() => done(null), timeoutMs);
      timer.unref();
      sock.ev.on('messages.upsert', onUpsert);
    });

    if (reply === null || /^cancel$/i.test(reply)) return null;
    const parsed = o.parse(reply);
    if (parsed !== null) return parsed;
    if (attempt < attempts) {
      await app.ctx.getSock().sendMessage(app.chatId, { text: `❌ ${o.hint ?? "I couldn't read that."} Try again.` }).catch(() => undefined);
    }
  }
  return null;
}

export const askText = (app: AppCtx, prompt: string, maxLen = 200) =>
  askValue<string>(app, { prompt, parse: (t) => (t.length <= maxLen ? t : null), hint: `Keep it under ${maxLen} characters.` });

/** A number, e.g. "15" or "12.5", within [min, max]. */
export const askNumber = (app: AppCtx, prompt: string, min: number, max: number) =>
  askValue<number>(app, {
    prompt,
    hint: `Send a number between ${min} and ${max}.`,
    parse: (t) => {
      const n = Number(t.replace(/[,%\s]/g, ''));
      return Number.isFinite(n) && n >= min && n <= max ? n : null;
    },
  });
