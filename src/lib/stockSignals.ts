/** Vendor replies like "sold out" or "restocked", usually quoting the original post. */
export type StockSignal = 'soldout' | 'restock';

const SOLD_OUT = /\b(sold\s?out|out\s+of\s+stock|oos|finished|no\s+more|not\s+available|unavailable|all\s+gone|na\s+finish)\b/i;
const RESTOCK = /\b(restock(?:ed)?|back\s+in\s+stock|available\s+again|now\s+available|new\s+stock|just\s+arrived)\b/i;

export function detectStockSignal(text: string): StockSignal | null {
  const t = text.trim();
  if (!t || t.length > 120) return null; // long captions are new posts, not status replies
  if (SOLD_OUT.test(t)) return 'soldout';
  if (RESTOCK.test(t)) return 'restock';
  return null;
}
