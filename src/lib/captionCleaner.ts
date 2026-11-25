import { CONTACT_WORDS, PROMO_LINE, handleRe, phoneRe, urlRe } from './patterns.js';
import { parsePrices, pickPrimary, type PriceMatch } from './priceParser.js';
import { formatMoney, symbolFor } from './pricingEngine.js';

export interface CleanOptions {
  /** Appended as the last line, replacing the vendor's contact details. */
  contactLine?: string;
  /** Symbol to use when the vendor wrote a bare number. */
  currencySymbol: string;
  /** Maps a vendor price to the reseller's price. */
  resale: (cost: number, match: PriceMatch) => number;
  /** Drop lines that only show a retail price when a wholesale price exists (default true). */
  dropRetail?: boolean;
  /** Vendor watermarks / slogans to remove, matched literally and case-insensitively. */
  stripPhrases?: string[];
}

export interface CleanResult {
  text: string;
  matches: PriceMatch[];
  primary: PriceMatch | null;
  removed: { phones: number; links: number; lines: number };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const countMatches = (re: RegExp, s: string) => (s.match(re) ?? []).length;

/** Words left on a line once numbers, links, handles, emoji and punctuation are removed. */
function wordsLeft(line: string): number {
  const stripped = line
    .replace(phoneRe(), ' ')
    .replace(urlRe(), ' ')
    .replace(handleRe(), ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ');
  return stripped.split(/\s+/).filter((w) => w.length > 1).length;
}

/**
 * Turn a vendor's caption into the reseller's caption: remove the vendor's phone numbers, links,
 * handles and promo lines, replace every price with the reseller's price, and add the reseller's
 * contact line. Pure: no network, no store.
 */
export function cleanCaption(raw: string, opts: CleanOptions): CleanResult {
  const matches = parsePrices(raw);
  const primary = pickPrimary(matches);
  const hasWholesale = matches.some((m) => m.kind === 'wholesale');
  const dropRetail = (opts.dropRetail ?? true) && hasWholesale;
  const phrases = (opts.stripPhrases ?? []).filter(Boolean).map((p) => new RegExp(escapeRe(p), 'gi'));
  const removed = { phones: 0, links: 0, lines: 0 };

  const kept: string[] = [];
  let offset = 0;
  for (const original of raw.split('\n')) {
    const lineStart = offset;
    const lineEnd = lineStart + original.length;
    offset = lineEnd + 1;

    const here = matches.filter((m) => m.start >= lineStart && m.end <= lineEnd);
    const drop = () => { removed.lines++; };

    // Lines that only carry an old (struck-through / "was") price or a retail price we're replacing.
    if (here.length > 0 && here.every((m) => m.kind === 'old')) { drop(); continue; }
    if (dropRetail && here.length > 0 && here.every((m) => m.kind === 'retail')) { drop(); continue; }

    // Replace prices right-to-left so earlier offsets stay valid. Old prices inside mixed lines are cut out.
    let line = original;
    for (const m of [...here].reverse()) {
      const a = m.start - lineStart;
      const b = m.end - lineStart;
      if (m.kind === 'old') {
        const head = line.slice(0, a).replace(/(?:was|old\s*price|before|formerly|initial|previous)[\s:\-–]*$/i, '');
        line = head + line.slice(b);
      } else if (dropRetail && m.kind === 'retail') {
        line = line.slice(0, a) + line.slice(b);
      } else {
        const symbol = symbolFor(m.currency, opts.currencySymbol);
        line = line.slice(0, a) + formatMoney(opts.resale(m.value, m), symbol) + line.slice(b);
      }
    }

    line = line.replace(/~\s*~/g, ' '); // empty strike-through markers left by a removed old price
    // The reseller's price is not "wholesale": drop the vendor's trade label next to a replaced price.
    if (here.some((m) => m.kind === 'wholesale')) {
      line = line.replace(/\b(?:whole\s?sale|dealer|supplier|trade|cost)(?:[ \t]+price)?\b[ \t]*[:\-–]?[ \t]*/gi, '');
    }

    // Vendor watermarks and slogans.
    for (const re of phrases) line = line.replace(re, '');

    const phones = countMatches(phoneRe(), line);
    const links = countMatches(urlRe(), line) + countMatches(handleRe(), line);
    const hasContactBits = phones + links > 0;

    // A line that is just the vendor's contact details (or a promo) goes entirely.
    if (hasContactBits && (CONTACT_WORDS.test(line) || wordsLeft(line) <= 3)) {
      removed.phones += phones; removed.links += links; drop(); continue;
    }
    if (PROMO_LINE.test(line)) { removed.links += links; drop(); continue; }
    if (!hasContactBits && CONTACT_WORDS.test(line) && wordsLeft(line) <= 3 && /[:\-–]\s*$/.test(line.trim())) { drop(); continue; } // "Call to order:"

    // Otherwise just cut the contact bits out of a line that has real content.
    if (hasContactBits) {
      line = line.replace(phoneRe(), '').replace(urlRe(), '').replace(handleRe(), '');
      removed.phones += phones; removed.links += links;
    }
    kept.push(line.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+$/g, '').replace(/^[ \t]+(?=\S)/, (s) => s));
  }

  let text = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (opts.contactLine?.trim()) text = `${text}${text ? '\n\n' : ''}${opts.contactLine.trim()}`;
  return { text, matches, primary, removed };
}
