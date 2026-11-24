import http from 'node:http';
import { config } from './config.js';
import { SessionManager } from './core/sessionManager.js';
import { startMemoryGuard, rssMb } from './core/memoryGuard.js';
import type { TenantContext } from './core/tenantContext.js';

const sessions = new SessionManager();

// ── Stage-1 test router ─────────────────────────────────────────────────────
// Just enough to verify a linked number end to end: the owner sends "<prefix>ping".
// Stage 2 replaces this with the real router (all-message loop, plugin hooks, menus).
sessions.on('socket', (ctx: TenantContext, sock: any) => {
  sock.ev.on('messages.upsert', async ({ messages, type }: any) => {
    if (type !== 'notify') return;
    for (const m of messages) { // every message in the batch, not just messages[0]
      if (!m?.message || !m.key?.id) continue;
      if (!ctx.firstSight(m.key.id)) continue; // per-tenant dedupe

      const text: string = m.message.conversation || m.message.extendedTextMessage?.text || '';
      if (text.trim().toLowerCase() !== `${config.prefix}ping`) continue;

      const sender = m.key.participant || m.key.remoteJid;
      if (!m.key.fromMe && !ctx.isOwnerJid(sender)) continue;

      await sock
        .sendMessage(m.key.remoteJid, { text: `pong · ${ctx.id} · ${rssMb()}MB` }, { quoted: m })
        .catch((e: Error) => ctx.log.error(`ping reply failed: ${e.message}`));
    }
  });
});

sessions.on('pairingCode', (ctx: TenantContext, code: string) => {
  // Stage 2 sends this through an admin chat. For now it goes to the console.
  console.log(`[pairing] ${ctx.id} (${ctx.tenant.number}) → WhatsApp > Linked devices > Link with phone number > ${code}`);
});
sessions.on('halted', (ctx: TenantContext, why: string) => {
  console.warn(`[halted] ${ctx.id}: ${why}`);
});

// ── Health endpoint (for the host's health check; exposes no phone numbers) ──
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      rssMb: rssMb(),
      sessions: sessions.list().map((c) => ({ id: c.id, state: c.state })),
    }));
    return;
  }
  res.writeHead(404).end();
});
server.listen(config.port, () => console.log(`[server] listening on ${config.port}`));

// ── Shutdown ────────────────────────────────────────────────────────────────
let shuttingDown = false;
async function shutdown(code: number): Promise<void> {
  if (shuttingDown) return;
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
startMemoryGuard({
  onPressure: (under) => sessions.setAdmission(!under),
  onCritical: () => shutdown(1), // non-zero exit so the host restarts the process
});

setInterval(() => void sessions.enforcePlans(), config.planSweepMs).unref();

await sessions.startAll();
