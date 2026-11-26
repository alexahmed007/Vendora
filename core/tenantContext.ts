import { config } from '../src/config.js';
import { tenantStore, type Store } from '../store/tenantStore.js';
import { digits, type TenantRecord } from '../store/tenants.js';
import { TtlCache } from './ttlCache.js';

export type TenantState = 'stopped' | 'connecting' | 'online' | 'offline';

/**
 * Everything a plugin needs to act on behalf of ONE reseller. Plugins receive
 * this instead of a raw socket and never touch module-level state, which is what
 * keeps tenants from leaking into each other.
 *
 * The socket is a live getter: after a reconnect, `ctx.getSock()` returns the new
 * socket, so a plugin that stored `ctx` (not the socket) can never hold a dead one.
 */
export class TenantContext {
  tenant: TenantRecord;
  state: TenantState = 'stopped';

  private socket: any = null;
  private readonly stores = new Map<string, Store>();
  private readonly groupMeta = new TtlCache<any>(config.groupMetaTtlMs, config.groupMetaMax);
  private readonly seen = new TtlCache<true>(config.seenMessageTtlMs, config.seenMessageMax);
  private readonly sent = new TtlCache<any>(config.sentCacheTtlMs, config.sentCacheMax);
  private readonly lidToPn = new TtlCache<string>(6 * 60 * 60_000, 2_000);

  constructor(tenant: TenantRecord) {
    this.tenant = tenant;
  }

  get id(): string {
    return this.tenant.id;
  }

  get online(): boolean {
    return this.state === 'online' && this.socket !== null;
  }

  /** The live socket, or an error if the tenant is currently offline. */
  getSock(): any {
    if (!this.socket || this.state !== 'online') {
      throw new Error(`tenant ${this.id} is offline`);
    }
    return this.socket;
  }

  /** The live socket or null, for code that can simply skip when offline. */
  trySock(): any | null {
    return this.online ? this.socket : null;
  }

  // ── lifecycle (called by SessionManager only) ───────────────────────────
  isCurrent(sock: any): boolean {
    return this.socket === sock;
  }

  /** The attached socket in any state (connecting included). SessionManager use only. */
  trySockAny(): any | null {
    return this.socket;
  }

  attach(sock: any): void {
    this.socket = sock;
    this.state = 'connecting';
  }

  markOnline(): void {
    this.state = 'online';
  }

  markOffline(): void {
    if (this.state !== 'stopped') this.state = 'offline';
  }

  detach(): void {
    this.socket = null;
    this.state = 'stopped';
  }

  // ── storage ─────────────────────────────────────────────────────────────
  /** Tenant-scoped store: store('catalog'), store('queue'), store('settings')... */
  store(namespace: string): Store {
    let s = this.stores.get(namespace);
    if (!s) {
      s = tenantStore(this.id, namespace);
      this.stores.set(namespace, s);
    }
    return s;
  }

  // ── identity ────────────────────────────────────────────────────────────
  /** True if the number behind this JID is the reseller or one of their sudo numbers. */
  isOwnerJid(jid: string | null | undefined): boolean {
    if (!jid) return false;
    const n = digits(jid.split('@')[0].split(':')[0]);
    return n === this.tenant.number || this.tenant.sudo.includes(n);
  }

  /**
   * Resolve a "@lid" sender to their phone-number JID using WhatsApp's own mapping.
   * Returns null when the mapping isn't known yet. Phone JIDs are returned unchanged.
   */
  async resolvePn(jid: string): Promise<string | null> {
    if (!jid.endsWith('@lid')) return jid;
    const hit = this.lidToPn.get(jid);
    if (hit) return hit;
    try {
      const pn = await this.trySock()?.signalRepository?.lidMapping?.getPNForLID?.(jid);
      if (pn) {
        this.lidToPn.set(jid, pn);
        return pn;
      }
    } catch {
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
  firstSight(messageId: string): boolean {
    if (this.seen.get(messageId)) return false;
    this.seen.set(messageId, true);
    return true;
  }

  groupMetaCached(jid: string): any | undefined {
    return this.groupMeta.get(jid);
  }

  cacheGroupMeta(jid: string, meta: any): void {
    this.groupMeta.set(jid, meta);
  }

  invalidateGroupMeta(jid: string): void {
    this.groupMeta.delete(jid);
  }

  /** Group metadata with a TTL cache in front of the network call. */
  async groupMetadata(jid: string): Promise<any | null> {
    const hit = this.groupMeta.get(jid);
    if (hit) return hit;
    const meta = await this.getSock().groupMetadata(jid).catch(() => null);
    if (meta) this.groupMeta.set(jid, meta);
    return meta;
  }

  /** Remember what we sent so WhatsApp can ask for it again on a retry (Baileys getMessage). */
  rememberSent(messageId: string, message: unknown): void {
    this.sent.set(messageId, message);
  }

  sentMessage(messageId: string | null | undefined): any | undefined {
    return messageId ? this.sent.get(messageId) : undefined;
  }

  // ── logging ─────────────────────────────────────────────────────────────
  readonly log = {
    info: (msg: string) => console.log(`[${this.id}] ${msg}`),
    warn: (msg: string) => console.warn(`[${this.id}] ${msg}`),
    error: (msg: string) => console.error(`[${this.id}] ${msg}`),
  };
}
