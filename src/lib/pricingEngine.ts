/** Pure pricing rules: vendor cost in, the reseller's selling price out. */

export interface Tier {
  /** Applies to costs up to and including this amount; null = everything above the previous tiers. */
  upTo: number | null;
  markupPercent: number;
}

export interface PricingRules {
  markupPercent: number;
  /** Flat amount added after the percentage. */
  fixedAdd: number;
  /** Optional cost bands; the first matching band's percentage replaces markupPercent. */
  tiers: Tier[];
  /** Round to a multiple of this (0 = no rounding). */
  roundingStep: number;
  /** 'up' never rounds below the margin you asked for. */
  roundingMode: 'up' | 'nearest';
  /** Never earn less than this per item. */
  minMargin: number;
}

export const DEFAULT_RULES: PricingRules = {
  markupPercent: 0,
  fixedAdd: 0,
  tiers: [],
  roundingStep: 100,
  roundingMode: 'up',
  minMargin: 0,
};

export function resalePrice(cost: number, rules: PricingRules): number {
  if (!(cost > 0)) return cost;
  const tier = rules.tiers.find((t) => t.upTo === null || cost <= t.upTo);
  const percent = tier ? tier.markupPercent : rules.markupPercent;

  let price = cost * (1 + percent / 100) + rules.fixedAdd;
  if (price - cost < rules.minMargin) price = cost + rules.minMargin;

  const step = rules.roundingStep;
  if (step > 0) {
    price = rules.roundingMode === 'up' ? Math.ceil(price / step - 1e-9) * step : Math.round(price / step) * step;
  }
  if (price < cost) price = cost;
  return Math.round(price * 100) / 100;
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  '#': '₦', N: '₦', NGN: '₦', naira: '₦', '₦': '₦',
  $: '$', USD: '$', usd: '$', dollar: '$', dollars: '$',
  GHS: 'GH₵', ghs: 'GH₵', '₵': 'GH₵', 'GH₵': 'GH₵', cedi: 'GH₵', cedis: 'GH₵',
  '£': '£', '€': '€',
};

/** Normalise whatever the vendor wrote ("#", "N", "naira") to a display symbol. */
export const symbolFor = (written: string | null | undefined, fallback: string): string =>
  (written && CURRENCY_SYMBOLS[written]) || fallback;

export function formatMoney(value: number, symbol: string): string {
  const body = Number.isInteger(value)
    ? value.toLocaleString('en-US')
    : value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${symbol}${body}`;
}
