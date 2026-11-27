import type { TenantContext } from './tenantContext.js';

export type JobState = 'pending' | 'sending' | 'done' | 'failed' | 'skipped';
export type JobTarget = { type: 'group'; jid: string; name: string } | { type: 'status' };

/** One thing to send: one product to one place. */
export interface PostJob {
  id: string;
  productId: string;
  target: JobTarget;
  state: JobState;
  attempts: number;
  /** Don't try before this time (used for retry back-off). */
  notBefore: number;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  error?: string | null;
  /** WhatsApp message ids that were sent, so replies can be tied back to the product. */
  sentIds?: string[];
}

export interface PostMeta {
  /** Earliest time the next post may go out (the human-like gap). */
  nextSendAt: number;
  /** After rate-limit style errors: nothing is sent until this time. */
  pausedUntil: number;
  consecutiveFailures: number;
  lastSentAt: number;
}

const DEFAULT_META: PostMeta = { nextSendAt: 0, pausedUntil: 0, consecutiveFailures: 0, lastSentAt: 0 };

const jobs = (ctx: TenantContext) => ctx.store('queue');
const stats = (ctx: TenantContext) => ctx.store('post_stats');
const meta = (ctx: TenantContext) => ctx.store('post_meta');
const sentIndex = (ctx: TenantContext) => ctx.store('sent_index');

export const newJobId = (): string => `j${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export async function addJobs(ctx: TenantContext, productId: string, targets: JobTarget[], now = Date.now()): Promise<PostJob[]> {
  const created: PostJob[] = [];
  for (const target of targets) {
    const job: PostJob = { id: newJobId(), productId, target, state: 'pending', attempts: 0, notBefore: now, createdAt: now + created.length };
    await jobs(ctx).set(job.id, job);
    created.push(job);
  }
  return created;
}

export const saveJob = (ctx: TenantContext, job: PostJob) => jobs(ctx).set(job.id, job);

export async function listJobs(ctx: TenantContext, state?: JobState): Promise<PostJob[]> {
  const all = Object.values(await jobs(ctx).getAll()) as PostJob[];
  return all.filter((j) => !state || j.state === state).sort((a, b) => a.createdAt - b.createdAt);
}

export const jobsForProduct = async (ctx: TenantContext, productId: string) => (await listJobs(ctx)).filter((j) => j.productId === productId);

export async function getMeta(ctx: TenantContext): Promise<PostMeta> {
  return { ...DEFAULT_META, ...(((await meta(ctx).get('main')) as Partial<PostMeta> | null) ?? {}) };
}
export const patchMeta = (ctx: TenantContext, patch: Partial<PostMeta>) => meta(ctx).patch('main', patch);

/** How many posts went out on this local day. */
export async function sentOn(ctx: TenantContext, day: string): Promise<number> {
  return (((await stats(ctx).get(`day:${day}`)) as { sent: number } | null)?.sent) ?? 0;
}
export async function countSent(ctx: TenantContext, day: string): Promise<number> {
  const next = await stats(ctx).mutate(`day:${day}`, (cur: { sent: number } | null) => ({ sent: (cur?.sent ?? 0) + 1 }));
  return (next as { sent: number }).sent;
}

/** Remember which product a sent message belongs to (customer replies are matched through this). */
export async function recordSent(ctx: TenantContext, productId: string, jid: string, ids: string[]): Promise<void> {
  await Promise.all(ids.map((id) => sentIndex(ctx).set(id, { productId, jid, at: Date.now() })));
}
export const findSent = async (ctx: TenantContext, messageId: string) =>
  ((await sentIndex(ctx).get(messageId)) as { productId: string; jid: string; at: number } | null) ?? null;

/** Housekeeping: finished jobs and old counters don't need to live forever. */
export async function pruneQueue(ctx: TenantContext, now = Date.now()): Promise<number> {
  let removed = 0;
  for (const j of await listJobs(ctx)) {
    const age = now - (j.finishedAt ?? j.createdAt);
    const old = (j.state === 'done' || j.state === 'skipped') ? age > 3 * 86_400_000 : j.state === 'failed' ? age > 14 * 86_400_000 : false;
    if (old) { await jobs(ctx).del(j.id); removed++; }
  }
  return removed;
}
