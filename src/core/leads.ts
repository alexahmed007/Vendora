import type { TenantContext } from './tenantContext.js';

/** A customer who needs the owner: wants to order, asked for a person, or something the assistant couldn't answer. */
export interface Lead {
  id: string;
  customerId: string;
  customerName: string;
  /** Digits of their phone number when known (for a wa.me link). */
  phone: string | null;
  chatId: string;
  kind: 'order' | 'human' | 'question' | 'media' | 'bargain';
  text: string;
  productId: string | null;
  productTitle: string;
  at: number;
  done: boolean;
}

const leads = (ctx: TenantContext) => ctx.store('leads');
const log = (ctx: TenantContext) => ctx.store('ai_log');
const newId = () => `l${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/** One open lead per customer + kind within 30 minutes: a burst of messages doesn't create a pile of leads. */
export async function addLead(ctx: TenantContext, input: Omit<Lead, 'id' | 'at' | 'done'>, now = Date.now()): Promise<Lead> {
  const all = Object.values(await leads(ctx).getAll()) as Lead[];
  const same = all.find((l) => !l.done && l.customerId === input.customerId && l.kind === input.kind && now - l.at < 30 * 60_000);
  if (same) {
    const updated = { ...same, text: input.text, productId: input.productId ?? same.productId, productTitle: input.productTitle || same.productTitle, at: now };
    await leads(ctx).set(same.id, updated);
    return updated;
  }
  const lead: Lead = { ...input, id: newId(), at: now, done: false };
  await leads(ctx).set(lead.id, lead);
  return lead;
}

export async function listLeads(ctx: TenantContext, opts: { open?: boolean } = {}): Promise<Lead[]> {
  const all = Object.values(await leads(ctx).getAll()) as Lead[];
  return all.filter((l) => !opts.open || !l.done).sort((a, b) => b.at - a.at);
}

export async function getLead(ctx: TenantContext, id: string): Promise<Lead | null> {
  return ((await leads(ctx).get(id)) as Lead | null) ?? null;
}

export async function setLeadDone(ctx: TenantContext, id: string, done: boolean): Promise<void> {
  await leads(ctx).patch(id, { done });
}

export async function pruneLeads(ctx: TenantContext, maxAgeMs = 30 * 86_400_000, now = Date.now()): Promise<number> {
  let n = 0;
  for (const l of await listLeads(ctx)) if (now - l.at > maxAgeMs) { await leads(ctx).del(l.id); n++; }
  return n;
}

// ── a short log of what the assistant said, so the owner can see and trust it ──

export interface AiLogEntry {
  at: number;
  channel: 'dm' | 'group' | 'status';
  customer: string;
  asked: string;
  answered: string;
  kind: 'reply' | 'handoff';
  reason: string;
  item: string;
}

export async function addAiLog(ctx: TenantContext, entry: AiLogEntry): Promise<void> {
  await log(ctx).mutate('recent', (cur: AiLogEntry[] | null) => [...(cur ?? []), entry].slice(-50));
}

export async function listAiLog(ctx: TenantContext): Promise<AiLogEntry[]> {
  return (((await log(ctx).get('recent')) as AiLogEntry[] | null) ?? []).slice().reverse();
}
