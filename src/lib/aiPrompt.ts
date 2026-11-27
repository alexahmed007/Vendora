/** Builds what the model is told. Pure: the facts come in, the prompt comes out. */

export interface ProductFacts {
  title: string;
  /** What the customer would have seen in the post (price already replaced by the reseller's). */
  caption: string;
  /** Formatted selling price like "₦9,600", or null when none is set. */
  price: string | null;
  soldOut: boolean;
}

export interface PromptInput {
  brand: string;
  products: ProductFacts[];
  shopInfo: string;
  instructions: string;
  /** e.g. "8:00 to 21:00 (Lagos time)"; empty when always open. */
  hours: string;
  /** Which kind of conversation this is, so the tone fits. */
  channel: 'dm' | 'group' | 'status';
  /** True when the shop is currently closed. */
  closed: boolean;
}

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function buildSystemPrompt(i: PromptInput): string {
  const items = i.products.length
    ? i.products
        .map((p, n) => `${n + 1}. ${p.title}\n   Details: ${cut(p.caption.replace(/\s+/g, ' '), 450)}\n   Price: ${p.price ?? 'not set'} | Status: ${p.soldOut ? 'SOLD OUT' : 'available'}`)
        .join('\n')
    : '(no matching item was found for this message)';

  return [
    `You are the WhatsApp shop assistant for "${i.brand || 'this shop'}". Customers message the shop about items. Reply like a friendly shop attendant: short WhatsApp messages (1 to 3 short sentences), plain text, at most one emoji, no headings or lists.`,
    i.channel === 'group' ? 'This reply is public in a group chat, so keep it brief and do not share anything private.' : '',
    '',
    'RULES (never break these):',
    '1. Use ONLY the information in ITEMS and SHOP INFO below. If the customer asks for something that is not there (sizes, colours, stock count, delivery time, warranty, location...), do not guess: start your whole reply with [HANDOFF] and say you will check with the owner.',
    '2. Prices: only state a price exactly as written in ITEMS. You may multiply it by a quantity the customer asks for (e.g. 2 pieces). Never invent, round, discount or negotiate a price. If they ask for a discount or a "last price", start your reply with [HANDOFF].',
    '3. Never mention suppliers, vendors, wholesale, costs, profit or where the stock comes from.',
    '4. If the customer wants to buy, order or pay, or asks for account details, start your reply with [HANDOFF] and say the owner will confirm availability and payment shortly.',
    '5. If an item is SOLD OUT, say so politely. Do not promise a restock date.',
    '6. If you are not sure which item they mean, ask ONE short question and name up to three items from ITEMS.',
    '7. Reply in the customer\'s language (English or Nigerian Pidgin).',
    '8. Do not say you are an AI or mention any company or model. If asked directly, say you are the shop\'s assistant.',
    '',
    'SHOP INFO (you may quote only this):',
    i.shopInfo.trim() || '(none provided)',
    i.hours ? `Business hours: ${i.hours}${i.closed ? ' (the shop is closed right now; mention that the owner will reply when they open)' : ''}` : '',
    i.instructions.trim() ? `\nExtra style notes from the owner: ${cut(i.instructions.trim(), 300)}` : '',
    '',
    'ITEMS:',
    items,
  ]
    .filter((l) => l !== undefined)
    .join('\n');
}

export interface Turn {
  role: 'user' | 'assistant';
  content: string;
}

/** The last few turns plus the new customer message. History is trimmed so costs stay small. */
export function buildMessages(history: Turn[], customerText: string): Turn[] {
  return [...history.slice(-6), { role: 'user' as const, content: cut(customerText.trim(), 600) }];
}
