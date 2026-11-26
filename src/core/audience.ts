import { jidNormalizedUser } from '@whiskeysockets/baileys';
import { config } from '../config.js';
import { cleanJid } from './jid.js';
import type { TenantContext } from './tenantContext.js';
import { listTargets } from './targets.js';
import { TtlCache } from './ttlCache.js';

/**
 * Who sees the reseller's WhatsApp status. WhatsApp gives a linked device no reliable address book,
 * so the audience is built from what the bot has actually seen: people who messaged the reseller,
 * contacts WhatsApp announced, and the members of the reseller's own customer groups.
 */

const store = (ctx: TenantContext) => ctx.store('audience');
const recent = new WeakMap<TenantContext, TtlCache<true>>();
const isPhoneJid = (jid: string) => jid.endsWith('@s.whatsapp.net');

/** Remember a person (cheap: repeated sightings within 10 minutes don't touch the database). */
export async function noteContact(ctx: TenantContext, jid: string | null | undefined): Promise<void> {
  if (!jid || !isPhoneJid(jid) || ctx.isOwnerJid(jid)) return;
  let cache = recent.get(ctx);
  if (!cache) recent.set(ctx, (cache = new TtlCache<true>(10 * 60_000, 5_000)));
  if (cache.get(jid)) return;
  cache.set(jid, true);
  await store(ctx).set(jid, Date.now());
}

export async function buildStatusAudience(ctx: TenantContext, max = config.statusAudienceMax): Promise<string[]> {
  const found = new Map<string, number>();
  const all = (await store(ctx).getAll()) as Record<string, number>;
  for (const [jid, at] of Object.entries(all)) found.set(jid, at);

  for (const t of (await listTargets(ctx)).filter((x) => x.enabled)) {
    const meta = await ctx.groupMetadata(t.chatId).catch(() => null);
    for (const p of meta?.participants ?? []) {
      const jid: string | undefined = p.phoneNumber ?? p.id; // newer WhatsApp: id may be a lid, phoneNumber the real one
      if (jid && isPhoneJid(jid) && !found.has(jid)) found.set(jid, 0);
    }
  }

  const own = ctx.tenant.number;
  return [...found.entries()]
    .filter(([jid]) => cleanJid(jidNormalizedUser(jid)) !== own)
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([jid]) => jid);
}

/** Keep the stored audience bounded: newest first. */
export async function pruneAudience(ctx: TenantContext, keep = 5_000): Promise<number> {
  const all = Object.entries((await store(ctx).getAll()) as Record<string, number>).sort((a, b) => b[1] - a[1]);
  const doomed = all.slice(keep);
  for (const [jid] of doomed) await store(ctx).del(jid);
  return doomed.length;
}
