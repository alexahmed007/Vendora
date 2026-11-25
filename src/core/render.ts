import { cleanCaption } from '../lib/captionCleaner.js';
import { pickPrimary, parsePrices, type PriceMatch } from '../lib/priceParser.js';
import { DEFAULT_RULES, resalePrice, symbolFor, type PricingRules } from '../lib/pricingEngine.js';
import type { Product } from './catalog.js';
import type { TenantSettings } from './settings.js';
import type { VendorSource } from './vendors.js';

export function rulesFor(settings: TenantSettings, vendor?: VendorSource | null): PricingRules {
  return { ...DEFAULT_RULES, markupPercent: vendor?.markupPercent ?? settings.markupPercent, roundingStep: settings.roundingStep };
}

export interface Rendered {
  /** The caption the reseller would post: vendor contacts removed, prices replaced, contact line added. */
  caption: string;
  cost: number | null;
  /** Selling price of the main price (manual override wins). */
  price: number | null;
  removed: { phones: number; links: number; lines: number };
}

/**
 * Preview / final text for a product under the reseller's CURRENT settings, so changing markup or
 * contact line later changes every item that hasn't been posted yet.
 */
export function renderProduct(p: Product, settings: TenantSettings, vendor: VendorSource | null): Rendered {
  const rules = rulesFor(settings, vendor);
  const primary = pickPrimary(parsePrices(p.rawCaption));

  const price = (cost: number, m: PriceMatch): number => {
    if (p.manualPrice !== null && primary && m.start === primary.start) return p.manualPrice;
    // The rounding step is in the reseller's own currency; leave foreign-currency prices unrounded.
    const foreign = symbolFor(m.currency, settings.currencySymbol) !== settings.currencySymbol;
    return resalePrice(cost, foreign ? { ...rules, roundingStep: 0 } : rules);
  };

  const cleaned = cleanCaption(p.rawCaption, {
    contactLine: settings.contactLine,
    currencySymbol: settings.currencySymbol,
    resale: price,
    stripPhrases: vendor?.stripPhrases,
  });

  return {
    caption: cleaned.text,
    cost: cleaned.primary?.value ?? null,
    price: cleaned.primary ? price(cleaned.primary.value, cleaned.primary) : null,
    removed: cleaned.removed,
  };
}
