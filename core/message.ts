import { getContentType, jidNormalizedUser, normalizeMessageContent } from '@whiskeysockets/baileys';
import { config } from '../src/config.js';
import { cleanJid } from './jid.js';
import type { Services } from './plugin.js';
import type { TenantContext } from './tenantContext.js';

export interface IncomingMessage {
  ctx: TenantContext;
  /** The socket that received it. For replies later on, prefer ctx.getSock(). */
  sock: any;
  services: Services;
  /** The original WAMessage (its `.message` may still be wrapped; use `content` for the unwrapped body). */
  raw: any;
  /** Unwrapped content (ephemeral / view-once / caption wrappers removed). */
  content: any;
  /** Content type key: 'conversation', 'extendedTextMessage', 'imageMessage', 'videoMessage', ... */
  type: string;
  id: string;
  chatId: string;
  isGroup: boolean;
  isStatus: boolean;
  fromMe: boolean;
  /** Sender JID exactly as WhatsApp gave it (may be an @lid). */
  senderJid: string;
  /** Sender as a phone-number JID when it could be resolved. */
  senderPn: string | null;
  /** Digits-only identity: the resolved phone number if known, else the raw id. Fromme = own number. */
  userId: string;
  /** Every id this sender may appear under (phone and lid), for matching replies. */
  userIds: string[];
  pushName: string;
  /** Text or caption, '' when there is none. */
  text: string;
  /** Message id this one replies to, if any. */
  quotedId: string | null;
  timestamp: number;
  /** Delivered while the bot was offline (arrived as "append"). Don't auto-reply to old ones. */
  isCatchUp: boolean;
  isOwner: boolean;
  /** True only for the owner of the control tenant (config.adminNumber). */
  isPlatformAdmin: boolean;
  reply(text: string, extra?: Record<string, unknown>): Promise<any>;
}

const textOf = (c: any): string =>
  c?.conversation ||
  c?.extendedTextMessage?.text ||
  c?.imageMessage?.caption ||
  c?.videoMessage?.caption ||
  c?.documentMessage?.caption ||
  '';

const tsOf = (raw: any): number => {
  const t = raw?.messageTimestamp;
  const n = typeof t === 'object' && t !== null ? Number(t.low ?? t.toString()) : Number(t);
  return Number.isFinite(n) && n > 0 ? n * 1000 : Date.now();
};

/** Build an IncomingMessage, or null for things plugins never need (protocol / empty messages). */
export async function buildIncoming(
  ctx: TenantContext,
  sock: any,
  services: Services,
  raw: any,
  isCatchUp: boolean,
): Promise<IncomingMessage | null> {
  const key = raw?.key;
  if (!key?.id || !key.remoteJid || !raw.message) return null;

  const content = normalizeMessageContent(raw.message);
  if (!content) return null;
  const type = getContentType(content) ?? '';
  if (type === 'protocolMessage' || type === 'senderKeyDistributionMessage') return null;

  const chatId: string = key.remoteJid;
  const fromMe = Boolean(key.fromMe);
  const ownJid: string = sock?.user?.id ? jidNormalizedUser(sock.user.id) : `${ctx.tenant.number}@s.whatsapp.net`;
  const senderJid: string = fromMe ? ownJid : key.participant || chatId;
  const senderPn = fromMe ? ownJid : await ctx.resolvePn(senderJid);
  const userIds = [...new Set([cleanJid(senderPn), cleanJid(senderJid)].filter(Boolean))];

  const isOwner = fromMe || ctx.isOwnerJid(senderPn ?? senderJid);
  const isPlatformAdmin = isOwner && config.adminNumber !== '' && ctx.tenant.number === config.adminNumber;
  const quotedId: string | null = (content as any)[type]?.contextInfo?.stanzaId ?? null;

  return {
    ctx,
    sock,
    services,
    raw,
    content,
    type,
    id: key.id,
    chatId,
    isGroup: chatId.endsWith('@g.us'),
    isStatus: chatId === 'status@broadcast',
    fromMe,
    senderJid,
    senderPn,
    userId: userIds[0] ?? '',
    userIds,
    pushName: raw.pushName ?? '',
    text: textOf(content),
    quotedId,
    timestamp: tsOf(raw),
    isCatchUp,
    isOwner,
    isPlatformAdmin,
    reply: (text, extra) => ctx.getSock().sendMessage(chatId, { text, ...extra }, { quoted: raw }),
  };
}
