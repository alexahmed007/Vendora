/**
 * Talks to a language model. Providers are tried in order until one answers, so one provider
 * having a bad day doesn't take customer care down. Keys belong to the platform (you), not to
 * each reseller; per-reseller daily caps (see aicare.ts) keep the cost predictable.
 *
 * Configure any of these in the environment:
 *   AI_BASE_URL + AI_API_KEY (+ AI_MODEL)   any OpenAI-compatible endpoint
 *   GROQ_API_KEY (+ GROQ_MODEL)             Groq
 *   GEMINI_API_KEY (+ GEMINI_MODEL)         Google Gemini
 */
export class AiUnavailableError extends Error {
}
function openAiCompatible(name, baseUrl, apiKey, model, fetchImpl) {
    return {
        name,
        async call(req, signal) {
            const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
                body: JSON.stringify({
                    model,
                    temperature: req.temperature ?? 0.3,
                    max_tokens: req.maxTokens ?? 300,
                    messages: [{ role: 'system', content: req.system }, ...req.messages],
                }),
                signal,
            });
            if (!res.ok)
                throw new Error(`${name} HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
            const text = (await res.json())?.choices?.[0]?.message?.content;
            if (typeof text !== 'string' || !text.trim())
                throw new Error(`${name} returned no text`);
            return text;
        },
    };
}
function gemini(apiKey, model, fetchImpl) {
    return {
        name: 'gemini',
        async call(req, signal) {
            const res = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    systemInstruction: { parts: [{ text: req.system }] },
                    contents: req.messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
                    // thinkingBudget 0: no hidden "thinking" tokens eating the answer (avoids truncated replies)
                    generationConfig: { temperature: req.temperature ?? 0.3, maxOutputTokens: req.maxTokens ?? 300, thinkingConfig: { thinkingBudget: 0 } },
                }),
                signal,
            });
            if (!res.ok)
                throw new Error(`gemini HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
            const parts = (await res.json())?.candidates?.[0]?.content?.parts ?? [];
            const text = parts.map((p) => p.text ?? '').join('').trim();
            if (!text)
                throw new Error('gemini returned no text');
            return text;
        },
    };
}
export function makeAiClient(opts = {}) {
    const env = opts.env ?? process.env;
    const fetchImpl = (opts.fetchImpl ?? ((url, init) => fetch(url, init)));
    const timeoutMs = opts.timeoutMs ?? 15_000;
    const providers = [];
    if (env.AI_BASE_URL && env.AI_API_KEY)
        providers.push(openAiCompatible('custom', env.AI_BASE_URL, env.AI_API_KEY, env.AI_MODEL || 'gpt-4o-mini', fetchImpl));
    if (env.GROQ_API_KEY)
        providers.push(openAiCompatible('groq', 'https://api.groq.com/openai/v1', env.GROQ_API_KEY, env.GROQ_MODEL || 'llama-3.3-70b-versatile', fetchImpl));
    if (env.GEMINI_API_KEY)
        providers.push(gemini(env.GEMINI_API_KEY, env.GEMINI_MODEL || 'gemini-2.5-flash', fetchImpl));
    const coolUntil = new Map(); // a provider that just failed is skipped briefly
    return {
        providers: providers.length,
        async complete(req) {
            if (providers.length === 0)
                throw new AiUnavailableError('no AI provider is configured');
            const errors = [];
            const now = Date.now();
            // Healthy providers first; ones in their cool-down only as a last resort.
            const ordered = [...providers].sort((a, b) => Number((coolUntil.get(a.name) ?? 0) > now) - Number((coolUntil.get(b.name) ?? 0) > now));
            for (const p of ordered) {
                const ctl = new AbortController();
                const timer = setTimeout(() => ctl.abort(), timeoutMs);
                try {
                    const text = await p.call(req, ctl.signal);
                    coolUntil.delete(p.name);
                    return text;
                }
                catch (err) {
                    errors.push(`${p.name}: ${ctl.signal.aborted ? `timed out after ${timeoutMs}ms` : err.message}`);
                    coolUntil.set(p.name, Date.now() + 60_000);
                }
                finally {
                    clearTimeout(timer);
                }
            }
            throw new AiUnavailableError(`all AI providers failed (${errors.join(' | ')})`);
        },
    };
}
// ── shared instance (tests swap it) ─────────────────────────────────────────
let shared = null;
export const getAi = () => (shared ??= makeAiClient());
export const setAiClient = (c) => { shared = c; };
// ── concurrency gate: at most N model calls in flight across ALL tenants ─────
let inFlight = 0;
const waiting = [];
export async function throughAiGate(limit, work) {
    if (inFlight >= limit)
        await new Promise((resolve) => waiting.push(resolve));
    inFlight++;
    try {
        return await work();
    }
    finally {
        inFlight--;
        waiting.shift()?.();
    }
}
