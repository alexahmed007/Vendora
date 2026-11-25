import { cleanCaption } from '../lib/captionCleaner.js';
import { pickPrimary, parsePrices } from '../lib/priceParser.js';
import { DEFAULT_RULES, resalePrice, symbolFor } from '../lib/pricingEngine.js';
export function rulesFor(settings, vendor) {
    return { ...DEFAULT_RULES, markupPercent: vendor?.markupPercent ?? settings.markupPercent, roundingStep: settings.roundingStep };
}
/**
 * Preview / final text for a product under the reseller's CURRENT settings, so changing markup or
 * contact line later changes every item that hasn't been posted yet.
 */
export function renderProduct(p, settings, vendor) {
    const rules = rulesFor(settings, vendor);
    const primary = pickPrimary(parsePrices(p.rawCaption));
    const price = (cost, m) => {
        if (p.manualPrice !== null && primary && m.start === primary.start)
            return p.manualPrice;
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
