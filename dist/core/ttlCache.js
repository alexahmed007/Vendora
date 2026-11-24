/**
 * Tiny bounded TTL cache. Oldest entries are evicted once `max` is reached, so
 * memory use per tenant has a hard ceiling no matter how busy a group gets.
 */
export class TtlCache {
    ttlMs;
    max;
    entries = new Map();
    constructor(ttlMs, max) {
        this.ttlMs = ttlMs;
        this.max = max;
    }
    get(key) {
        const entry = this.entries.get(key);
        if (!entry)
            return undefined;
        if (entry.expires <= Date.now()) {
            this.entries.delete(key);
            return undefined;
        }
        return entry.value;
    }
    set(key, value) {
        this.entries.delete(key); // re-insert so insertion order tracks recency
        if (this.entries.size >= this.max) {
            const oldest = this.entries.keys().next();
            if (!oldest.done)
                this.entries.delete(oldest.value);
        }
        this.entries.set(key, { value, expires: Date.now() + this.ttlMs });
    }
    delete(key) {
        this.entries.delete(key);
    }
    clear() {
        this.entries.clear();
    }
    get size() {
        return this.entries.size;
    }
}
