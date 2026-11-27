import { autoPostVerdict, type AutoHold } from '../lib/autoPost.js';
import { formatMoney } from '../lib/pricingEngine.js';
import { approveItems } from './approve.js';
import { listProducts } from './catalog.js';
import { notifyOwner } from './publisher.js';
import { listJobs } from './queue.js';
import { renderProduct } from './render.js';
import { getSettings, type TenantSettings } from './settings.js';
import { listTargets } from './targets.js';
import type { TenantContext } from './tenantContext.js';
import { getVendor } from './vendors.js';

/**
 * Auto-post: the hands-off mode. Every 30 seconds, vendor items that are safe (see lib/autoPost.ts)
 * and have waited out the hold period are approved and queued for every posting group, exactly as if
 * the owner had tapped Approve. The normal posting rules still decide WHEN they go out (one at a
 * time, random gaps, daily cap, quiet hours, warm-up, kill switch).
 */

const HOLD_TEXT: Record<AutoHold, string> = {
  review: 'price missing or unsure',
  'no-media': 'no photo or video',
  markup: 'markup is 0%',
  contact: 'vendor contact still in the caption',
  'vendor-name': 'vendor name in the caption',
  'price-lost': 'caption lost the price',
};

export interface AutoRun {
  approved: number;
  held: number;
  waiting: number;
  skipped?: 'off' | 'paused' | 'no-contact' | 'no-target' | 'queue-full';
}

/** What must be set before auto-post can be switched on. Empty list = ready. */
export async function autoPostProblems(ctx: TenantContext, s?: TenantSettings): Promise<string[]> {
  const settings = s ?? (await getSettings(ctx));
  const problems: string[] = [];
  if (!settings.contactLine.trim()) problems.push('Set your contact line (.menu → Settings) so customers can reach you.');
  if (!(settings.markupPercent > 0)) problems.push('Set your markup above 0% (.menu → Settings), or items would go out at the vendor’s price.');
  const targets = (await listTargets(ctx)).filter((t) => t.enabled);
  if (targets.length === 0 && !settings.postToStatus) problems.push('Choose where to post: type *.target add* in a customer group.');
  return problems;
}

const notified = new WeakMap<TenantContext, Set<string>>();

export async function runAutoPost(ctx: TenantContext, now = Date.now()): Promise<AutoRun> {
  const out: AutoRun = { approved: 0, held: 0, waiting: 0 };
  const s = await getSettings(ctx);
  if (!s.autoPost) return { ...out, skipped: 'off' };
  if (!s.postingEnabled) return { ...out, skipped: 'paused' };

  const problems = await autoPostProblems(ctx, s);
  if (problems.length) {
    await notifyOwner(ctx, 'auto-setup', `🤖 Auto-post is on but can’t run yet:\n${problems.map((p) => `• ${p}`).join('\n')}`);
    return { ...out, skipped: problems[0].includes('contact line') ? 'no-contact' : 'no-target' };
  }

  const targets = (await listTargets(ctx)).filter((t) => t.enabled).length + (s.postToStatus ? 1 : 0);
  // Never queue more than one day's allowance: the daily limit counts every group separately.
  const pendingJobs = (await listJobs(ctx, 'pending')).length;
  let itemRoom = Math.floor((s.dailyCap - pendingJobs) / targets);

  const maxAge = s.autoPostMaxAgeHrs > 0 ? s.autoPostMaxAgeHrs * 3_600_000 : Infinity;
  const fresh = (await listProducts(ctx, { status: 'new' })).filter((p) => now - p.createdAt <= maxAge).reverse(); // oldest first
  const approve: string[] = [];
  const heldNow: Array<{ id: string; why: string }> = [];

  for (const p of fresh) {
    const vendor = await getVendor(ctx, p.vendorChatId);
    if (vendor && !vendor.enabled) continue;
    const r = renderProduct(p, s, vendor);
    const contact = s.contactLine.trim();
    const caption = contact && r.caption.endsWith(contact) ? r.caption.slice(0, -contact.length).trimEnd() : r.caption;
    const verdict = autoPostVerdict({
      status: p.status,
      needsReview: p.needsReview,
      cost: p.cost,
      manualPrice: p.manualPrice,
      mediaCount: p.media.length,
      createdAt: p.createdAt,
      now,
      delayMs: s.autoPostDelayMin * 60_000,
      markupPercent: vendor?.markupPercent ?? s.markupPercent,
      vendorName: p.vendorName,
      caption,
      priceText: r.price === null ? null : formatMoney(r.price, '').trim(),
    });
    if ('wait' in verdict) { out.waiting++; continue; }
    if (!verdict.ok) {
      out.held++;
      heldNow.push({ id: p.id, why: HOLD_TEXT[verdict.hold] });
      continue;
    }
    if (itemRoom <= 0) { out.skipped = 'queue-full'; continue; }
    approve.push(p.id);
    itemRoom--;
  }

  if (approve.length) out.approved = (await approveItems(ctx, approve, { auto: true })).approved;

  // Tell the owner once about each newly held item, not every 30 seconds.
  let seen = notified.get(ctx);
  if (!seen) notified.set(ctx, (seen = new Set()));
  if (seen.size > 500) seen.clear();
  const fresh_ = heldNow.filter((h) => !seen!.has(h.id));
  if (fresh_.length) {
    fresh_.forEach((h) => seen!.add(h.id));
    const reasons = [...new Set(fresh_.map((h) => h.why))].join('; ');
    await notifyOwner(ctx, `auto-held:${fresh_[0].id}`, `🤖 Auto-post held ${fresh_.length} item${fresh_.length === 1 ? '' : 's'} for you to check (${reasons}).\nOpen .menu → Items to fix and approve ${fresh_.length === 1 ? 'it' : 'them'}.`);
  }
  return out;
}
