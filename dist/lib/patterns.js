/**
 * Things vendors put in captions that a reseller must remove: phone numbers, links, handles.
 * Regexes are built fresh on every call because global regexes carry state (lastIndex).
 */
// Nigerian mobiles (0801..., +234 801..., 234801...), other international numbers (+xx ...),
// WhatsApp @-mentions of a number (@2348012345678) and generic 10-11 digit numbers starting with 0.
const PHONE_SRC = String.raw `(?:(?:\+|00)?234[\s.-]?|0)[789][01]\d[\s.-]?\d{3}[\s.-]?\d{4}|\+\d{1,3}[\s.-]?\d{2,4}[\s.-]?\d{3,4}[\s.-]?\d{3,4}|@\d{8,15}|\b0\d{9,10}\b`;
const URL_SRC = String.raw `(?:https?:\/\/|www\.)\S+|\b(?:wa\.me|chat\.whatsapp\.com|t\.me|bit\.ly|linktr\.ee|instagram\.com|facebook\.com|tiktok\.com)\/\S*`;
// @handle (Instagram etc). Must start with a letter so "@5000" (a price marker) is left alone.
const HANDLE_SRC = String.raw `(?<![\w@])@[A-Za-z_][\w.]{2,}`;
export const phoneRe = () => new RegExp(PHONE_SRC, 'g');
export const urlRe = () => new RegExp(URL_SRC, 'gi');
export const handleRe = () => new RegExp(HANDLE_SRC, 'g');
/** Words that make a line a "contact the vendor" line when it also holds a number, link or handle. */
export const CONTACT_WORDS = /\b(call|calls|calling|whats\s?app|whatsapp|wa|dm|inbox|order|orders|contact|chat|reach|text|tel|phone|enquir\w*|inquir\w*|available on|buy now|click|link|visit)\b/i;
/** Self-promotion lines: "follow us on IG", "join our group", "link in bio". */
export const PROMO_LINE = /\b(follow\s+(us|me|our)|join\s+(us|our|the)|link\s+in\s+bio|visit\s+(us|our)|subscribe|like\s+and\s+share|share\s+to\s+your)\b/i;
export function phoneSpans(text) {
    const spans = [];
    for (const m of text.matchAll(phoneRe()))
        spans.push([m.index, m.index + m[0].length]);
    return spans;
}
