import { chatKey, cleanJid, ownIdsOf } from '../core/jid.js';

/**
 * Numbered menus ("reply with a number"), in the clean USSD style from the old bot's menuSession:
 * keycap digits, divider lines, a title/subtitle, optional description lines, and a nudge when the
 * reply isn't a valid choice.
 *
 * Differences from the old module, for this bot (where the bot IS the reseller's own account):
 *  - the owner's own messages count (they are `fromMe`)
 *  - every message in a batch is checked, not only the first
 *  - a reply works two ways: swipe-reply the menu, OR just type the number in the same chat
 *  - the owner's own chat is matched whether WhatsApp calls it by phone number or by LID
 *
 * Prompts wait a few minutes, so they suit dashboards and wizards. Stateless replies (a customer
 * answering a post hours later) belong in a plugin's onMessage instead.
 */

export interface MenuOption {
  label: string;
  value: string;
  /** Short line under the option. */
  description?: string;
}

export interface MenuPromptConfig {
  title?: string;
  subtitle?: string;
  text: string;
  options: MenuOption[];
  footer?: string;
  ttlMs?: number;
  /** Label for the 0 line. Default "Cancel". */
  cancelLabel?: string;
}

export interface MenuResult {
  value: string | null;
  timedOut: boolean;
  cancelled: boolean;
}

const DEFAULT_TTL_MS = 3 * 60_000;
const DIVIDER = '┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄';
const KEYCAPS = ['0️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣'];
const keycap = (n: number): string => String(n).split('').map((d) => KEYCAPS[Number(d)] ?? d).join('');
const minutesOf = (ms: number) => Math.max(1, Math.round(ms / 60_000));
const plural = (n: number) => `${n} min${n === 1 ? '' : 's'}`;

/** The menu as text. Exported so the look can be tested. */
export function renderMenu(cfg: MenuPromptConfig, ttlMs: number): string {
  const lines: string[] = [];
  if (cfg.title) lines.push(`*${cfg.title}*`);
  if (cfg.subtitle) lines.push(`_${cfg.subtitle}_`);
  if (cfg.title || cfg.subtitle) lines.push(DIVIDER);
  lines.push(cfg.text, '');
  cfg.options.forEach((o, i) => {
    lines.push(`${keycap(i + 1)}  *${o.label}*`);
    if (o.description) lines.push(`     ${o.description}`);
  });
  lines.push('', DIVIDER);
  if (cfg.footer) lines.push(cfg.footer);
  lines.push('↩️ _Reply to this message with a number_');
  lines.push(`${keycap(0)} ${cfg.cancelLabel || 'Cancel'}   ⏳ Expires in ${plural(minutesOf(ttlMs))}`);
  return lines.join('\n');
}

/** A free-text question in the same style. Used by askValue (src/ui/appUi.ts). */
export function renderAsk(prompt: string, ttlMs: number): string {
  return [`✏️ ${prompt}`, DIVIDER, '↩️ _Reply to this message with your answer_', `Send *cancel* to stop   ⏳ Expires in ${plural(minutesOf(ttlMs))}`].join('\n');
}

// ── reading messages (shared with appUi) ────────────────────────────────────

export function quotedIdOf(m: any): string | null {
  return (
    m?.extendedTextMessage?.contextInfo?.stanzaId ||
    m?.buttonsResponseMessage?.contextInfo?.stanzaId ||
    m?.listResponseMessage?.contextInfo?.stanzaId ||
    m?.templateButtonReplyMessage?.contextInfo?.stanzaId ||
    null
  );
}

export const plainTextOf = (m: any): string | null => m?.conversation || m?.extendedTextMessage?.text || null;

/** Who sent it. The owner's own messages (fromMe) carry no participant, so use the account's own id. */
export function senderOf(sock: any, msg: any): string {
  return msg.key?.fromMe ? cleanJid(sock?.user?.id) : cleanJid(msg.key?.participant || msg.key?.remoteJid);
}

const lastWarn = new Map<string, number>();
/** Log a problem at most once every 15s per key, so a stuck chat can't flood the log. */
export function warnOnce(key: string, message: string): void {
  const now = Date.now();
  if (now - (lastWarn.get(key) ?? 0) < 15_000) return;
  lastWarn.set(key, now);
  console.warn(message);
}

// ── pending menus ───────────────────────────────────────────────────────────

interface Pending {
  chatId: string;
  key: string;                 // chatKey(...) of the chat, for plain-number replies
  userIds: Set<string>;
  options: MenuOption[];
  resolve: (r: MenuResult) => void;
  timer: ReturnType<typeof setTimeout>;
  lastNudge: number;
}

const pending = new Map<string, Pending>();       // by the sent menu message's id
const latest = new Map<string, string>();          // `${chatKey}|${user}` -> newest menu id
const registered = new WeakSet<object>();

function settle(menuId: string, p: Pending, result: MenuResult): void {
  clearTimeout(p.timer);
  pending.delete(menuId);
  for (const uid of p.userIds) {
    const k = `${p.key}|${uid}`;
    if (latest.get(k) === menuId) latest.delete(k);
  }
  p.resolve(result);
}

function interpret(sock: any, menuId: string, p: Pending, text: string): void {
  const t = text.trim().toLowerCase();
  if (t === '0' || t === 'cancel') return settle(menuId, p, { value: null, timedOut: false, cancelled: true });

  const n = /^\d{1,2}$/.test(t) ? parseInt(t, 10) : NaN;
  if (n >= 1 && n <= p.options.length) return settle(menuId, p, { value: p.options[n - 1].value, timedOut: false, cancelled: false });

  // Aimed at this menu but not a valid choice: nudge, and keep waiting.
  const now = Date.now();
  if (now - p.lastNudge < 3_000) return;
  p.lastNudge = now;
  void sock.sendMessage(p.chatId, { text: `❓ Reply with a number from *1* to *${p.options.length}* (or *0* to close).` }).catch(() => undefined);
}

function handleOne(sock: any, msg: any, debug: boolean): void {
  if (!msg?.message) return;
  const sender = senderOf(sock, msg);
  const m = msg.message;
  const text = plainTextOf(m)?.trim() ?? null;
  const quotedId = quotedIdOf(m);
  if (debug && pending.size > 0) {
    console.log(`[menu:debug] message while a menu is pending · fromMe=${Boolean(msg.key?.fromMe)} · chat=${msg.key?.remoteJid} · sender=${sender} · quoted=${quotedId ?? '-'} · text=${text ?? '(none)'}`);
  }

  // 1) A reply that quotes one specific menu.
  const target = quotedId ? pending.get(quotedId) : undefined;
  if (target && quotedId) {
    if (!target.userIds.has(sender)) return; // right menu, wrong person: ignore, don't consume
    if (text) interpret(sock, quotedId, target, text);
    return;
  }

  // 2) A bare number (or "cancel") typed in the same chat, for the newest menu waiting on this person.
  if (!text || !/^(\d{1,2}|cancel)$/i.test(text) || !msg.key?.remoteJid) return;
  const id = latest.get(`${chatKey(sock, msg.key.remoteJid)}|${sender}`);
  const p = id ? pending.get(id) : undefined;
  if (id && p) interpret(sock, id, p, text);
}

/** Call once per socket (the host does this) so replies are heard on every connection. */
export function registerPromptListener(sock: any): void {
  if (registered.has(sock)) return;
  registered.add(sock);
  const debug = process.env.MENU_DEBUG === 'true';
  sock.ev.on('messages.upsert', (upsert: any) => {
    if (upsert?.type !== 'notify') return;
    for (const msg of upsert.messages ?? []) {
      try {
        handleOne(sock, msg, debug);
      } catch (err) {
        console.error('[menuSession] listener error:', err);
      }
    }
  });
}

/**
 * Show a menu and wait for a choice.
 * @param userIds who may answer (phone and lid forms). Anyone else's reply is ignored, not consumed.
 */
export async function promptMenu(sock: any, message: any, chatId: string, userIds: string | string[], cfg: MenuPromptConfig): Promise<MenuResult> {
  registerPromptListener(sock);
  const ids = (Array.isArray(userIds) ? userIds : [userIds]).filter(Boolean);
  const ttlMs = cfg.ttlMs ?? DEFAULT_TTL_MS;

  const sent = await sock.sendMessage(chatId, { text: renderMenu(cfg, ttlMs) }, message ? { quoted: message } : undefined);
  const menuId: string | undefined = sent?.key?.id;

  return new Promise<MenuResult>((resolve) => {
    if (!menuId) return resolve({ value: null, timedOut: true, cancelled: false }); // nothing to key a reply to: fail closed
    const timer = setTimeout(() => {
      const p = pending.get(menuId);
      if (p) settle(menuId, p, { value: null, timedOut: true, cancelled: false });
    }, ttlMs);
    timer.unref();
    const key = chatKey(sock, chatId);
    for (const uid of ids) {
      const older = latest.get(`${key}|${uid}`);
      const stale = older ? pending.get(older) : undefined;
      if (older && stale) settle(older, stale, { value: null, timedOut: false, cancelled: true }); // replaced by this newer menu
    }
    pending.set(menuId, { chatId, key, userIds: new Set(ids), options: cfg.options, resolve, timer, lastNudge: 0 });
    for (const uid of ids) latest.set(`${key}|${uid}`, menuId);
  });
}

export { ownIdsOf };
