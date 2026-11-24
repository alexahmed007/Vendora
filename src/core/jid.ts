/** "2348012345678:12@s.whatsapp.net" or "...@lid" -> "2348012345678" (the part before ':' and '@'). */
export const cleanJid = (jid: string | null | undefined): string =>
  (jid ?? '').split('@')[0].split(':')[0];
