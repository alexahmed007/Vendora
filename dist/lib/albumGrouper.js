export const DEFAULT_GROUPER = { quietMs: 20_000, albumGraceMs: 4_000, burstMs: 8_000, maxItems: 12, maxOpen: 50 };
const mediaCount = (g) => g.items.filter((i) => i.media).length;
const hasCaption = (g) => g.items.some((i) => i.text.trim() !== '');
const expectedOf = (g) => g.items.find((i) => i.expected)?.expected;
function finish(g, reason) {
    const seen = new Set();
    const parts = [];
    for (const i of g.items) {
        const t = i.text.trim();
        if (t && !seen.has(t)) {
            seen.add(t);
            parts.push(t);
        }
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
    open = new Map();
    opts;
    constructor(opts = {}) {
        this.opts = { ...DEFAULT_GROUPER, ...opts };
    }
    get size() {
        return this.open.size;
    }
    /** Add a message; returns any groups that closed as a result (split, full, or evicted). */
    add(chatId, sender, item) {
        const key = `${chatId}|${sender}`;
        const closed = [];
        let g = this.open.get(key);
        if (g && this.startsNewProduct(g, item)) {
            closed.push(finish(g, 'split'));
            this.open.delete(key);
            g = undefined;
        }
        if (!g) {
            if (this.open.size >= this.opts.maxOpen) {
                const oldestKey = this.open.keys().next().value;
                if (oldestKey !== undefined) {
                    closed.push(finish(this.open.get(oldestKey), 'evicted'));
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
    startsNewProduct(g, item) {
        if (mediaCount(g) === 0 || !hasCaption(g))
            return false;
        const norm = (t) => t.trim().replace(/\s+/g, ' ').toLowerCase();
        const incomingCaption = item.media && item.text.trim() !== '' ? norm(item.text) : null;
        if (incomingCaption !== null && !g.items.some((i) => norm(i.text) === incomingCaption))
            return true;
        const last = g.items[g.items.length - 1];
        if (item.media && last && !last.media && last.text.trim() !== '')
            return true;
        return item.at - g.lastAt > this.opts.burstMs;
    }
    /** Close every group that has gone quiet. */
    sweep(now) {
        const closed = [];
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
    flushAll() {
        const all = [...this.open.values()].map((g) => finish(g, 'flush'));
        this.open.clear();
        return all;
    }
}
