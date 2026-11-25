import { createRequire } from 'node:module';
import { config } from '../config.js';
import { cleanJid } from '../core/jid.js';

/**
 * Menu prompts that await the user's choice. Ported from the old bot's buttonSession.ts, keeping
 * the shapes confirmed there (quick-reply buttons for <=2 options, dropdown list otherwise, all
 * options as quick-reply buttons for iPhones) and adding:
 *  - numbered-text mode ("reply 2"), which needs no button support at all
 *  - every message in an upsert batch is checked, not just the first
 *  - the owner's own taps/replies count (the bot IS the owner's account)
 *  - an injectable transport, so the flow can be tested without WhatsApp
 *
 * NOTE: these prompts wait up to a few minutes, so they suit the owner's dashboard. Buttons on
 * posts that customers tap later need stateless ids handled in a plugin's onMessage instead.
 */

const require = createRequire(import.meta.url);

export interface MenuOption {
  label: string;
  value: string;
  /** Only shown in the dropdown and numbered paths; quick-reply buttons have no room for it. */
  description?: string;
}

export interface MenuPromptConfig {
  title?: string;
  subtitle?: string;
  text: string;
  options: MenuOption[];
  footer?: string;
  ttlMs?: number;
  cancelLabel?: string;
}

export interface MenuResult {
  value: string | null;
  timedOut: boolean;
  cancelled: boolean;
}

// ── transport (real = gifted-btns; tests replace it) ───────────────────────

export interface MenuTransport {
  sendButtons(sock: any, chatId: string, p: { text: string; footer: string; buttons: Array<{ id: string; text: string }> }, opts: any): Promise<any>;
  sendList(sock: any, chatId: string, p: { text: string; footer: string; title: string; rows: Array<{ id: string; title: string; description?: string }> }, opts: any): Promise<any>;
}

let gifted: any = null;
const loadGifted = () => (gifted ??= require('gifted-btns'));

let transport: MenuTransport = {
  sendButtons: (sock, chatId, p, opts) => loadGifted().sendButtons(sock, chatId, p, opts),
  sendList: (sock, chatId, p, opts) =>
    loadGifted().sendInteractiveMessage(
      sock,
      chatId,
      {
        text: p.text,
        footer: p.footer,
        interactiveButtons: [
          { name: 'single_select', buttonParamsJson: JSON.stringify({ title: p.title, sections: [{ title: 'Options', rows: p.rows }] }) },
        ],
      },
      opts,
    ),
};

export function setMenuTransport(t: MenuTransport): void {
  transport = t;
}

// ── state ───────────────────────────────────────────────────────────────────

const DEFAULT_TTL_MS = 3 * 60_000;
const QUICK_REPLY_MAX_TOTAL_BUTTONS = 3; // cancel counts, so <=2 options stay on the confirmed path

interface Pending {
  chatId: string;
  userIds: Set<string>;
  options: MenuOption[];
  numbered: boolean;
  resolve: (r: MenuResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, Pending>();           // keyed by the sent menu message's id
const numberedByUser = new Map<string, string>();      // `${chatId}|${userId}` -> latest numbered menu id
const registeredSocks = new WeakSet<object>();

const iosOverrides = new Map<string, boolean>();
export function setIosMode(userId: string, on: boolean | null): void {
  if (on === null) iosOverrides.delete(userId);
  else iosOverrides.set(userId, on);
}

/** iPhones never render the dropdown, so they get every option as quick-reply buttons. Heuristic on the message id shape. */
function prefersButtons(message: any, userIds: string[]): boolean {
  for (const id of userIds) {
    if (config.forceButtonUsers.includes(id)) return true;
    const forced = iosOverrides.get(id);
    if (forced !== undefined) return forced;
  }
  return /^[0-9A-F]{20}$/.test(message?.key?.id || '');
}

// ── reading replies ─────────────────────────────────────────────────────────

const contextInfoOf = (m: any): any =>
  m?.templateButtonReplyMessage?.contextInfo ||
  m?.buttonsResponseMessage?.contextInfo ||
  m?.listResponseMessage?.contextInfo ||
  m?.interactiveResponseMessage?.contextInfo ||
  m?.extendedTextMessage?.contextInfo ||
  null;

function selectedIdOf(m: any): string | null {
  if (m?.templateButtonReplyMessage?.selectedId) return m.templateButtonReplyMessage.selectedId;
  if (m?.buttonsResponseMessage?.selectedButtonId) return m.buttonsResponseMessage.selectedButtonId;
  if (m?.listResponseMessage?.singleSelectReply?.selectedRowId) return m.listResponseMessage.singleSelectReply.selectedRowId;
  const params = m?.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson;
  if (params) {
    try {
      const parsed = JSON.parse(params);
      if (parsed?.id) return parsed.id;
    } catch {
      // not JSON
    }
  }
  return null;
}

const plainTextOf = (m: any): string | null => m?.extendedTextMessage?.text ?? m?.conversation ?? null;

/** Who sent it. The owner's own messages (fromMe) carry no participant, so use the account's own id. */
function senderOf(sock: any, msg: any): string {
  return msg.key?.fromMe ? cleanJid(sock?.user?.id) : cleanJid(msg.key?.participant || msg.key?.remoteJid);
}

function settle(menuId: string, p: Pending, result: MenuResult): void {
  clearTimeout(p.timer);
  pending.delete(menuId);
  for (const uid of p.userIds) {
    const k = `${p.chatId}|${uid}`;
    if (numberedByUser.get(k) === menuId) numberedByUser.delete(k);
  }
  p.resolve(result);
}

function resolveSelection(menuId: string, p: Pending, selected: string): void {
  if (selected === 'cancel') return settle(menuId, p, { value: null, timedOut: false, cancelled: true });
  const idx = /^opt_(\d+)$/.exec(selected) ? parseInt(selected.slice(4), 10) : NaN;
  if (Number.isNaN(idx) || idx < 0 || idx >= p.options.length) return; // unknown id: ignore, don't consume
  settle(menuId, p, { value: p.options[idx].value, timedOut: false, cancelled: false });
}

function handleOne(sock: any, msg: any): void {
  if (!msg?.message) return;
  const sender = senderOf(sock, msg);
  const m = msg.message;
  if (config.menuDebug && pending.size > 0) {
    console.log(`[buttonSession:debug] upsert while a menu is pending · fromMe=${Boolean(msg.key?.fromMe)} · sender=${sender} · type=${Object.keys(m).join(',')}`);
  }

  // 1) A tap or quoted reply to one specific menu.
  const quotedId = contextInfoOf(m)?.stanzaId;
  const quoted = quotedId ? pending.get(quotedId) : undefined;
  if (quoted && quotedId && quoted.userIds.has(sender)) {
    const selected = selectedIdOf(m);
    if (selected) return resolveSelection(quotedId, quoted, selected);

    if (quoted.numbered) {
      const n = parseReplyNumber(plainTextOf(m));
      if (n !== null) return resolveSelection(quotedId, quoted, n === 0 ? 'cancel' : `opt_${n - 1}`);
    }
    console.warn('[buttonSession] a reply targets a pending menu but no choice could be read. Raw message:', JSON.stringify(m));
    return;
  }

  // 2) A bare number typed in the same chat, for numbered menus.
  const text = plainTextOf(m);
  const n = parseReplyNumber(text);
  if (n === null || !msg.key?.remoteJid) return;
  const menuId = numberedByUser.get(`${msg.key.remoteJid}|${sender}`);
  const prompt = menuId ? pending.get(menuId) : undefined;
  if (menuId && prompt) resolveSelection(menuId, prompt, n === 0 ? 'cancel' : `opt_${n - 1}`);
}

function parseReplyNumber(text: string | null): number | null {
  if (text === null) return null;
  const t = text.trim();
  if (/^cancel$/i.test(t)) return 0;
  return /^\d{1,2}$/.test(t) ? parseInt(t, 10) : null;
}

/** Call once per socket (the plugin host does this) so taps still land after a reconnect. */
export function registerPromptListener(sock: any): void {
  if (registeredSocks.has(sock)) return;
  registeredSocks.add(sock);
  sock.ev.on('messages.upsert', (upsert: any) => {
    if (upsert?.type !== 'notify') return;
    for (const msg of upsert.messages ?? []) {
      try {
        handleOne(sock, msg);
      } catch (err) {
        console.error('[buttonSession] listener error:', err);
      }
    }
  });
}

// ── prompting ───────────────────────────────────────────────────────────────

const ownIds = (sock: any): string[] => [cleanJid(sock?.user?.id), cleanJid(sock?.user?.lid)].filter(Boolean);
const isSelfChat = (sock: any, chatId: string): boolean => ownIds(sock).includes(cleanJid(chatId));

/**
 * The bot IS the owner's WhatsApp account. Buttons are for the *recipient* of a message, so the
 * account's own owner can't use buttons on menus their own account sent (in their own chat or in
 * a group): they show up but do nothing. Whenever the owner is the one who must answer, use
 * numbered text. Buttons stay for other people (customers) answering the reseller's account.
 */
const answeredByOwner = (sock: any, ids: string[]): boolean => {
  const own = ownIds(sock);
  return ids.some((id) => own.includes(id));
};

function numberedText(body: string, options: MenuOption[], cancelLabel: string, minutes: number): string {
  const lines = options.map((o, i) => `*${i + 1}.* ${o.label}${o.description ? ` — ${o.description}` : ''}`);
  return `${body}\n\n${lines.join('\n')}\n*0.* ${cancelLabel}\n\n_Reply with a number · expires in ${minutes} min_`;
}

/**
 * Show a menu and wait for a choice.
 * @param userIds who may answer (phone and lid forms); anyone else's taps are ignored, not consumed.
 */
export async function promptMenu(
  sock: any,
  message: any,
  chatId: string,
  userIds: string | string[],
  cfg: MenuPromptConfig,
): Promise<MenuResult> {
  registerPromptListener(sock);

  const ids = (Array.isArray(userIds) ? userIds : [userIds]).filter(Boolean);
  const ttlMs = cfg.ttlMs ?? DEFAULT_TTL_MS;
  const cancelLabel = cfg.cancelLabel || '❌ Cancel';
  const minutes = Math.max(1, Math.round(ttlMs / 60_000));
  const footer = cfg.footer || `Expires in ${minutes} min${minutes === 1 ? '' : 's'}`;

  const head: string[] = [];
  if (cfg.title) head.push(`*${cfg.title}*`);
  if (cfg.subtitle) head.push(`_${cfg.subtitle}_`);
  head.push(cfg.text);
  const body = head.join('\n');

  const numbered =
    config.menuMode === 'numbered' ||
    (config.menuMode === 'auto' && (isSelfChat(sock, chatId) || answeredByOwner(sock, ids)));
  const opts = { quoted: message };
  let sent: any;
  let textMode = numbered; // true when the menu went out as plain numbered text

  if (numbered) {
    sent = await sock.sendMessage(chatId, { text: numberedText(body, cfg.options, cancelLabel, minutes) }, opts);
  } else {
    const quickReply = cfg.options.length + 1 <= QUICK_REPLY_MAX_TOTAL_BUTTONS;
    const asButtons = quickReply || prefersButtons(message, ids);
    try {
      if (asButtons) {
        const buttons = cfg.options.map((o, i) => ({ id: `opt_${i}`, text: o.label }));
        buttons.push({ id: 'cancel', text: cancelLabel });
        const described = cfg.options.filter((o) => o.description);
        const text = !quickReply && described.length ? `${body}\n\n${described.map((o) => `• ${o.label} — ${o.description}`).join('\n')}` : body;
        sent = await transport.sendButtons(sock, chatId, { text, footer, buttons }, opts);
      } else {
        const rows: Array<{ id: string; title: string; description?: string }> = cfg.options.map((o, i) => ({ id: `opt_${i}`, title: o.label, description: o.description }));
        rows.push({ id: 'cancel', title: cancelLabel });
        sent = await transport.sendList(sock, chatId, { text: body, footer, title: cfg.title || 'Choose an option', rows }, opts);
      }
    } catch (err) {
      // Transport problem: fall back to plain numbered text rather than leaving the user with nothing.
      console.warn(`[buttonSession] buttons failed (${(err as Error).message}); falling back to numbered text`);
      textMode = true;
      sent = await sock.sendMessage(chatId, { text: numberedText(body, cfg.options, cancelLabel, minutes) }, opts);
    }
  }

  const menuId: string | undefined = sent?.key?.id;
  return new Promise<MenuResult>((resolve) => {
    if (!menuId) return resolve({ value: null, timedOut: true, cancelled: false }); // nothing to key a reply to: fail closed
    const timer = setTimeout(() => {
      const p = pending.get(menuId);
      if (p) settle(menuId, p, { value: null, timedOut: true, cancelled: false });
    }, ttlMs);
    timer.unref();
    // Taps are always matched by the menu's message id. Typed numbers are only accepted for menus
    // that were sent as numbered text.
    pending.set(menuId, { chatId, userIds: new Set(ids), options: cfg.options, numbered: textMode, resolve, timer });
    if (textMode) for (const uid of ids) numberedByUser.set(`${chatId}|${uid}`, menuId);
  });
}
