import { config } from '../config.js';
import { tenantStore } from '../store/tenantStore.js';
import { digits } from '../store/tenants.js';
import { TtlCache } from './ttlCache.js';
/**
 * Everything a plugin needs to act on behalf of ONE reseller. Plugins receive
 * this instead of a raw socket and never touch module-level state, which is what
 * keeps tenants from leaking into each other.
 *
 * The socket is a live getter: after a reconnect, `ctx.getSock()` returns the new
 * socket, so a plugin that stored `ctx` (not the socket) can never hold a dead one.
 */
export class TenantContext {
    tenant;
    state = 'stopped';
    socket = null;
    stores = new Map();
    groupMeta = new TtlCache(config.groupMetaTtlMs, config.groupMetaMax);
    seen = new TtlCache(config.seenMessageTtlMs, config.seenMessageMax);
    sent = new TtlCache(config.sentCacheTtlMs, config.sentCacheMax);
    lidToPn = new TtlCache(6 * 60 * 60_000, 2_000);
    constructor(tenant) {
        this.tenant = tenant;
    }
    get id() {
        return this.tenant.id;
    }
    get online() {
        return this.state === 'online' && this.socket !== null;
    }
    /** The live socket, or an error if the tenant is currently offline. */
    getSock() {
        if (!this.socket || this.state !== 'online') {
            throw new Error(`tenant ${this.id} is offline`);
        }
        return this.socket;
    }
    /** The live socket or null, for code that can simply skip when offline. */
    trySock() {
        return this.online ? this.socket : null;
    }
    // ── lifecycle (called by SessionManager only) ───────────────────────────
    isCurrent(sock) {
        return this.socket === sock;
    }
    /** The attached socket in any state (connecting included). SessionManager use only. */
    trySockAny() {
        return this.socket;
    }
    attach(sock) {
        this.socket = sock;
        this.state = 'connecting';
    }
    markOnline() {
        this.state = 'online';
    }
    markOffline() {
        if (this.state !== 'stopped')
            this.state = 'offline';
    }
    detach() {
        this.socket = null;
        this.state = 'stopped';
    }
    // ── storage ─────────────────────────────────────────────────────────────
    /** Tenant-scoped store: store('catalog'), store('queue'), store('settings')... */
    store(namespace) {
        let s = this.stores.get(namespace);
        if (!s) {
            s = tenantStore(this.id, namespace);
            this.stores.set(namespace, s);
        }
        return s;
    }
    // ── identity ────────────────────────────────────────────────────────────
    /** True if the number behind this JID is the reseller or one of their sudo numbers. */
    isOwnerJid(jid) {
        if (!jid)
            return false;
        const n = digits(jid.split('@')[0].split(':')[0]);
        return n === this.tenant.number || this.tenant.sudo.includes(n);
    }
    /**
     * Resolve a "@lid" sender to their phone-number JID using WhatsApp's own mapping.
     * Returns null when the mapping isn't known yet. Phone JIDs are returned unchanged.
     */
    async resolvePn(jid) {
        if (!jid.endsWith('@lid'))
            return jid;
        const hit = this.lidToPn.get(jid);
        if (hit)
            return hit;
        try {
            const pn = await this.trySock()?.signalRepository?.lidMapping?.getPNForLID?.(jid);
            if (pn) {
                this.lidToPn.set(jid, pn);
                return pn;
            }
        }
        catch {
            // mapping not available yet
        }
        return null;
    }
    // ── caches ──────────────────────────────────────────────────────────────
    /**
     * True the first time this tenant sees a message id, false after that.
     * Scoped per tenant on purpose: two resellers in the same vendor group receive
     * the SAME message ids, and a shared dedupe map would drop the second one's copy.
     */
    firstSight(messageId) {
        if (this.seen.get(messageId))
            return false;
        this.seen.set(messageId, true);
        return true;
    }
    groupMetaCached(jid) {
        return this.groupMeta.get(jid);
    }
    cacheGroupMeta(jid, meta) {
        this.groupMeta.set(jid, meta);
    }
    invalidateGroupMeta(jid) {
        this.groupMeta.delete(jid);
    }
    /** Group metadata with a TTL cache in front of the network call. */
    async groupMetadata(jid) {
        const hit = this.groupMeta.get(jid);
        if (hit)
            return hit;
        const meta = await this.getSock().groupMetadata(jid).catch(() => null);
        if (meta)
            this.groupMeta.set(jid, meta);
        return meta;
    }
    /** Remember what we sent so WhatsApp can ask for it again on a retry (Baileys getMessage). */
    rememberSent(messageId, message) {
        this.sent.set(messageId, message);
    }
    sentMessage(messageId) {
        return messageId ? this.sent.get(messageId) : undefined;
    }
    // ── logging ─────────────────────────────────────────────────────────────
    log = {
        info: (msg) => console.log(`[${this.id}] ${msg}`),
        warn: (msg) => console.warn(`[${this.id}] ${msg}`),
        error: (msg) => console.error(`[${this.id}] ${msg}`),
    };
}
