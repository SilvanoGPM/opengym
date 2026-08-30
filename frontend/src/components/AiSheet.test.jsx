// @vitest-environment happy-dom
// The sheet fires one paid request and then has to show what came back. Both halves broke on the
// first attempt, in a way only a real mount catches: guarding against StrictMode's double effect
// with a has-started flag stopped the second call AND stopped the answer from ever being
// rendered — the first mount's cleanup had already fired, so the reply came back to nobody and
// the sheet said "asking…" forever. Production has no double mount, so it looked fine there.
//
// Everything here therefore renders under <StrictMode>, which is how main.jsx renders the app.
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import React, { StrictMode, act } from 'react'
import { createRoot } from 'react-dom/client'
import AiSheet from './AiSheet.jsx'

const STATUS = {
  enabled: true, configured: true, readable: true,
  provider: 'anthropic', model: 'claude-sonnet-5',
  models: { anthropic: [{ id: 'claude-sonnet-5', label: 'Claude Sonnet 5', in: 2, out: 10 }] },
  capUSD: 5, spend: { month: '2026-08', usd: 0.02, calls: 2 }
}

const REPLY = {
  reply: {
    content: [{ type: 'text', text: '## Boa sessão\n\nO volume **subiu**.' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1500, output_tokens: 800 }
  },
  spend: { month: '2026-08', usd: 0.031, calls: 3 }
}

const request = { system: 'coach', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], maxTokens: 1200 }

const mounted = []
let calls

/** Every fetch the sheet makes, answered from a script. Returns the URLs that were hit. */
function serve({ status = STATUS, chat = REPLY, chatStatus = 200 } = {}) {
  calls = []
  globalThis.fetch = vi.fn(async (url, opts) => {
    calls.push(String(url) + (opts?.method ? ' ' + opts.method : ''))
    if (String(url).endsWith('/api/ai/status')) {
      return { ok: true, status: 200, json: async () => status }
    }
    return { ok: chatStatus < 400, status: chatStatus, json: async () => chat }
  })
}

async function render(props = {}) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mounted.push(root)
  await act(async () => {
    root.render(<StrictMode><AiSheet title="Como foi" request={request} close={() => {}} {...props} /></StrictMode>)
  })
  // Let the status → chat chain settle.
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
  return host
}

describe('AiSheet', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    document.body.innerHTML = ''
    serve()
  })

  afterEach(() => {
    act(() => mounted.splice(0).forEach(r => r.unmount()))
    globalThis.IS_REACT_ACT_ENVIRONMENT = false
    vi.restoreAllMocks()
  })

  it('shows the answer instead of asking forever', async () => {
    // The regression. Under StrictMode this hung on the loading state indefinitely.
    const host = await render()
    expect(host.textContent).not.toContain('Asking your AI assistant')
    expect(host.textContent).toContain('Boa sessão')
    expect(host.textContent).toContain('O volume')
  })

  it('asks exactly once, however many times React mounts it', async () => {
    // The other half: an answer is not free, and StrictMode mounts every effect twice.
    await render()
    expect(calls.filter(c => c.includes('/api/ai/chat')).length).toBe(1)
    expect(calls.filter(c => c.includes('/api/ai/status')).length).toBe(1)
  })

  it('renders markdown as elements, never as HTML', async () => {
    const host = await render()
    expect(host.querySelector('strong')?.textContent).toBe('subiu')
  })

  it('reports what the answer cost and what the month is at', async () => {
    const host = await render()
    // 1500 in at $2/M + 800 out at $10/M.
    expect(host.textContent).toContain('$0.011')
    expect(host.textContent).toContain('$0.031')
    expect(host.textContent).toContain('Claude Sonnet 5')
  })

  it('says the feature is off rather than asking', async () => {
    serve({ status: { ...STATUS, enabled: false } })
    const host = await render()
    expect(host.textContent).toContain('switched off')
    expect(calls.some(c => c.includes('/api/ai/chat'))).toBe(false)
  })

  it('sends people to Settings when there is no key', async () => {
    serve({ status: { ...STATUS, configured: false, readable: false } })
    const host = await render()
    expect(host.textContent).toContain('Settings')
    expect(calls.some(c => c.includes('/api/ai/chat'))).toBe(false)
  })

  it('explains an unreadable key rather than showing a raw error', async () => {
    serve({ status: { ...STATUS, readable: false } })
    const host = await render()
    expect(host.textContent).toContain('could not be read')
  })

  it('explains the spending cap by its code, not by matching prose', async () => {
    serve({ chatStatus: 402, chat: { code: 'ai-cap', error: 'cap reached' } })
    const host = await render()
    expect(host.textContent).toContain('spending cap')
  })

  it('shows a provider failure instead of hanging', async () => {
    serve({ chatStatus: 401, chat: { code: 'ai-provider', error: 'API key is invalid.' } })
    const host = await render()
    expect(host.textContent).not.toContain('Asking your AI assistant')
    expect(host.textContent).toContain('API key is invalid.')
  })

  it('says so when the answer was cut short', async () => {
    serve({ chat: { ...REPLY, reply: { ...REPLY.reply, stop_reason: 'max_tokens' } } })
    const host = await render()
    expect(host.textContent).toContain('cut short')
  })
})
