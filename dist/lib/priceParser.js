import { phoneSpans } from './patterns.js';
// currency prefix? number (with thousands commas / decimals) k-suffix? currency-word suffix?
// "N" must be uppercase and not part of a word; horizontal whitespace only (never crosses lines).
const NUMBER_RE = () => new RegExp(String.raw `(?<![\p{L}\d/])(?:(?<cur>GH₵|NGN|GHS|USD|₦|₵|\$|£|€|#|N)[ \t]?)?(?<int>\d{1,3}(?:,\d{3})+|\d{1,3}(?:\.\d{3})+(?!\d)|\d+)(?<dec>\.\d+)?(?<k>[kK](?![\p{L}\d]))?(?:[ \t]?(?<cursuf>naira|ngn|usd|dollars?|cedis?|ghs)\b)?`, 'gu');
const PRICE_WORDS = /\b(price|prize|pr[i1]ce|cost|selling|sell|sells|now|only|each|per|for|special|offer|discount|amount|wholesale|retail|bulk|dealer|srp|at)\b|[@=:–—]|[💰💵🏷🤑]/iu;
const UNIT_AFTER = /^[ \t]?(pcs?|pieces?|pairs?|yards?|yds?|inch(?:es)?|cm|mm|m|kg|g|gm|ml|l|ltrs?|litres?|liters?|gb|tb|mb|mah|ram|rom|watts?|w|v|volts?|hz|%|x|dozens?|packs?|sets?|cartons?|bundles?|rolls?|sizes?|colou?rs?|days?|hrs?|hours?|months?|years?|yrs?|am|pm|st|nd|rd|th)\b/i;
const LINE_TAIL = /^[\s.,!;:)\]\-–_*~🔥💰👍✅😍]*$/u;
const PRE_EXCLUDE = /(?:size|sizes|sz|qty|quantity|no|nos|number|code|ref|model|lot|batch|age|pack of|set of|x)[ \t]*[:.\-]?[ \t]*$/i;
const OLD_RE = /\b(was|old\s*price|before|formerly|initial|previous|slashed)\b/i;
const WHOLESALE_RE = /\b(whole\s?sale|bulk|dealer|trade|supplier|vendor|cost)\b/i;
const RETAIL_RE = /\b(retail|srp|rrp|selling|sell|sells|market|shop\s*price)\b/i;
const NAIRA_MARKS = new Set(['#', 'N']);
/**
 * Find every price in a vendor caption. It is deliberately conservative: sizes ("size 40-45"),
 * quantities ("10pcs", "500ml", "128GB"), years, percentages and phone numbers are not prices.
 * A bare number only counts if it is >= 100 and either sits on a price-ish line or is >= 1000.
 */
export function parsePrices(text) {
    const phones = phoneSpans(text);
    const out = [];
    const prevEndByLine = new Map();
    for (const m of text.matchAll(NUMBER_RE())) {
        const g = m.groups;
        const start = m.index;
        const end = start + m[0].length;
        if (phones.some(([a, b]) => start < b && end > a))
            continue;
        // "8,000" and the dot style "8.000" (exactly 3 digits after each dot) both mean eight thousand.
        const grouped = /[,.]/.test(g.int);
        const intPart = g.int.replace(/[,.]/g, '');
        if (intPart.length > 1 && intPart.startsWith('0') && !g.cur)
            continue; // 0803..., not a price
        const hasMarker = Boolean(g.cur || g.k || g.cursuf);
        if (!hasMarker && intPart.length >= 9)
            continue; // too long to be a bare price
        let value = Number(intPart + (g.dec ?? ''));
        if (g.k)
            value *= 1000;
        if (!Number.isFinite(value) || value <= 0)
            continue;
        if (g.cur && NAIRA_MARKS.has(g.cur) && !g.k && value < 100)
            continue; // "#1 seller", "N5"
        const lineStart = text.lastIndexOf('\n', start - 1) + 1;
        const nl = text.indexOf('\n', end);
        const lineEnd = nl === -1 ? text.length : nl;
        const before = text.slice(lineStart, start);
        const after = text.slice(end, Math.min(lineEnd, end + 24));
        let confidence;
        if (hasMarker) {
            confidence = 'high';
        }
        else {
            if (value < 100)
                continue;
            if (UNIT_AFTER.test(after) || PRE_EXCLUDE.test(before))
                continue;
            if (!grouped && value >= 1900 && value <= 2100 && Number.isInteger(value) && !PRICE_WORDS.test(before))
                continue; // a year
            const lineTail = LINE_TAIL.test(after); // nothing after it but punctuation / emoji
            const hasLabel = /\p{L}{2,}/u.test(before); // product words in front of it
            if (PRICE_WORDS.test(before) || PRICE_WORDS.test(after.slice(0, 12)))
                confidence = 'medium';
            else if (grouped && value >= 1000)
                confidence = 'medium'; // "8,000" / "8.000": written like a price
            else if (lineTail && hasLabel && value >= 200)
                confidence = 'medium'; // "Kenwood electric kettle 8000"
            else if (value >= 1000)
                confidence = 'low';
            else
                continue;
        }
        // Label = text since the previous price on this line (so "Was 10,000 now 8,000" labels each correctly),
        // or the previous line when this one starts with the price.
        const labelFrom = Math.max(prevEndByLine.get(lineStart) ?? lineStart, lineStart);
        let label = text.slice(labelFrom, start).slice(-40);
        if (label.trim() === '' && lineStart > 0) {
            // A line that starts with the price borrows the label from the line above, but only when that
            // line is a pure label ("Wholesale price:"), not another priced line ("₦12.5k wholesale").
            const prevLineStart = text.lastIndexOf('\n', lineStart - 2) + 1;
            const prevLine = text.slice(prevLineStart, lineStart - 1);
            if (!/\d/.test(prevLine))
                label = prevLine.slice(-40);
        }
        const struck = (text.slice(lineStart, start).match(/~/g) ?? []).length % 2 === 1; // ~old price~
        const tail = after.slice(0, 20);
        let kind = 'unspecified';
        if (struck || OLD_RE.test(label))
            kind = 'old';
        else if (WHOLESALE_RE.test(label) || WHOLESALE_RE.test(tail))
            kind = 'wholesale';
        else if (RETAIL_RE.test(label) || RETAIL_RE.test(tail))
            kind = 'retail';
        prevEndByLine.set(lineStart, end);
        out.push({ value, start, end, raw: m[0], currency: g.cur ?? (g.cursuf ? g.cursuf : null), kind, confidence });
    }
    return out;
}
const KIND_RANK = { wholesale: 0, unspecified: 1, retail: 2, old: 9 };
const CONF_RANK = { high: 0, medium: 1, low: 2 };
/** The vendor's cost for this item: wholesale beats unspecified beats retail; never an "old" price. */
export function pickPrimary(matches) {
    const candidates = matches.filter((m) => m.kind !== 'old');
    if (!candidates.length)
        return null;
    return [...candidates].sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || CONF_RANK[a.confidence] - CONF_RANK[b.confidence] || a.start - b.start)[0];
}
