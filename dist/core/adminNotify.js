import { config } from '../config.js';
/**
 * Send a message to the platform admin's own chat through the control tenant (the session whose
 * number is ADMIN_NUMBER). Returns false when that session isn't online, so callers can fall back
 * to the console.
 */
export async function notifyAdmin(sessions, text) {
    if (!config.adminNumber)
        return false;
    const control = sessions.list().find((c) => c.tenant.number === config.adminNumber && c.online);
    if (!control)
        return false;
    try {
        await control.getSock().sendMessage(`${config.adminNumber}@s.whatsapp.net`, { text });
        return true;
    }
    catch (err) {
        control.log.error(`admin notice failed: ${err.message}`);
        return false;
    }
}
