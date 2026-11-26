import http from 'node:http';
import { config } from './config.js';
import { notifyAdmin } from './core/adminNotify.js';
import { rssMb, startMemoryGuard } from './core/memoryGuard.js';
import { PluginHost } from './core/pluginHost.js';
import { SessionManager } from './core/sessionManager.js';
import { registerPromptListener } from './ui/menuSession.js';
const sessions = new SessionManager();
const host = new PluginHost({ sessions });
host.bind(sessions);
// Menu taps must be heard on every socket, including after a reconnect.
sessions.on('socket', (_ctx, sock) => registerPromptListener(sock));
// A new customer's pairing code goes to the admin's own chat (and the console as a fallback).
sessions.on('pairingCode', async (ctx, code) => {
    const line = `🔗 Pairing code for *${ctx.id}* (${ctx.tenant.number}): *${code}*\nOn their phone: WhatsApp → Linked devices → Link with phone number.`;
    console.log(`[pairing] ${ctx.id}: ${code}`);
    await notifyAdmin(sessions, line);
});
sessions.on('halted', async (ctx, why) => {
    console.warn(`[halted] ${ctx.id}: ${why}`);
    await notifyAdmin(sessions, `⚠️ *${ctx.id}* stopped: ${why}.`);
});
// ── Health endpoint (for the host's health check; exposes no phone numbers) ──
const server = http.createServer((req, res) => {
    if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, rssMb: rssMb(), sessions: sessions.list().map((c) => ({ id: c.id, state: c.state })) }));
        return;
    }
    res.writeHead(404).end();
});
server.listen(config.port, () => console.log(`[server] listening on ${config.port}`));
// ── Shutdown ────────────────────────────────────────────────────────────────
let shuttingDown = false;
async function shutdown(code) {
    if (shuttingDown)
        return;
    shuttingDown = true;
    console.log('[shutdown] stopping sessions');
    await sessions.stopAll();
    server.close();
    setTimeout(() => process.exit(code), 1_500).unref();
}
process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));
// Log and carry on: one tenant's bug shouldn't take every customer down.
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));
// ── Boot ────────────────────────────────────────────────────────────────────
await host.loadFromDir(new URL('./plugins/', import.meta.url));
startMemoryGuard({
    onPressure: (under) => sessions.setAdmission(!under),
    onCritical: () => shutdown(1), // non-zero exit so the host restarts the process
});
setInterval(() => void sessions.enforcePlans(), config.planSweepMs).unref();
await sessions.startAll();
