import type { TenantContext } from './tenantContext.js';

/** A group of the reseller's own customers that approved items are posted to. */
export interface PostTarget {
  chatId: string;
  name: string;
  enabled: boolean;
  addedAt: number;
}

const store = (ctx: TenantContext) => ctx.store('targets');

export async function listTargets(ctx: TenantContext): Promise<PostTarget[]> {
  return (Object.values(await store(ctx).getAll()) as PostTarget[]).sort((a, b) => a.name.localeCompare(b.name));
}

export async function getTarget(ctx: TenantContext, chatId: string): Promise<PostTarget | null> {
  return ((await store(ctx).get(chatId)) as PostTarget | null) ?? null;
}

export async function saveTarget(ctx: TenantContext, t: PostTarget): Promise<void> {
  await store(ctx).set(t.chatId, t);
}

export async function addTarget(ctx: TenantContext, chatId: string, name: string): Promise<PostTarget> {
  const existing = await getTarget(ctx, chatId);
  const t: PostTarget = existing
    ? { ...existing, name: name || existing.name, enabled: true }
    : { chatId, name: name || chatId, enabled: true, addedAt: Date.now() };
  await saveTarget(ctx, t);
  return t;
}

export async function removeTarget(ctx: TenantContext, chatId: string): Promise<boolean> {
  const had = await store(ctx).has(chatId);
  await store(ctx).del(chatId);
  return had;
}
