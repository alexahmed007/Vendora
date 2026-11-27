import { handleRe, phoneRe, urlRe } from './patterns.js';

/**
 * Pure rules for "may this vendor item go out WITHOUT the owner looking at it?".
 * Auto-post is only as safe as this gate, so it is deliberately strict: anything doubtful is held
 * for the owner (it stays under Items in the dashboard) instead of being posted.
 */

export type AutoHold =
  | 'review'      // the price was missing or a shaky guess
  | 'no-media'
  | 'markup'      // markup is 0%: it would be posted at the vendor's price
  | 'contact'     // vendor phone / email / link / handle is still in the caption
  | 'vendor-name' // the vendor's name is still in the caption
  | 'price-lost'; // the caption no longer shows the selling price (e.g. a line was dropped)

export type AutoVerdict = { ok: true } | { wait: true } | { ok: false; hold: AutoHold; detail?: string };

export interface AutoInput {
  status: string;
  needsReview: boolean;
  cost: number | null;
  manualPrice: number | null;
  mediaCount: number;
  createdAt: number;
  now: number;
  delayMs: number;
  /** Effective markup for this item's vendor (vendor override, else the default). */
  markupPercent: number;
  vendorName: string;
  /** The caption customers would see, WITHOUT the reseller's own contact line. */
  caption: string;
  /** The selling price as shown in the caption (digits and separators only, e.g. "9,600"). */
  priceText: string | null;
}

/** Vendor contact details that survived cleaning: phones (incl. spaced), emails, links, handles. */
export function leftoverContact(caption: string): string | null {
  const probes: Array<[RegExp, string]> = [
    [phoneRe(), 'phone number'],
    [/\b\d{3,4}[ .-]\d{3,4}[ .-]\d{3,4}\b/, 'phone number'],
    [/\d{8,}/, 'long number'],
    [/[\w.+-]+@[\w-]+\.[\w.-]+/, 'email'],
    [urlRe(), 'link'],
    [handleRe(), 'handle'],
    [/\b(?:ig|insta(?:gram)?|tg|telegram|snap(?:chat)?|tiktok|fb|facebook)\b\s*[:@-]\s*\S+/i, 'social handle'],
  ];
  for (const [re, what] of probes) {
    const m = caption.match(re);
    if (m) return `${what}: ${m[0].trim().slice(0, 30)}`;
  }
  return null;
}

export function autoPostVerdict(i: AutoInput): AutoVerdict {
  if (i.status !== 'new') return { ok: false, hold: 'review', detail: `status is ${i.status}` };
  if (i.manualPrice === null && (i.needsReview || i.cost === null)) return { ok: false, hold: 'review' };
  if (i.mediaCount === 0) return { ok: false, hold: 'no-media' };
  if (!(i.markupPercent > 0) && i.manualPrice === null) return { ok: false, hold: 'markup' };

  const leak = leftoverContact(i.caption);
  if (leak) return { ok: false, hold: 'contact', detail: leak };
  const name = i.vendorName.trim().toLowerCase();
  if (name.length >= 4 && i.caption.toLowerCase().includes(name)) return { ok: false, hold: 'vendor-name', detail: i.vendorName };
  if (!i.priceText || !i.caption.includes(i.priceText)) return { ok: false, hold: 'price-lost' };

  // Everything checks out; give vendors a few minutes to say "sold out" or fix a mistake first.
  if (i.now - i.createdAt < i.delayMs) return { wait: true };
  return { ok: true };
}
