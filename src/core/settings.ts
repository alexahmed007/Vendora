import type { TenantContext } from './tenantContext.js';

/** Per-reseller settings that the pricing, caption and AI features read. Edited from the dashboard. */
export interface TenantSettings {
  /** Shown on the dashboard and used when rewriting vendor captions. */
  brandName: string;
  /** The reseller's own contact line, which replaces the vendor's number in captions. */
  contactLine: string;
  /** Default markup applied to vendor prices, in percent. */
  markupPercent: number;
  /** Round selling prices up to a multiple of this (0 = off). */
  roundingStep: number;
  /** Used when a vendor wrote a bare number with no currency. */
  currencySymbol: string;

  // ── posting ──
  /** Master switch ("kill switch"): off means nothing is sent, ever. */
  postingEnabled: boolean;
  /** Also post each item to the reseller's WhatsApp status. */
  postToStatus: boolean;
  /** Most posts per day once the account has warmed up. */
  dailyCap: number;
  /** Random pause between two posts, in seconds. */
  gapMinSec: number;
  gapMaxSec: number;
  /** No posting between these local hours (start === end disables). */
  quietStart: number;
  quietEnd: number;
}

export const DEFAULT_SETTINGS: TenantSettings = {
  brandName: '',
  contactLine: '',
  markupPercent: 0,
  roundingStep: 100,
  currencySymbol: '₦',
  postingEnabled: true,
  postToStatus: false,
  dailyCap: 40,
  gapMinSec: 45,
  gapMaxSec: 120,
  quietStart: 23,
  quietEnd: 6,
};

export async function getSettings(ctx: TenantContext): Promise<TenantSettings> {
  const saved = await ctx.store('settings').get('main');
  return { ...DEFAULT_SETTINGS, ...(saved ?? {}) };
}

export async function updateSettings(ctx: TenantContext, patch: Partial<TenantSettings>): Promise<void> {
  await ctx.store('settings').patch('main', patch);
}
