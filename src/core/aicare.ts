import { config } from '../config.js';
import { buildMessages, buildSystemPrompt, type ProductFacts, type Turn } from '../lib/aiPrompt.js';
import { parsePrices } from '../lib/priceParser.js';
import { formatMoney } from '../lib/pricingEngine.js';
import { inQuietHours, localParts } from '../lib/postingPolicy.js';
import { searchProducts } from '../lib/productSearch.js';
import { GENERIC_FORBIDDEN, checkReply, isAffirmative, isBargain, isNoReplyText, isOrderIntent, needsHuman, parseHandoff } from '../lib/replyGuard.js';
import { throughAiGate, type AiClient } from './ai.js';
import { listProducts, type Product } from './catalog.js';
import { addAiLog, addLead, type Lead } from './leads.js';
import { notifyOwner } from './publisher.js';
import { renderProduct } from './render.js';
import { getSettings, type TenantSettings } from './settings.js';
import type { TenantContext } from './tenantContext.js';
import { TtlCache } from './ttlCache.js';
import { getVendor, listVendors } from './vendors.js';

/**
 * Answers a customer's question about the reseller's items, safely:
 *  1. find the item (from the post they replied to, or from their own words)
 *  2. rules first: "speak to the owner", "I want to buy", "last price" go to the owner, no model involved
 *  3. otherwise ask the model, giving it ONLY the item facts and shop info
 *  4. check the reply (no invented prices, no leaks); anything doubtful becomes a hand-off to the owner
 */

export interface Inquiry {
  channel: 'dm' | 'group' | 'status';
  /** Where the reply goes. */
  chatId: string;
  customerId: string;
  customerName: string;
  /** Phone digits when known (a wa.me link for the owner). */
  customerPhone: string | null;
  /** One message, or a burst typed in quick succession. */
  texts: string[];
  /** Item from the post/status they replied to, when known. */
  productId: string | null;
  /** The customer sent a photo/voice note/file instead of text. */
  media?: boolean;
}

export interface Outcome {
  kind: 'reply' | 'handoff' | 'skip';
  reply?: string;
  reason: string;
  productId?: string | null;
  item?: string;
}

export interface AnswerDeps {
  ai: AiClient;
  now?: () => number;
  /** Owner test: ignore the mode and caps, send and record nothing. */
  test?: boolean;
}

export const MESSAGES = {
  hold: 'Let me confirm that with the owner and get back to you shortly 🙏',
  human: 'Sure, I’ve asked the owner to reach out to you personally. Thank you for your patience 🙏',
  bargain: 'I’ll check with the owner about the price and get back to you shortly 🙏',
  media: 'Thanks! I’ve passed this to the owner and they’ll get back to you shortly 🙏',
  order: (title: string) => `Great choice! 🎉 I’ve let the owner know you’d like ${title ? `the ${title}` : 'this'}. They’ll confirm availability and payment details with you shortly.`,
};

const VISIBLE = new Set(['posted', 'queued', 'approved', 'soldout']);
const titleOf = (caption: string) => (caption.split('\n').find((l) => l.trim()) ?? 'item').trim().slice(0, 60);

// ── per-tenant memory (small, in RAM, short-lived) ──────────────────────────

interface Memory { history: Turn[]; productId: string | null }
const memories = new WeakMap<TenantContext, TtlCache<Memory>>();
const memoryOf = (ctx: TenantContext, chatId: string): Memory => {
  let cache = memories.get(ctx);
  if (!cache) memories.set(ctx, (cache = new TtlCache<Memory>(30 * 60_000, 500)));
  let m = cache.get(chatId);
  if (!m) { m = { history: [], productId: null }; cache.set(chatId, m); }
  return m;
};

const perCustomer = new WeakMap<TenantContext, TtlCache<number[]>>();
function allowCustomer(ctx: TenantContext, customerId: string, now: number): boolean {
  let cache = perCustomer.get(ctx);
  if (!cache) perCustomer.set(ctx, (cache = new TtlCache<number[]>(3_600_000, 2_000)));
  const recent = (cache.get(customerId) ?? []).filter((t) => now - t < 3_600_000);
  if (recent.length >= config.aiCustomerHourlyCap) return false;
  cache.set(customerId, [...recent, now]);
  return true;
}

const stats = (ctx: TenantContext) => ctx.store('ai_stats');
export const aiSentOn = async (ctx: TenantContext, day: string): Promise<number> => (((await stats(ctx).get(`day:${day}`)) as { n: number } | null)?.n) ?? 0;
const countAi = (ctx: TenantContext, day: string) => stats(ctx).mutate(`day:${day}`, (c: { n: number } | null) => ({ n: (c?.n ?? 0) + 1 }));

/** Is the shop inside its business hours right now (local time)? */
export function isOpenNow(s: Pick<TenantSettings, 'hoursStart' | 'hoursEnd'>, now: number): boolean {
  const { hour } = localParts(now, config.timeZone);
  return !inQuietHours(hour, s.hoursEnd, s.hoursStart); // closed from hoursEnd up to hoursStart
}

function allowedAmounts(prices: number[], shopInfo: string): number[] {
  const out = new Set<number>();
  for (const p of prices) for (let k = 1; k <= 50; k++) out.add(Math.round(p * k * 100) / 100); // quantities
  for (const m of parsePrices(shopInfo)) out.add(m.value); // e.g. a delivery fee the owner wrote
  return [...out];
}

// ── the answer ──────────────────────────────────────────────────────────────

export async function answerInquiry(ctx: TenantContext, q: Inquiry, deps: AnswerDeps): Promise<Outcome> {
  const now = (deps.now ?? Date.now)();
  const settings = await getSettings(ctx);
  const day = localParts(now, config.timeZone).day;

  if (!deps.test) {
    if (settings.aiMode === 'off') return { kind: 'skip', reason: 'off' };
    if ((await aiSentOn(ctx, day)) >= settings.aiDailyCap) {
      await notifyOwner(ctx, `ai-cap:${day}`, `🤖 The assistant reached today’s limit of ${settings.aiDailyCap} replies and has stopped answering until tomorrow. Raise it in .menu → AI customer care → Timing & limits.`);
      return { kind: 'skip', reason: 'daily-cap' };
    }
    if (!allowCustomer(ctx, q.customerId, now)) return { kind: 'skip', reason: 'customer-cap' };
  }

  const text = q.texts.join('\n').trim();
  if (!q.media && isNoReplyText(text)) return { kind: 'skip', reason: 'no-reply-needed' };

  const mem = memoryOf(ctx, q.chatId);
  const all = (await listProducts(ctx)).filter((p) => VISIBLE.has(p.status));

  // Which item is this about?
  let focus: Product | null = q.productId ? (all.find((p) => p.id === q.productId) ?? null) : null;
  let candidates: Product[] = [];
  if (!focus && text) {
    const hits = searchProducts(text, all.map((p) => ({ id: p.id, text: p.rawCaption, createdAt: p.createdAt })));
    candidates = hits.map((h) => all.find((p) => p.id === h.item.id)!);
    if (hits.length === 1 || (hits.length > 1 && hits[0].score - hits[1].score >= 0.25)) { focus = candidates[0]; candidates = []; }
    else if (hits.length === 0 && mem.productId) focus = all.find((p) => p.id === mem.productId) ?? null; // "and the blue one?"
  }
  const shown = focus ? [focus] : candidates;

  const vendors = await listVendors(ctx);
  const facts: ProductFacts[] = [];
  const prices: number[] = [];
  for (const p of shown) {
    const r = renderProduct(p, settings, vendors.find((v) => v.chatId === p.vendorChatId) ?? null);
    if (r.price !== null) prices.push(r.price);
    facts.push({ title: titleOf(r.caption), caption: r.caption, price: r.price !== null ? formatMoney(r.price, settings.currencySymbol) : null, soldOut: p.status === 'soldout' });
  }
  const itemTitle = focus ? facts[0].title : '';
  const product = focus?.id ?? null;

  // The owner takes over: no model call, a hand-off message, a lead and a private notice.
  const handoff = async (reply: string, kind: Lead['kind'], reason: string): Promise<Outcome> => {
    if (!deps.test) {
      await addLead(ctx, { customerId: q.customerId, customerName: q.customerName, phone: q.customerPhone, chatId: q.chatId, kind, text: text.slice(0, 300), productId: product, productTitle: itemTitle }, now);
      const label = { order: 'wants to order', human: 'asked for you', bargain: 'asked about the price', question: 'asked something I couldn’t answer', media: 'sent a photo or file' }[kind];
      const link = q.customerPhone ? `\nReply to them: https://wa.me/${q.customerPhone}` : '';
      await notifyOwner(ctx, `lead:${q.customerId}:${kind}`, `🙋 *${q.customerName || q.customerId}* ${label}${q.media ? '' : `: “${text.slice(0, 120)}”`}${itemTitle ? `\nItem: ${itemTitle}` : ''}${link}`);
      await countAi(ctx, day);
      await addAiLog(ctx, { at: now, channel: q.channel, customer: q.customerName || q.customerId, asked: text.slice(0, 200), answered: reply.slice(0, 300), kind: 'handoff', reason, item: itemTitle });
    }
    return { kind: 'handoff', reply, reason, productId: product, item: itemTitle };
  };

  if (q.media) return handoff(MESSAGES.media, 'media', 'media');
  if (needsHuman(text)) return handoff(MESSAGES.human, 'human', 'asked-for-human');
  if (isOrderIntent(text)) return handoff(MESSAGES.order(itemTitle), 'order', 'order-intent');
  // "yes please" right after the assistant offered to tell the owner is an order.
  const lastBot = [...mem.history].reverse().find((t) => t.role === 'assistant')?.content ?? '';
  if (isAffirmative(text) && /\bowner\b/i.test(lastBot)) return handoff(MESSAGES.order(itemTitle), 'order', 'order-intent');
  if (isBargain(text)) return handoff(MESSAGES.bargain, 'bargain', 'bargain');

  let raw: string;
  try {
    const hours = settings.hoursStart === settings.hoursEnd ? '' : `${settings.hoursStart}:00 to ${settings.hoursEnd}:00 (${config.timeZone})`;
    const system = buildSystemPrompt({
      brand: settings.brandName,
      products: facts,
      shopInfo: settings.shopInfo,
      instructions: settings.aiInstructions,
      hours,
      channel: q.channel,
      closed: !isOpenNow(settings, now),
    });
    raw = await throughAiGate(config.aiMaxConcurrent, () => deps.ai.complete({ system, messages: buildMessages(mem.history, text), maxTokens: 250, temperature: 0.3 }));
  } catch (err) {
    ctx.log.error(`ai: ${(err as Error).message}`);
    return handoff(MESSAGES.hold, 'question', 'ai-unavailable');
  }

  const parsed = parseHandoff(raw);
  const guard = checkReply({
    reply: parsed.text || MESSAGES.hold,
    allowedAmounts: allowedAmounts(prices, settings.shopInfo),
    forbiddenTerms: [...GENERIC_FORBIDDEN, ...vendors.map((v) => v.name), ...shown.map((p) => p.vendorName)],
  });
  if (!guard.ok) {
    ctx.log.warn(`ai reply blocked (${guard.reason}${guard.detail ? `: ${guard.detail}` : ''})`);
    return handoff(MESSAGES.hold, 'question', `guard:${guard.reason}`);
  }
  if (parsed.handoff) return handoff(guard.text, 'question', 'model-handoff');

  mem.history.push({ role: 'user', content: text.slice(0, 600) }, { role: 'assistant', content: guard.text });
  mem.history.splice(0, Math.max(0, mem.history.length - 12));
  if (product) mem.productId = product;

  if (!deps.test) {
    await countAi(ctx, day);
    await addAiLog(ctx, { at: now, channel: q.channel, customer: q.customerName || q.customerId, asked: text.slice(0, 200), answered: guard.text.slice(0, 300), kind: 'reply', reason: 'answered', item: itemTitle });
  }
  return { kind: 'reply', reply: guard.text, reason: 'answered', productId: product, item: itemTitle };
}

/** Does this vendor group name show up anywhere (used by the plugin to never answer in vendor groups)? */
export const isVendorChat = async (ctx: TenantContext, chatId: string) => Boolean(await getVendor(ctx, chatId));
