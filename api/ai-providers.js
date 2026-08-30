/* Everything the SERVER needs to know about an LLM provider — and deliberately no more.
 *
 * The request and response translation lives on the client (frontend/src/lib/ai/providers/),
 * next to the exercise catalogue and the training helpers it has to reach. What is left here
 * is the short list of facts the server cannot delegate:
 *
 *   1. where to send it        — a FIXED host per provider, never taken from the request
 *   2. how to authenticate     — the header the decrypted key goes in
 *   3. what it cost            — the usage fields, so the spend cap can be enforced
 *   4. what went wrong         — an error string safe to hand back
 *
 * (1) is a security property, not a convenience. This server already goes to some trouble to
 * keep a user-chosen URL from reaching the Docker network (see the push endpoint's private-address
 * guard); an AI proxy that accepted a base URL from the client would hand that back. If pointing
 * at a local Ollama ever gets built, it gets its own opt-in and its own guard.
 */

/** Anything shaped like an API key, redacted. Provider error bodies sometimes echo the request. */
export const scrubKey = s =>
  String(s == null ? '' : s).replace(/\b(sk-ant-|sk-|AIza)[A-Za-z0-9_\-]{8,}/g, '$1***');

// A model id becomes part of a URL path for Gemini, so it is validated rather than trusted.
export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

export const PROVIDERS = {
  anthropic: {
    label: 'Anthropic',
    keyHint: 'sk-ant-…',
    url: () => 'https://api.anthropic.com/v1/messages',
    headers: key => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' }),
    usageOf: j => ({ in: j?.usage?.input_tokens || 0, out: j?.usage?.output_tokens || 0 })
  },
  openai: {
    label: 'OpenAI',
    keyHint: 'sk-…',
    url: () => 'https://api.openai.com/v1/responses',
    headers: key => ({ authorization: 'Bearer ' + key }),
    usageOf: j => ({ in: j?.usage?.input_tokens || 0, out: j?.usage?.output_tokens || 0 })
  },
  gemini: {
    label: 'Google Gemini',
    keyHint: 'AIza…',
    url: model => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    headers: key => ({ 'x-goog-api-key': key }),
    usageOf: j => ({
      in: j?.usageMetadata?.promptTokenCount || 0,
      out: j?.usageMetadata?.candidatesTokenCount || 0
    })
  }
};

export const PROVIDER_IDS = Object.keys(PROVIDERS);

/* Prices are USD per 1M tokens, checked 2026-08-29 against each vendor's own page:
 *   https://claude.com/pricing
 *   https://developers.openai.com/api/docs/models
 *   https://ai.google.dev/gemini-api/docs/pricing
 * A short list of the models worth offering, not every model each vendor sells. The client
 * receives this table from GET /api/ai/status rather than keeping a second copy that could
 * drift from the one actually enforcing the cap. */
export const MODELS = {
  anthropic: [
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', in: 2, out: 10 },
    { id: 'claude-opus-5', label: 'Claude Opus 5', in: 5, out: 25 },
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', in: 1, out: 5 }
  ],
  openai: [
    { id: 'gpt-5-mini', label: 'GPT-5 mini', in: 0.25, out: 2 },
    { id: 'gpt-5.1', label: 'GPT-5.1', in: 1.25, out: 10 },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', in: 2, out: 12 },
    { id: 'gpt-5-nano', label: 'GPT-5 nano', in: 0.05, out: 0.4 }
  ],
  gemini: [
    { id: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash', in: 0.75, out: 3.75 },
    { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', in: 1.5, out: 9 },
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', in: 1.25, out: 10 }
  ]
};

/** The cheapest capable model of each family — nobody's first experiment should cost more than it had to. */
export const DEFAULT_MODEL = { anthropic: 'claude-sonnet-5', openai: 'gpt-5-mini', gemini: 'gemini-3.7-flash' };

export const priceOf = (provider, model) => (MODELS[provider] || []).find(m => m.id === model) || null;

/**
 * USD for one call, or null when the model is not in the table.
 * Null is a real answer, not a failure: the call still ran and its tokens are still counted.
 * Pricing an unknown model at a guessed rate, and then enforcing a cap with that number, is
 * worse than admitting the spend cannot be estimated.
 */
export function costOf(provider, model, usage) {
  const p = priceOf(provider, model);
  if (!p || !usage) return null;
  return ((Number(usage.in) || 0) * p.in + (Number(usage.out) || 0) * p.out) / 1e6;
}

/** Where a call goes. Throws (never guesses) on an unknown provider or a suspicious model id. */
export function endpointFor(provider, model) {
  const p = PROVIDERS[provider];
  if (!p) throw Object.assign(new Error('unknown provider'), { status: 400 });
  if (!MODEL_RE.test(String(model || ''))) throw Object.assign(new Error('bad model id'), { status: 400 });
  return p.url(model);
}

/** A one-line, scrubbed message out of whatever the provider returned. All three nest it the same way. */
export function errorOf(status, json, textFallback) {
  const m = json?.error?.message || json?.error?.type || json?.message || textFallback;
  return scrubKey(m || `provider returned HTTP ${status}`).slice(0, 400);
}

/**
 * Hold the client's requested output length to the server's ceiling.
 *
 * Each provider spells it differently, and the field is the one part of the body the server
 * genuinely must police: it is the direct lever on what a single call can cost.
 */
export function clampTokens(provider, body, max) {
  if (!body || typeof body !== 'object') return body;
  if (provider === 'anthropic') {
    body.max_tokens = Math.min(Math.max(1, +body.max_tokens || max), max);
  } else if (provider === 'openai') {
    body.max_output_tokens = Math.min(Math.max(1, +body.max_output_tokens || max), max);
  } else if (provider === 'gemini') {
    const g = body.generationConfig || (body.generationConfig = {});
    g.maxOutputTokens = Math.min(Math.max(1, +g.maxOutputTokens || max), max);
  }
  return body;
}
