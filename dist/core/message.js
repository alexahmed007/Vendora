import { getContentType, jidNormalizedUser, normalizeMessageContent } from '@whiskeysockets/baileys';
import { config } from '../config.js';
import { cleanJid, ownIdsOf } from './jid.js';
const textOf = (c) => c?.conversation ||
    c?.extendedTextMessage?.text ||
    c?.imageMessage?.caption ||
    c?.videoMessage?.caption ||
    c?.documentMessage?.caption ||
    '';
const tsOf = (raw) => {
    const t = raw?.messageTimestamp;
    const n = typeof t === 'object' && t !== null ? Number(t.low ?? t.toString()) : Number(t);
    return Number.isFinite(n) && n > 0 ? n * 1000 : Date.now();
};
/** Build an IncomingMessage, or null for things plugins never need (protocol / empty messages). */
export async function buildIncoming(ctx, sock, services, raw, isCatchUp) {
    const key = raw?.key;
    if (!key?.id || !key.remoteJid || !raw.message)
        return null;
    const content = normalizeMessageContent(raw.message);
    if (!content)
        return null;
    const type = getContentType(content) ?? '';
    if (type === 'protocolMessage' || type === 'senderKeyDistributionMessage')
        return null;
    const chatId = key.remoteJid;
    const fromMe = Boolean(key.fromMe);
    const ownJid = sock?.user?.id ? jidNormalizedUser(sock.user.id) : `${ctx.tenant.number}@s.whatsapp.net`;
    const senderJid = fromMe ? ownJid : key.participant || chatId;
    const senderPn = fromMe ? ownJid : await ctx.resolvePn(senderJid);
    const userIds = [...new Set([cleanJid(senderPn), cleanJid(senderJid)].filter(Boolean))];
    const isOwner = fromMe || ctx.isOwnerJid(senderPn ?? senderJid);
    const isPlatformAdmin = isOwner && config.adminNumber !== '' && ctx.tenant.number === config.adminNumber;
    const isOwnChat = !chatId.endsWith('@g.us') && (cleanJid(chatId) === cleanJid(ownJid) || ownIdsOf(sock).includes(cleanJid(chatId)));
    const quotedId = content[type]?.contextInfo?.stanzaId ?? null;
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
        ownChatId: ownJid,
        isOwnChat,
        reply: (text, extra) => ctx.getSock().sendMessage(chatId, { text, ...extra }, { quoted: raw }),
        replyPrivate: (text) => isOwnChat
            ? ctx.getSock().sendMessage(ownJid, { text }, { quoted: raw })
            : ctx.getSock().sendMessage(ownJid, { text }),
    };
}
