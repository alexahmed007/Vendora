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

  // ── AI customer care ──
  /** off: never replies · away: steps in when you don't answer (or you're closed) · always: answers every customer */
  aiMode: 'off' | 'away' | 'always';
  /** Answer customers who reply to your posts inside your groups. */
  aiReplyInGroups: boolean;
  /** Answer customers who reply to your status. */
  aiReplyToStatus: boolean;
  /** In "away" mode: how long to wait for you to answer first. */
  aiAwayDelaySec: number;
  /** After you type in a chat, the assistant stays quiet there for this many minutes. */
  aiOwnerQuietMin: number;
  /** Most AI replies per day. */
  aiDailyCap: number;
  /** Business hours (local). Outside them, "away" mode answers at once. Equal = always open. */
  hoursStart: number;
  hoursEnd: number;
  /** Delivery, payment, location, returns: the ONLY facts the assistant may quote besides your items. */
  shopInfo: string;
  /** Extra tone notes, e.g. "Use light Pidgin when the customer does." */
  aiInstructions: string;
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
  aiMode: 'off',
  aiReplyInGroups: true,
  aiReplyToStatus: true,
  aiAwayDelaySec: 90,
  aiOwnerQuietMin: 30,
  aiDailyCap: 150,
  hoursStart: 8,
  hoursEnd: 21,
  shopInfo: '',
  aiInstructions: '',
};

export async function getSettings(ctx: TenantContext): Promise<TenantSettings> {
  const saved = await ctx.store('settings').get('main');
  return { ...DEFAULT_SETTINGS, ...(saved ?? {}) };
}

export async function updateSettings(ctx: TenantContext, patch: Partial<TenantSettings>): Promise<void> {
  await ctx.store('settings').patch('main', patch);
}
