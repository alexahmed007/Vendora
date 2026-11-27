import { EventEmitter } from 'node:events';
import pino from 'pino';
import makeWASocket, { Browsers, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, } from '@whiskeysockets/baileys';
import { config } from '../config.js';
import { getTenant, listTenants, patchTenant, isRunnable } from '../store/tenants.js';
import { useStoreAuthState } from './dbAuthState.js';
import { controlFirst } from './bootstrap.js';
import { TenantContext } from './tenantContext.js';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/**
 * Runs one Baileys socket per tenant inside this process.
 *
 * Events (all carry the TenantContext):
 *   'socket'      (ctx, sock)  a fresh socket exists: attach your listeners here.
 *                              They are removed automatically when the socket is replaced.
 *   'online'      (ctx)        connected
 *   'closed'      (ctx, code)  connection dropped
 *   'pairingCode' (ctx, code)  show this to the customer to link their number
 *   'halted'      (ctx, why)   session stopped and will NOT auto-reconnect
 *   'released'    (ctx)        runtime removed (stop, halt or shutdown): clean up per-tenant timers
 */
export class SessionManager extends EventEmitter {
    runtimes = new Map();
    logger = pino({ level: config.logLevel });
    version;
    admitting = true;
    /** The memory guard closes admission when the process is near its limit. */
    setAdmission(open) {
        this.admitting = open;
    }
    get(tenantId) {
        return this.runtimes.get(tenantId)?.ctx;
    }
    list() {
        return [...this.runtimes.values()].map((r) => r.ctx);
    }
    /** Start every runnable tenant, staggered so boot doesn't spike CPU and RAM. */
    async startAll() {
        const all = await listTenants();
        const tenants = all.filter((t) => isRunnable(t));
        if (all.length === 0) {
            console.warn('[sessions] no tenants yet. Set ADMIN_NUMBER (your own number, country code first) and restart: the admin account is created automatically.');
        }
        else if (tenants.length === 0) {
            console.warn(`[sessions] ${all.length} tenant(s) found but none runnable (paused, expired or needs_relink). Check: npm run cli -- list`);
        }
        else {
            console.log(`[sessions] starting ${Math.min(tenants.length, config.maxSessions)} of ${tenants.length} runnable tenant(s)`);
        }
        const toStart = controlFirst(tenants).slice(0, config.maxSessions);
        if (tenants.length > toStart.length) {
            console.warn(`[sessions] ${tenants.length} runnable tenants but MAX_SESSIONS=${config.maxSessions}; the rest stay stopped`);
        }
        for (const tenant of toStart) {
            await this.start(tenant);
            await sleep(config.sessionStartStaggerMs);
        }
    }
    async start(tenant) {
        const existing = this.runtimes.get(tenant.id);
        if (existing && !existing.stopping)
            return existing.ctx;
        if (!this.admitting) {
            console.warn(`[sessions] memory guard is closed; not starting ${tenant.id}`);
            return undefined;
        }
        if (this.runtimes.size >= config.maxSessions) {
            console.warn(`[sessions] at MAX_SESSIONS=${config.maxSessions}; not starting ${tenant.id}`);
            return undefined;
        }
        const rt = {
            ctx: new TenantContext(tenant),
            retries: 0,
            connecting: false,
            stopping: false,
            pairRequested: false,
            pairAttempts: 0,
        };
        this.runtimes.set(tenant.id, rt);
        await this.connect(rt);
        return rt.ctx;
    }
    /** Stop one tenant. Keeps its credentials so it can be started again later. */
    async stop(tenantId) {
        const rt = this.runtimes.get(tenantId);
        if (!rt)
            return;
        this.release(rt);
    }
    async stopAll() {
        for (const rt of [...this.runtimes.values()])
            this.release(rt);
    }
    /** Stop and mark a tenant (e.g. 'expired' / 'paused'). It will not auto-reconnect. */
    async halt(tenantId, status) {
        const rt = this.runtimes.get(tenantId);
        if (rt)
            await this.haltRuntime(rt, status, status);
        else
            await patchTenant(tenantId, { status });
    }
    /** Stop sessions whose plan has run out. Call on a timer. */
    async enforcePlans() {
        const now = Date.now();
        for (const rt of [...this.runtimes.values()]) {
            // Re-read the record: an extension (or a sudo change) made while the session runs lives in the
            // store, and the in-memory copy would otherwise keep the OLD expiry and cut a paid customer off.
            const fresh = await getTenant(rt.ctx.id).catch(() => null);
            if (fresh)
                Object.assign(rt.ctx.tenant, fresh);
            const t = rt.ctx.tenant;
            if (t.expiresAt !== null && t.expiresAt <= now)
                await this.haltRuntime(rt, 'expired', 'plan expired');
        }
    }
    // ── connection ──────────────────────────────────────────────────────────
    async getVersion() {
        if (!this.version) {
            try {
                this.version = (await fetchLatestBaileysVersion()).version;
            }
            catch {
                // fall back to the version bundled with Baileys
            }
        }
        return this.version;
    }
    async connect(rt) {
        if (rt.stopping || rt.connecting)
            return;
        rt.connecting = true;
        const { ctx } = rt;
        try {
            this.teardownSocket(rt);
            const version = await this.getVersion();
            // A failed read throws here and we retry with backoff. We never fall back to fresh creds.
            rt.auth ??= await useStoreAuthState(ctx.id);
            const { state, saveCreds } = rt.auth;
            const log = this.logger.child({ tenant: ctx.id });
            const sock = makeWASocket({
                version,
                logger: log,
                browser: Browsers.macOS('Chrome'),
                auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, log) },
                markOnlineOnConnect: false,
                syncFullHistory: false,
                shouldSyncHistoryMessage: () => false,
                generateHighQualityLinkPreview: false,
                defaultQueryTimeoutMs: 60_000,
                connectTimeoutMs: 60_000,
                keepAliveIntervalMs: 25_000,
                cachedGroupMetadata: async (jid) => ctx.groupMetaCached(jid),
                getMessage: async (key) => ctx.sentMessage(key?.id),
            });
            this.harden(rt, sock);
            rt.pairRequested = false;
            ctx.attach(sock);
            ctx.log.info(state.creds.registered ? 'connecting...' : 'connecting... (not linked yet, a pairing code will follow)');
            // Pairing normally starts on the first "qr" event. If none arrives, ask anyway after a few seconds.
            if (rt.pairTimer)
                clearTimeout(rt.pairTimer);
            if (!state.creds.registered) {
                rt.pairTimer = setTimeout(() => void this.maybePair(rt, sock), 8_000);
                rt.pairTimer.unref();
            }
            sock.ev.on('creds.update', () => {
                saveCreds().catch((e) => ctx.log.error(`saving credentials failed: ${e.message}`));
            });
            sock.ev.on('connection.update', (update) => {
                void this.onConnection(rt, sock, update);
            });
            sock.ev.on('groups.upsert', (groups) => groups.forEach((g) => ctx.cacheGroupMeta(g.id, g)));
            sock.ev.on('groups.update', (groups) => groups.forEach((g) => g?.id && ctx.invalidateGroupMeta(g.id)));
            sock.ev.on('group-participants.update', (u) => u?.id && ctx.invalidateGroupMeta(u.id));
            this.emit('socket', ctx, sock);
        }
        catch (err) {
            ctx.log.error(`connect failed: ${err.message}`);
            this.scheduleReconnect(rt);
        }
        finally {
            rt.connecting = false;
        }
    }
    /** Presence guard + sent-message memory, applied to every new socket. */
    harden(rt, sock) {
        const sendPresence = sock.sendPresenceUpdate.bind(sock);
        sock.sendPresenceUpdate = async (type, ...rest) => {
            if (type === 'available' && !config.allowOnlinePresence)
                return; // keeps the owner's phone notifications on
            return sendPresence(type, ...rest);
        };
        rt.setOffline = async () => {
            try {
                await sendPresence('unavailable');
            }
            catch {
                // best effort
            }
        };
        const send = sock.sendMessage.bind(sock);
        sock.sendMessage = async (jid, content, options) => {
            const sent = await send(jid, content, options);
            if (sent?.key?.id && sent.message)
                rt.ctx.rememberSent(sent.key.id, sent.message);
            return sent;
        };
    }
    async onConnection(rt, sock, update) {
        const { ctx } = rt;
        if (!ctx.isCurrent(sock))
            return; // update from a socket we already replaced
        const { connection, lastDisconnect, qr } = update;
        if (qr && rt.auth && !rt.auth.state.creds.registered)
            await this.maybePair(rt, sock);
        if (connection === 'open') {
            if (rt.pairTimer)
                clearTimeout(rt.pairTimer);
            rt.retries = 0;
            ctx.markOnline();
            if (ctx.tenant.status !== 'active') {
                ctx.tenant.status = 'active';
                await patchTenant(ctx.id, { status: 'active' }).catch(() => undefined);
            }
            if (rt.offlineTimer)
                clearInterval(rt.offlineTimer);
            void rt.setOffline?.();
            rt.offlineTimer = setInterval(() => void rt.setOffline?.(), config.offlineReassertMs);
            ctx.log.info('connected');
            this.emit('online', ctx);
            return;
        }
        if (connection !== 'close')
            return;
        if (rt.offlineTimer)
            clearInterval(rt.offlineTimer);
        if (rt.pairTimer)
            clearTimeout(rt.pairTimer);
        ctx.markOffline();
        const code = lastDisconnect?.error?.output?.statusCode;
        ctx.log.warn(`connection closed (${code ?? 'unknown'})`);
        this.emit('closed', ctx, code);
        if (rt.stopping)
            return;
        switch (code) {
            case DisconnectReason.loggedOut:
                // The customer unlinked the device from their phone. Wipe keys, flag for re-link, stop.
                await rt.auth?.clear().catch(() => undefined);
                rt.auth = undefined;
                await this.haltRuntime(rt, 'needs_relink', 'logged out from WhatsApp');
                return;
            case DisconnectReason.connectionReplaced:
                // Another process is using these credentials (e.g. a duplicate deploy). Reconnecting
                // would start a tug-of-war that can get the number flagged, so stop and say so loudly.
                ctx.log.error('connection replaced: another process is using this session');
                await this.haltRuntime(rt, 'paused', 'session replaced by another process');
                return;
            case DisconnectReason.restartRequired:
                this.schedule(rt, 0); // normal right after pairing
                return;
            default:
                if (!rt.auth?.state.creds.registered && rt.pairAttempts >= config.maxPairAttempts) {
                    await this.haltRuntime(rt, 'paused', 'pairing code was not used');
                    return;
                }
                this.scheduleReconnect(rt);
        }
    }
    async maybePair(rt, sock) {
        const { ctx } = rt;
        if (rt.pairRequested || rt.auth?.state.creds.registered || !ctx.isCurrent(sock))
            return;
        rt.pairRequested = true;
        ctx.log.info('requesting pairing code...');
        try {
            const raw = await sock.requestPairingCode(ctx.tenant.number);
            rt.pairAttempts++;
            const code = raw.match(/.{1,4}/g)?.join('-') ?? raw;
            this.emit('pairingCode', ctx, code);
        }
        catch (err) {
            ctx.log.error(`pairing code request failed: ${err.message}`);
            rt.pairRequested = false;
        }
    }
    // ── reconnect / teardown ────────────────────────────────────────────────
    scheduleReconnect(rt) {
        rt.retries++;
        const base = Math.min(60_000, 1_000 * 2 ** Math.min(rt.retries, 6));
        const delay = base / 2 + Math.random() * (base / 2); // jitter so tenants don't reconnect in lockstep
        rt.ctx.log.info(`reconnecting in ${Math.round(delay / 1000)}s (attempt ${rt.retries})`);
        this.schedule(rt, delay);
    }
    schedule(rt, delayMs) {
        if (rt.timer)
            clearTimeout(rt.timer);
        rt.timer = setTimeout(() => void this.connect(rt), delayMs);
    }
    /** Remove listeners and close the old socket so a reconnect never leaves a zombie behind. */
    teardownSocket(rt) {
        const sock = rt.ctx.trySockAny();
        if (!sock)
            return;
        rt.ctx.detach();
        try {
            sock.ev.removeAllListeners();
        }
        catch { /* already gone */ }
        try {
            sock.end(undefined);
        }
        catch { /* already closed */ }
        try {
            sock.ws?.close?.();
        }
        catch { /* already closed */ }
    }
    release(rt) {
        rt.stopping = true;
        if (rt.timer)
            clearTimeout(rt.timer);
        if (rt.pairTimer)
            clearTimeout(rt.pairTimer);
        if (rt.offlineTimer)
            clearInterval(rt.offlineTimer);
        this.teardownSocket(rt);
        this.runtimes.delete(rt.ctx.id);
        this.emit('released', rt.ctx);
    }
    async haltRuntime(rt, status, why) {
        const { ctx } = rt;
        this.release(rt);
        ctx.tenant.status = status;
        await patchTenant(ctx.id, { status }).catch(() => undefined);
        ctx.log.warn(`halted: ${why}`);
        this.emit('halted', ctx, why);
    }
}
