import { parsePrices } from './priceParser.js';

/**
 * Safety net between the AI and the customer. A language model can be wrong, so every reply is
 * checked before it is sent: no invented prices, no leaking where stock comes from, nothing odd.
 * Anything that fails is replaced by a "let me check with the owner" hand-off.
 */

export type GuardFailure = 'empty' | 'too-long' | 'price' | 'leak' | 'ai-talk';
export type GuardResult = { ok: true; text: string } | { ok: false; reason: GuardFailure; detail?: string };

export interface GuardInput {
  reply: string;
  /** Amounts the reply may mention: item prices (and multiples for quantities), shop-info amounts. */
  allowedAmounts: number[];
  /** Words that must never reach a customer (vendor names, "wholesale", "cost price"...). */
  forbiddenTerms: string[];
  maxLength?: number;
}

export const GENERIC_FORBIDDEN = ['wholesale', 'supplier', 'vendor', 'markup', 'mark-up', 'profit', 'cost price'];

const AI_TALK = /\b(as an ai|language model|i am an ai|i'm an ai|i am a bot|i'm a bot|openai|chatgpt|gemini|llama|anthropic)\b/i;

/** WhatsApp formatting: **bold** becomes *bold*, stray quotes and blank runs are tidied. */
export function tidy(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/^["“”']+|["“”']+$/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function checkReply(input: GuardInput): GuardResult {
  const text = tidy(input.reply);
  if (!text) return { ok: false, reason: 'empty' };
  if (text.length > (input.maxLength ?? 900)) return { ok: false, reason: 'too-long' };
  if (AI_TALK.test(text)) return { ok: false, reason: 'ai-talk' };

  const lower = text.toLowerCase();
  for (const term of input.forbiddenTerms) {
    if (term.trim().length >= 3 && lower.includes(term.trim().toLowerCase())) return { ok: false, reason: 'leak', detail: term };
  }

  for (const m of parsePrices(text)) {
    if (!input.allowedAmounts.some((a) => Math.abs(a - m.value) < 0.5)) return { ok: false, reason: 'price', detail: m.raw.trim() };
  }
  return { ok: true, text };
}

/** The model marks "I need the owner" by starting with [HANDOFF]. */
export function parseHandoff(raw: string): { handoff: boolean; text: string } {
  const has = /\[\s*handoff\s*\]/i.test(raw);
  return { handoff: has, text: raw.replace(/\[\s*handoff\s*\]/gi, '').trim() };
}

// ── rules that run before the model is called ───────────────────────────────

/** Messages that need no answer ("ok", "thanks", "ok thank you", emoji), so the assistant never chats in circles. */
export function isNoReplyText(text: string): boolean {
  const t = text.trim();
  if (t.length < 2 && !/\d/.test(t)) return true;
  if (!/[\p{L}\p{N}]/u.test(t)) return true; // only emoji / punctuation
  return /^(?:(?:ok(?:ay)?|k|kk|thanks?|thank|you|u|a lot|very much|thx|tnx|noted|alright|cool|nice|great|good|fine|hmm+|lol|amen|bye|goodnight|goodbye|please|pls)[\s.,!👍🙏😊❤️😂🙌]*)+$/iu.test(t);
}

/** "yes", "yes please", "go ahead": an answer to something the assistant just offered. */
export function isAffirmative(text: string): boolean {
  return /^(?:(?:yes|yeah|yep|yea|yup|sure|please|pls|abeg|go ahead|do it|i do|i want|sir|ma)[\s,.!👍🙏😊]*)+$/iu.test(text.trim());
}

/** The customer wants a person, or is upset: don't let a bot improvise. */
export function needsHuman(text: string): boolean {
  return /\b(speak|talk|chat|connect)\s+(to|with)\s+(a\s+|the\s+)?(human|person|owner|agent|manager|someone|somebody)\b|\b(refund|complain|complaint|scam|scammer|fraud|fake|stolen|police|lawyer|sue you|report you|call me|ring me|call back)\b|\bwhere is my (order|item|package|delivery)\b/i.test(text);
}

/** The customer is ready to buy or pay: the owner confirms stock and payment details. */
export function isOrderIntent(text: string): boolean {
  return /\b(i\s*(want|wan|will|go|'ll|would like)\s*(to\s*)?(buy|order|get|take|pay|purchase)|i('ll| will)\s*(take|buy|get)|place\s*(an\s*)?order|how\s*(do|can|should)\s*i\s*(pay|order)|(send|share|give)\s*(me\s*)?(your\s*)?(account|acct|bank)|account\s*(number|no|details)|i\s*want\s*am|add me to|put me down)\b/i.test(text);
}

/** Customers asking for a discount: only the owner decides. */
export function isBargain(text: string): boolean {
  return /\b(last price|discount|reduce|lower (it|the price)|too (much|expensive)|cheaper|best price|negotiat\w*|small small|drop (it|the price))\b/i.test(text);
}
