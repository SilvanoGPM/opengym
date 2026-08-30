// Turning a call's token usage into money.
//
// The price TABLE is not here — it lives in api/server.js and arrives via GET /api/ai/status.
// That is deliberate: the server is what enforces the monthly cap, so it has to hold the prices
// anyway, and a second copy on the client would be a table that can silently disagree with the
// one doing the enforcing. The client renders what the server tells it.
//
// What lives here is the arithmetic and the formatting — pure, and worth a test.

/** A price is { in, out } in USD per 1M tokens. Returns USD, or null when the model isn't priced. */
export function costOf(price, usage) {
  if (!price || !usage) return null
  const i = Number(price.in), o = Number(price.out)
  if (!Number.isFinite(i) || !Number.isFinite(o)) return null
  return ((Number(usage.in) || 0) * i + (Number(usage.out) || 0) * o) / 1e6
}

/** Look a model up in the { provider: [{ id, label, in, out }] } map the server sends. */
export const priceOf = (models, provider, model) =>
  (models?.[provider] || []).find(m => m.id === model) || null

export const labelOf = (models, provider, model) => priceOf(models, provider, model)?.label || model || ''

/**
 * "$0.023" / "<$0.001" / "—".
 * Two decimals is the wrong resolution here: a real call costs a couple of cents, and rounding
 * every one of them to "$0.02" or "$0.00" makes the running total look either wrong or free.
 */
export function fmtUSD(v) {
  if (v == null || !Number.isFinite(v)) return '—'
  if (v === 0) return '$0'
  if (v > 0 && v < 0.001) return '<$0.001'
  return '$' + (Math.abs(v) < 1 ? v.toFixed(3) : v.toFixed(2))
}
