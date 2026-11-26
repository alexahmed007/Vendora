/** "2348012345678:12@s.whatsapp.net" or "...@lid" -> "2348012345678" (the part before ':' and '@'). */
export const cleanJid = (jid) => (jid ?? '').split('@')[0].split(':')[0];
/** The account's own ids: phone number and (when WhatsApp gives one) its anonymous "LID". */
export const ownIdsOf = (sock) => [cleanJid(sock?.user?.id), cleanJid(sock?.user?.lid)].filter(Boolean);
/**
 * A comparable key for a chat. The owner's own "message yourself" chat can arrive addressed by
 * phone number OR by LID; both map to 'self' so replies are matched to the right prompt either way.
 * Groups and broadcasts are returned unchanged.
 */
export const chatKey = (sock, jid) => {
    const j = jid ?? '';
    if (j.endsWith('@g.us') || j.endsWith('@broadcast') || j.endsWith('@newsletter'))
        return j;
    return ownIdsOf(sock).includes(cleanJid(j)) ? 'self' : j;
};
