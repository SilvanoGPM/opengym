import { describe, expect, it, vi } from 'vitest'
import { run, runJSON, emptyAnswer, MAX_STEPS } from './run.js'
import { userTurn, tool, opaque, text } from './message.js'

// Anthropic's wire shape, since that is what the fake transport pretends to be.
const say = t => ({ reply: { content: [{ type: 'text', text: t }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } } })
const call = (id, name, input) => ({
  reply: {
    content: [{ type: 'tool_use', id, name, input }],
    stop_reason: 'tool_use',
    usage: { input_tokens: 10, output_tokens: 5 }
  }
})

const base = { provider: 'anthropic', model: 'claude-sonnet-5', messages: [userTurn('hi')] }
const TOOLS = [tool('search', 'Search', { type: 'object', properties: {}, additionalProperties: false })]

/** A transport that replays a fixed script and records what it was sent. */
function scripted(...replies) {
  const sent = []
  let i = 0
  const fn = async req => { sent.push(req); return replies[Math.min(i++, replies.length - 1)] }
  fn.sent = sent
  return fn
}

describe('run', () => {
  it('returns the answer when no tool is called', async () => {
    const res = await run({ ...base, transport: scripted(say('Looks solid.')) })
    expect(res.text).toBe('Looks solid.')
    expect(res.stopReason).toBe('end')
    expect(res.steps).toBe(1)
  })

  it('executes a tool locally and feeds the result back', async () => {
    const transport = scripted(call('t1', 'search', { q: 'chest' }), say('Bench press.'))
    const search = vi.fn(async () => [{ id: '0025' }])
    const res = await run({ ...base, tools: TOOLS, toolbox: { search }, transport })

    expect(search).toHaveBeenCalledWith({ q: 'chest' })
    expect(res.text).toBe('Bench press.')
    expect(res.steps).toBe(2)
    // The second request has to carry the result, or the model answers the same question again.
    expect(JSON.stringify(transport.sent[1])).toContain('0025')
  })

  it('adds up usage across every step, not just the last one', async () => {
    const res = await run({
      ...base, tools: TOOLS, toolbox: { search: async () => [] },
      transport: scripted(call('t1', 'search', {}), say('done'))
    })
    expect(res.usage).toEqual({ in: 20, out: 10 })
  })

  it('answers an unknown tool instead of throwing', async () => {
    // Every call in a turn must get a result. Dropping one leaves the conversation malformed on
    // all three wires, and the error that comes back describes the missing block rather than
    // the tool that was never there.
    const transport = scripted(call('t1', 'nonexistent', {}), say('sorry'))
    const res = await run({ ...base, tools: TOOLS, toolbox: {}, transport })
    expect(res.text).toBe('sorry')
    expect(JSON.stringify(transport.sent[1])).toContain('unknown tool: nonexistent')
  })

  it('turns a thrown tool into a result the model can recover from', async () => {
    const transport = scripted(call('t1', 'search', {}), say('never mind'))
    const boom = async () => { throw new Error('database on fire') }
    const res = await run({ ...base, tools: TOOLS, toolbox: { search: boom }, transport })
    expect(res.text).toBe('never mind')
    expect(JSON.stringify(transport.sent[1])).toContain('database on fire')
  })

  it('answers every call in a turn, not just the first', async () => {
    const transport = scripted({
      reply: {
        content: [
          { type: 'tool_use', id: 'a', name: 'search', input: { q: 'one' } },
          { type: 'tool_use', id: 'b', name: 'search', input: { q: 'two' } }
        ],
        stop_reason: 'tool_use',
        usage: {}
      }
    }, say('both'))
    const res = await run({ ...base, tools: TOOLS, toolbox: { search: async i => i.q }, transport })
    const second = JSON.stringify(transport.sent[1])
    expect(second).toContain('one')
    expect(second).toContain('two')
    expect(res.text).toBe('both')
  })

  it('stops a model stuck in a loop, and says that is what happened', async () => {
    // A runaway loop spends the user's money. Returning whatever half-thought the last turn
    // contained, as if it were an answer, would hide that.
    const transport = scripted(call('t1', 'search', {}))
    const res = await run({ ...base, tools: TOOLS, toolbox: { search: async () => [] }, transport })
    expect(res.steps).toBe(MAX_STEPS)
    expect(res.stopReason).toBe('max_steps')
    expect(transport.sent.length).toBe(MAX_STEPS)
  })

  it('reports the spend the server sent back', async () => {
    const spend = { month: '2026-08', usd: 0.42, calls: 7 }
    const res = await run({ ...base, transport: async () => ({ ...say('hi'), spend }) })
    expect(res.spend).toEqual(spend)
  })

  it('accepts a bare provider response, without the envelope', async () => {
    const res = await run({ ...base, transport: async () => say('hi').reply })
    expect(res.text).toBe('hi')
  })

  it('refuses a provider it does not speak', async () => {
    await expect(run({ ...base, provider: 'ollama', transport: scripted(say('x')) }))
      .rejects.toThrow(/unknown provider/)
  })
})

describe('runJSON', () => {
  it('parses a schema-constrained answer', async () => {
    const res = await runJSON({ ...base, transport: scripted(say('{"ok":true}')) })
    expect(res.json).toEqual({ ok: true })
  })

  it('gives null rather than throwing when the answer is not JSON', async () => {
    const res = await runJSON({ ...base, transport: scripted(say('sorry, I cannot')) })
    expect(res.json).toBe(null)
    expect(res.text).toBe('sorry, I cannot')
  })
})

describe('a reasoning model over several turns', () => {
  // The bug that made 'fill in this routine' fail every time: the model's own reasoning items
  // were dropped between turns, so it started over on each call, made one more small search, and
  // ran to the step cap. Every provider documents that these must be replayed unchanged.
  const REASONING = { type: 'reasoning', id: 'rs_1', encrypted_content: 'xyz' }

  const openaiCall = (id, name) => ({
    reply: {
      output: [REASONING, { type: 'function_call', call_id: id, name, arguments: '{}' }],
      status: 'completed', usage: { input_tokens: 100, output_tokens: 40 }
    }
  })
  const openaiSay = t => ({
    reply: { output: [{ type: 'message', content: [{ type: 'output_text', text: t }] }], status: 'completed', usage: {} }
  })

  it('sends the reasoning back on the next turn', async () => {
    const sent = []
    const replies = [openaiCall('c1', 'search'), openaiSay('done')]
    let i = 0
    const transport = async req => { sent.push(req); return replies[Math.min(i++, 1)] }

    const res = await run({
      provider: 'openai', model: 'gpt-5-mini', messages: [userTurn('hi')],
      tools: TOOLS, toolbox: { search: async () => [] }, transport
    })

    expect(res.text).toBe('done')
    // The second request carries the reasoning item from the first, verbatim.
    const replayed = sent[1].body.input.filter(x => x.type === 'reasoning')
    expect(replayed).toEqual([REASONING])
  })

  it('is not counted as an answer', async () => {
    // An assistant turn made only of reasoning has no text; the loop must not mistake it for one.
    const turn = { role: 'assistant', content: [opaque('openai', REASONING), text('the answer')] }
    expect(turn.content.filter(b => b.type === 'text').map(b => b.text)).toEqual(['the answer'])
  })
})

describe('maxSteps', () => {
  it('can be raised for work that legitimately needs more searching', async () => {
    // Building a routine is one search per muscle group. Hitting the default cap there is the
    // task, not a runaway.
    const transport = scripted(call('t1', 'search', {}))
    const res = await run({ ...base, tools: TOOLS, toolbox: { search: async () => [] }, maxSteps: 10, transport })
    expect(res.steps).toBe(10)
    expect(res.stopReason).toBe('max_steps')
  })
})

describe('stopAfter', () => {
  const submit = (name, input) => ({
    reply: { content: [{ type: 'tool_use', id: 's', name, input }], stop_reason: 'tool_use', usage: {} }
  })

  it('ends the run when the submission is accepted', async () => {
    const transport = scripted(submit('submit_plan', {}), say('extra'))
    const res = await run({
      ...base, tools: TOOLS, stopAfter: 'submit_plan',
      toolbox: { submit_plan: async () => ({ ok: true }) }, transport
    })
    expect(res.stopReason).toBe('submitted')
    expect(res.steps).toBe(1)
    expect(transport.sent.length).toBe(1)
  })

  it('lets a refused submission try again', async () => {
    // The handler's error message exists to be read. Ending the run on it would stop the model on
    // the one turn where it still had a way to fix things.
    let n = 0
    const transport = scripted(submit('submit_plan', {}), submit('submit_plan', {}))
    const res = await run({
      ...base, tools: TOOLS, stopAfter: 'submit_plan', maxSteps: 3,
      toolbox: { submit_plan: async () => (++n === 1 ? { ok: false, error: 'no usable exercises' } : { ok: true }) },
      transport
    })
    expect(n).toBe(2)
    expect(res.stopReason).toBe('submitted')
    expect(JSON.stringify(transport.sent[1])).toContain('no usable exercises')
  })
})

describe('cancelling', () => {
  it('stops before the next round trip', async () => {
    // What a tool loop costs is the NUMBER of round trips, so the one worth stopping is the next
    // one. The request already in flight is aborted by its own signal, inside the transport.
    const ac = new AbortController()
    const transport = scripted(call('t1', 'search', {}), say('never reached'))
    const res = await run({
      ...base, tools: TOOLS, signal: ac.signal,
      toolbox: { search: async () => { ac.abort(); return [] } },
      transport
    })
    expect(res.stopReason).toBe('cancelled')
    expect(res.steps).toBe(1)
    expect(transport.sent.length).toBe(1)
  })

  it('hands the signal to the transport, so the request in flight is cancelled too', async () => {
    const ac = new AbortController()
    let seen = null
    await run({ ...base, signal: ac.signal, transport: async req => { seen = req.signal; return say('hi') } })
    expect(seen).toBe(ac.signal)
  })

  it('runs normally when nobody cancels', async () => {
    const ac = new AbortController()
    const res = await run({ ...base, signal: ac.signal, transport: scripted(say('done')) })
    expect(res.stopReason).toBe('end')
    expect(res.text).toBe('done')
  })
})

describe('emptyAnswer', () => {
  // A run can succeed and still show nothing: on a reasoning model the whole output allowance
  // can go on thinking, leaving a turn with reasoning blocks and no text. That rendered as
  // silence — the question on screen, nothing under it, no error — which reads as a broken app.
  it('is null when there is something to show', () => {
    expect(emptyAnswer({ text: 'hi', stopReason: 'end' })).toBe(null)
  })

  it('names running out of room separately from saying nothing', () => {
    expect(emptyAnswer({ text: '', stopReason: 'max_tokens' })).toBe('max_tokens')
    expect(emptyAnswer({ text: '', stopReason: 'end' })).toBe('empty')
    expect(emptyAnswer({ text: '', stopReason: 'max_steps' })).toBe('max_steps')
  })

  it('survives being handed nothing', () => {
    expect(emptyAnswer(null)).toBe('empty')
    expect(emptyAnswer({})).toBe('empty')
  })

  it('catches a turn that is only reasoning', async () => {
    // The shape that produced the silence: an OpenAI turn with a reasoning item and no message.
    const res = await run({
      ...base,
      transport: async () => ({ reply: { output: [{ type: 'reasoning', id: 'r' }], status: 'completed', usage: {} } })
    })
    expect(res.text).toBe('')
    expect(emptyAnswer(res)).toBe('empty')
  })
})
