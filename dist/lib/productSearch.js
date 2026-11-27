/**
 * Find which item a customer is asking about from their own words ("how much is the kenwood kettle?").
 * Lexical on purpose: it never invents a match, it only points at items whose words the customer used.
 */
const STOP = new Set(('a an the is are was were be been am im do does did you your yours u i me my we our us it its this that these those there here ' +
    'have has had can could would will shall may might to of for in on at by with from and or but if so than then too very just ' +
    'how much many what which who whom when where why abeg pls please plz wetin dey na go wan want need get got buy price prices cost costs pay ' +
    'available availability stock instock sell selling sold show send see look looking any some one two pic pics picture pictures photo photos image ' +
    'details detail info hi hello hey good morning afternoon evening sir ma madam boss oga still again also pls kindly inquire enquire ask asking about').split(/\s+/));
/** Lowercase words, no stop words, no big numbers (prices, phone numbers), plurals folded. */
export function tokenize(text) {
    const out = [];
    for (const raw of text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').split(' ')) {
        if (raw.length < 2 || STOP.has(raw))
            continue;
        if (/^\d+$/.test(raw) && raw.length > 3)
            continue; // 8000, 08012345678: not a product word
        out.push(raw.length > 3 && raw.endsWith('s') && !raw.endsWith('ss') ? raw.slice(0, -1) : raw);
    }
    return out;
}
export function searchProducts(query, items, opts = {}) {
    const q = [...new Set(tokenize(query))];
    if (q.length === 0 || items.length === 0)
        return [];
    const docs = items.map((item) => ({ item, tokens: new Set(tokenize(item.text)) }));
    const idf = (t) => Math.log(1 + docs.length / (1 + docs.filter((d) => d.tokens.has(t)).length));
    const total = q.reduce((n, t) => n + idf(t), 0);
    const hits = [];
    for (const d of docs) {
        const matched = q.filter((t) => d.tokens.has(t));
        if (matched.length === 0)
            continue;
        const score = matched.reduce((n, t) => n + idf(t), 0) / total;
        if (score >= (opts.minScore ?? 0.5))
            hits.push({ item: d.item, score });
    }
    return hits.sort((a, b) => b.score - a.score || (b.item.createdAt ?? 0) - (a.item.createdAt ?? 0)).slice(0, opts.limit ?? 3);
}
