import { describe, expect, it } from 'vitest'
import { costOf, priceOf, labelOf, fmtUSD } from './pricing.js'

// The shape GET /api/ai/status sends: the server owns the table, the client renders it.
const MODELS = {
  anthropic: [{ id: 'claude-sonnet-5', label: 'Claude Sonnet 5', in: 2, out: 10 }],
  gemini: [{ id: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash', in: 0.75, out: 3.75 }]
}

describe('costOf', () => {
  it('prices a call at the published per-million rate', () => {
    // 1500 in at $2/M + 800 out at $10/M — the measured cost of judging one session.
    expect(costOf({ in: 2, out: 10 }, { in: 1500, out: 800 })).toBeCloseTo(0.011, 6)
  })

  it('is null for a model with no price, never zero', () => {
    // A model missing from the table must not read as free: the spend cap is driven by this
    // number, and a cap enforced with a wrong number is worse than no cap.
    expect(costOf(null, { in: 1000, out: 1000 })).toBe(null)
    expect(costOf({ in: 'x', out: 1 }, { in: 1, out: 1 })).toBe(null)
  })

  it('is null when there is no usage to price', () => {
    expect(costOf({ in: 2, out: 10 }, null)).toBe(null)
  })

  it('treats missing token counts as zero', () => {
    expect(costOf({ in: 2, out: 10 }, {})).toBe(0)
  })
})

describe('priceOf / labelOf', () => {
  it('finds a model in the table the server sent', () => {
    expect(priceOf(MODELS, 'anthropic', 'claude-sonnet-5').in).toBe(2)
    expect(labelOf(MODELS, 'gemini', 'gemini-3.7-flash')).toBe('Gemini 3.7 Flash')
  })

  it('falls back to the raw id rather than showing nothing', () => {
    expect(labelOf(MODELS, 'anthropic', 'claude-something-new')).toBe('claude-something-new')
    expect(priceOf(MODELS, 'openai', 'gpt-5')).toBe(null)
    expect(priceOf(undefined, 'anthropic', 'x')).toBe(null)
  })
})

describe('fmtUSD', () => {
  it('keeps three decimals where the numbers actually live', () => {
    // Two decimals rounds a real call to "$0.02" or "$0.00" — either wrong or free.
    expect(fmtUSD(0.011)).toBe('$0.011')
    expect(fmtUSD(0.75)).toBe('$0.750')
  })

  it('switches to two decimals once it is real money', () => {
    expect(fmtUSD(4.5)).toBe('$4.50')
    expect(fmtUSD(12)).toBe('$12.00')
  })

  it('does not round a fraction of a cent down to nothing', () => {
    expect(fmtUSD(0.0001)).toBe('<$0.001')
    expect(fmtUSD(0)).toBe('$0')
  })

  it('says nothing rather than NaN when the spend is unknown', () => {
    expect(fmtUSD(null)).toBe('—')
    expect(fmtUSD(undefined)).toBe('—')
    expect(fmtUSD(NaN)).toBe('—')
  })
})
