import type { MediaDescriptor } from './mediaInfo.js';

export interface GroupItem {
  id: string;
  /** Arrival time in ms (the caller supplies it, which keeps this module pure and testable). */
  at: number;
  text: string;
  media: MediaDescriptor | null;
  quotedId: string | null;
  /** From an album header message: how many photos/videos to expect. */
  expected?: number;
}

export interface ItemGroup {
  chatId: string;
  sender: string;
  items: GroupItem[];
  media: MediaDescriptor[];
  /** Captions merged in arrival order, exact duplicates removed. */
  caption: string;
  quotedId: string | null;
  firstAt: number;
  lastAt: number;
  reason: 'quiet' | 'full' | 'split' | 'evicted' | 'flush';
}

export interface GrouperOptions {
  /** Close a group after this long with no new message. */
  quietMs: number;
  /** Close early (after this long) once an album header's expected count has arrived. */
  albumGraceMs: number;
  /**
   * A new message arriving after a gap longer than this, to a group that already has media AND a
   * caption, starts a new item. Vendors post products back to back; albums arrive in quick bursts.
   */
  burstMs: number;
  maxItems: number;
  maxOpen: number;
}

export const DEFAULT_GROUPER: GrouperOptions = { quietMs: 20_000, albumGraceMs: 4_000, burstMs: 8_000, maxItems: 12, maxOpen: 50 };

interface Open {
  chatId: string;
  sender: string;
  items: GroupItem[];
  firstAt: number;
  lastAt: number;
}

const mediaCount = (g: Open) => g.items.filter((i) => i.media).length;
const hasCaption = (g: Open) => g.items.some((i) => i.text.trim() !== '');
const expectedOf = (g: Open) => g.items.find((i) => i.expected)?.expected;

function finish(g: Open, reason: ItemGroup['reason']): ItemGroup {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const i of g.items) {
    const t = i.text.trim();
    if (t && !seen.has(t)) { seen.add(t); parts.push(t); }
  }
  return {
    chatId: g.chatId,
    sender: g.sender,
    items: g.items,
    media: g.items.flatMap((i) => (i.media ? [i.media] : [])),
    caption: parts.join('\n'),
    quotedId: g.items.find((i) => i.quotedId)?.quotedId ?? null,
    firstAt: g.firstAt,
    lastAt: g.lastAt,
    reason,
  };
}

/**
 * Collects a vendor's photos, videos and caption text into one "item" per product.
 * Pure and time-driven: feed it messages with add(), and call sweep() on a timer.
 */
export class AlbumGrouper {
  private readonly open = new Map<string, Open>();
  private readonly opts: GrouperOptions;

  constructor(opts: Partial<GrouperOptions> = {}) {
    this.opts = { ...DEFAULT_GROUPER, ...opts };
  }

  get size(): number {
    return this.open.size;
  }

  /** Add a message; returns any groups that closed as a result (split, full, or evicted). */
  add(chatId: string, sender: string, item: GroupItem): ItemGroup[] {
    const key = `${chatId}|${sender}`;
    const closed: ItemGroup[] = [];

    let g = this.open.get(key);
    if (g && this.startsNewProduct(g, item)) {
      closed.push(finish(g, 'split'));
      this.open.delete(key);
      g = undefined;
    }
    if (!g) {
      if (this.open.size >= this.opts.maxOpen) {
        const oldestKey = this.open.keys().next().value as string | undefined;
        if (oldestKey !== undefined) {
          closed.push(finish(this.open.get(oldestKey)!, 'evicted'));
          this.open.delete(oldestKey);
        }
      }
      g = { chatId, sender, items: [], firstAt: item.at, lastAt: item.at };
      this.open.set(key, g);
    }

    g.items.push(item);
    g.lastAt = item.at;

    if (g.items.length >= this.opts.maxItems) {
      closed.push(finish(g, 'full'));
      this.open.delete(key);
    }
    return closed;
  }

  /**
   * Does `item` belong to a NEW product rather than the open group? Only once the open group already
   * looks complete (it has photos AND a caption). Vendors often forward several products in one go,
   * a second or two apart, so a long pause is not the only sign:
   *  - a photo with its OWN, different caption is a new product (the same caption repeated is the same one)
   *  - a photo straight after a caption text is a new product ("photos, then caption" is the usual order)
   *  - anything after a long pause
   */
  private startsNewProduct(g: Open, item: GroupItem): boolean {
    if (mediaCount(g) === 0 || !hasCaption(g)) return false;
    const norm = (t: string) => t.trim().replace(/\s+/g, ' ').toLowerCase();
    const incomingCaption = item.media && item.text.trim() !== '' ? norm(item.text) : null;
    if (incomingCaption !== null && !g.items.some((i) => norm(i.text) === incomingCaption)) return true;
    const last = g.items[g.items.length - 1];
    if (item.media && last && !last.media && last.text.trim() !== '') return true;
    return item.at - g.lastAt > this.opts.burstMs;
  }

  /** Close every group that has gone quiet. */
  sweep(now: number): ItemGroup[] {
    const closed: ItemGroup[] = [];
    for (const [key, g] of this.open) {
      const exp = expectedOf(g);
      const complete = exp !== undefined && mediaCount(g) >= exp;
      const wait = complete ? this.opts.albumGraceMs : this.opts.quietMs;
      if (now - g.lastAt >= wait) {
        closed.push(finish(g, 'quiet'));
        this.open.delete(key);
      }
    }
    return closed;
  }

  flushAll(): ItemGroup[] {
    const all = [...this.open.values()].map((g) => finish(g, 'flush'));
    this.open.clear();
    return all;
  }
}
