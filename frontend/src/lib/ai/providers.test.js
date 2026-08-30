import { describe, expect, it } from 'vitest'
import { PROVIDERS, PROVIDER_IDS, providerOf } from './providers/index.js'
import { text, toolUse, toolResult, userTurn, assistantTurn, toolCalls, textOf, tool } from './message.js'

const TOOLS = [tool('search_exercises', 'Search the exercise library', {
  type: 'object',
  properties: { query: { type: 'string' } },
  required: ['query'],
  additionalProperties: false
})]

// One conversation that exercises every shape at once: a question, an answer that both says
// something and calls a tool, the tool's result, and a final answer.
const CONVERSATION = [
  userTurn('what should I do for chest?'),
  assistantTurn([text('Let me look.'), toolUse('call_1', 'search_exercises', { query: 'chest press' })]),
  { role: 'user', content: [toolResult('call_1', 'search_exercises', [{ id: '0025', n: 'barbell bench press' }])] },
  assistantTurn('Barbell bench press.')
]

// What each provider actually sends back, in its own shape, for a turn that calls one tool.
const TOOL_CALL_RESPONSE = {
  anthropic: {
    content: [
      { type: 'text', text: 'Let me look.' },
      { type: 'tool_use', id: 'toolu_abc', name: 'search_exercises', input: { query: 'chest press' } }
    ],
    stop_reason: 'tool_use',
    usage: { input_tokens: 120, output_tokens: 45 }
  },
  openai: {
    output: [
      { type: 'message', content: [{ type: 'output_text', text: 'Let me look.' }] },
      { type: 'function_call', call_id: 'fc_abc', name: 'search_exercises', arguments: '{"query":"chest press"}' }
    ],
    status: 'completed',
    usage: { input_tokens: 120, output_tokens: 45 }
  },
  gemini: {
    candidates: [{
      content: {
        role: 'model',
        parts: [
          { text: 'Let me look.' },
          { functionCall: { name: 'search_exercises', args: { query: 'chest press' } } }
        ]
      },
      finishReason: 'STOP'
    }],
    usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 45 }
  }
}

const TEXT_RESPONSE = {
  anthropic: { content: [{ type: 'text', text: 'Barbell bench press.' }], stop_reason: 'end_turn', usage: { input_tokens: 9, output_tokens: 4 } },
  openai: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'Barbell bench press.' }] }], status: 'completed', usage: { input_tokens: 9, output_tokens: 4 } },
  gemini: { candidates: [{ content: { role: 'model', parts: [{ text: 'Barbell bench press.' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4 } }
}

describe.each(PROVIDER_IDS)('%s', id => {
  const p = PROVIDERS[id]
  const build = extra => p.toRequest({
    model: 'test-model', system: 'You are a coach.', messages: CONVERSATION,
    tools: TOOLS, maxTokens: 1024, ...extra
  })

  it('carries the system prompt somewhere', () => {
    expect(JSON.stringify(build())).toContain('You are a coach.')
  })

  it('declares the tool by name and description', () => {
    const wire = JSON.stringify(build())
    expect(wire).toContain('search_exercises')
    expect(wire).toContain('Search the exercise library')
  })

  it('sends no tools key at all when there are none', () => {
    const body = p.toRequest({ model: 'm', messages: [userTurn('hi')], tools: [], maxTokens: 10 })
    expect(body.tools).toBeUndefined()
  })

  it('keeps the whole conversation, including the tool call and its result', () => {
    const wire = JSON.stringify(build())
    expect(wire).toContain('chest press')
    expect(wire).toContain('barbell bench press')
    expect(wire).toContain('Let me look.')
  })

  it('reads a tool call back out of a real response shape', () => {
    const r = p.fromResponse(TOOL_CALL_RESPONSE[id])
    expect(r.stopReason).toBe('tool_use')
    const calls = toolCalls({ content: r.content })
    expect(calls.length).toBe(1)
    expect(calls[0].name).toBe('search_exercises')
    expect(calls[0].input).toEqual({ query: 'chest press' })
    expect(calls[0].id).toBeTruthy()
    expect(textOf({ content: r.content })).toBe('Let me look.')
    expect(r.usage).toEqual({ in: 120, out: 45 })
  })

  it('reads a plain answer back out', () => {
    const r = p.fromResponse(TEXT_RESPONSE[id])
    expect(r.stopReason).toBe('end')
    expect(textOf({ content: r.content })).toBe('Barbell bench press.')
    expect(toolCalls({ content: r.content })).toEqual([])
    expect(r.usage).toEqual({ in: 9, out: 4 })
  })

  it('round-trips: a parsed reply can be replayed as history', () => {
    // This is the property that makes the neutral shape worth having. A turn read back from one
    // provider has to be sendable again — to that provider or another — without losing the tool
    // call. Gemini has no call ids at all, so this is where a synthesised one earns its keep.
    const parsed = p.fromResponse(TOOL_CALL_RESPONSE[id])
    const call = toolCalls({ content: parsed.content })[0]
    const replay = [
      userTurn('what should I do for chest?'),
      { role: 'assistant', content: parsed.content },
      { role: 'user', content: [toolResult(call.id, call.name, [{ id: '0025' }])] }
    ]
    const wire = JSON.stringify(p.toRequest({ model: 'm', messages: replay, tools: TOOLS, maxTokens: 100 }))
    expect(wire).toContain('search_exercises')
    expect(wire).toContain('0025')
  })

  it('reports running out of room as max_tokens, not as a finished answer', () => {
    const truncated = {
      anthropic: { content: [{ type: 'text', text: 'partial' }], stop_reason: 'max_tokens', usage: {} },
      openai: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'partial' }] }], status: 'incomplete', usage: {} },
      gemini: { candidates: [{ content: { parts: [{ text: 'partial' }] }, finishReason: 'MAX_TOKENS' }], usageMetadata: {} }
    }[id]
    expect(p.fromResponse(truncated).stopReason).toBe('max_tokens')
  })

  it('survives an empty response without throwing', () => {
    const r = p.fromResponse({})
    expect(r.content).toEqual([])
    expect(r.usage).toEqual({ in: 0, out: 0 })
  })

  it('asks for a JSON answer when given a schema', () => {
    const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, additionalProperties: false }
    expect(JSON.stringify(build({ schema }))).toContain('ok')
  })
})

describe('anthropic', () => {
  it('puts the tool result in the block shape the API expects', () => {
    const body = PROVIDERS.anthropic.toRequest({ model: 'm', messages: CONVERSATION, tools: TOOLS, maxTokens: 10 })
    const resultTurn = body.messages.find(m => m.content.some(b => b.type === 'tool_result'))
    expect(resultTurn.role).toBe('user')
    expect(resultTurn.content[0].tool_use_id).toBe('call_1')
    expect(typeof resultTurn.content[0].content).toBe('string')
  })

  it('keeps a thinking block instead of dropping it, and replays it unchanged', () => {
    // Anthropic documents that thinking blocks are echoed back on the same model. Dropping them
    // does not fail loudly — the model loses its reasoning between turns and the conversation
    // never converges.
    const raw = { type: 'thinking', thinking: '', signature: 'sig' }
    const r = PROVIDERS.anthropic.fromResponse({
      content: [raw, { type: 'text', text: 'hi' }],
      stop_reason: 'end_turn', usage: {}
    })
    expect(r.content[0]).toEqual({ type: 'opaque', provider: 'anthropic', raw })
    expect(textOf({ content: r.content })).toBe('hi')

    const body = PROVIDERS.anthropic.toRequest({
      model: 'm', maxTokens: 10, messages: [{ role: 'assistant', content: r.content }]
    })
    expect(body.messages[0].content[0]).toEqual(raw)
  })
})

describe('openai', () => {
  it('flattens a mixed turn into sibling items', () => {
    // One assistant turn that says something and calls a tool becomes two entries in `input`.
    const body = PROVIDERS.openai.toRequest({ model: 'm', messages: CONVERSATION, tools: TOOLS, maxTokens: 10 })
    const said = body.input.filter(i => i.role === 'assistant')
    const called = body.input.filter(i => i.type === 'function_call')
    expect(said.length).toBe(2)
    expect(called.length).toBe(1)
    expect(called[0].call_id).toBe('call_1')
    expect(JSON.parse(called[0].arguments)).toEqual({ query: 'chest press' })
  })

  it('treats unparseable arguments as an empty input, not as a thrown error', () => {
    // A model that emits broken JSON should reach the tool as {} and let the tool say so. An
    // exception here would take the whole run down for one malformed argument.
    const r = PROVIDERS.openai.fromResponse({
      output: [{ type: 'function_call', call_id: 'c1', name: 'search_exercises', arguments: '{"query": ' }],
      status: 'completed', usage: {}
    })
    expect(r.content[0].input).toEqual({})
    expect(r.stopReason).toBe('tool_use')
  })
})

describe('gemini', () => {
  it('renames the assistant role and lifts the system prompt out', () => {
    const body = PROVIDERS.gemini.toRequest({ model: 'm', system: 'coach', messages: CONVERSATION, tools: TOOLS, maxTokens: 10 })
    expect(body.systemInstruction.parts[0].text).toBe('coach')
    expect(body.contents.some(c => c.role === 'model')).toBe(true)
    expect(body.contents.some(c => c.role === 'assistant')).toBe(false)
  })

  it('keeps the model out of the body, because it belongs in the URL', () => {
    const body = PROVIDERS.gemini.toRequest({ model: 'gemini-3.7-flash', messages: [userTurn('hi')], maxTokens: 10 })
    expect(body.model).toBeUndefined()
  })

  it('answers a tool call by name, in the order the calls came in', () => {
    // functionResponse has no id — the pairing is positional and by name. Anything that reorders
    // blocks silently breaks two parallel calls to the same tool.
    const body = PROVIDERS.gemini.toRequest({
      model: 'm', maxTokens: 10, messages: [{
        role: 'user',
        content: [toolResult('a', 'search_exercises', 'first'), toolResult('b', 'search_exercises', 'second')]
      }]
    })
    const parts = body.contents[0].parts
    expect(parts.map(p => p.functionResponse.name)).toEqual(['search_exercises', 'search_exercises'])
    expect(parts[0].functionResponse.response.result).toContain('first')
    expect(parts[1].functionResponse.response.result).toContain('second')
  })

  it('strips additionalProperties, which its schema dialect rejects', () => {
    const body = PROVIDERS.gemini.toRequest({ model: 'm', messages: [userTurn('hi')], tools: TOOLS, maxTokens: 10 })
    expect(JSON.stringify(body)).not.toContain('additionalProperties')
    expect(body.tools[0].functionDeclarations[0].parameters.properties.query.type).toBe('string')
  })

  it('reports a safety stop as a refusal rather than as an answer', () => {
    const r = PROVIDERS.gemini.fromResponse({ candidates: [{ content: { parts: [] }, finishReason: 'SAFETY' }] })
    expect(r.stopReason).toBe('refusal')
  })
})

describe('effort', () => {
  const SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' } }, additionalProperties: false }
  const build = (id, extra) => PROVIDERS[id].toRequest({
    model: 'm', messages: [userTurn('hi')], maxTokens: 2400, ...extra
  })

  it('asks anthropic to think less, without losing the schema', () => {
    // Both live in output_config, so whichever is written second must not clobber the first.
    expect(build('anthropic', { effort: 'low' }).output_config).toEqual({ effort: 'low' })
    expect(build('anthropic', { schema: SCHEMA }).output_config.format.type).toBe('json_schema')
    const both = build('anthropic', { effort: 'low', schema: SCHEMA }).output_config
    expect(both.effort).toBe('low')
    expect(both.format.schema).toEqual(SCHEMA)
  })

  it('asks openai to think less and say less, without losing the schema', () => {
    const body = build('openai', { effort: 'low' })
    expect(body.reasoning).toEqual({ effort: 'low' })
    expect(body.text.verbosity).toBe('low')
    const both = build('openai', { effort: 'low', schema: SCHEMA })
    expect(both.text.verbosity).toBe('low')
    expect(both.text.format.type).toBe('json_schema')
  })

  it('sends gemini no thinking field at all', () => {
    // Its equivalent lives under generationConfig.thinkingConfig and the REST spelling was not
    // confirmed. An unknown field is a 400, which would break Gemini outright to save tokens.
    const body = build('gemini', { effort: 'low' })
    expect(JSON.stringify(body)).not.toContain('thinking')
    expect(JSON.stringify(body)).not.toContain('effort')
    expect(body.generationConfig.maxOutputTokens).toBe(2400)
  })

  it('changes nothing anywhere when no effort is asked for', () => {
    expect(build('anthropic', {}).output_config).toBeUndefined()
    expect(build('openai', {}).reasoning).toBeUndefined()
    expect(build('openai', {}).text).toBeUndefined()
  })
})


describe('provider-native items', () => {
  // The bug this exists for: a reasoning model's own items were dropped between turns, so it
  // restarted the task on every call, made one more small tool call, and ran until the step cap.
  // From the outside that looks like 'it kept searching and never settled'.
  const REASONING = { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'xyz' }

  it('keeps an openai reasoning item and hands it straight back', () => {
    const r = PROVIDERS.openai.fromResponse({
      output: [REASONING, { type: 'function_call', call_id: 'c1', name: 'search_exercises', arguments: '{}' }],
      status: 'completed', usage: {}
    })
    expect(r.content[0]).toEqual({ type: 'opaque', provider: 'openai', raw: REASONING })
    expect(toolCalls({ content: r.content })).toHaveLength(1)

    const body = PROVIDERS.openai.toRequest({ model: 'm', maxTokens: 10, messages: [{ role: 'assistant', content: r.content }] })
    expect(body.input[0]).toEqual(REASONING)
    expect(body.input[1].type).toBe('function_call')
  })

  it('keeps reasoning immediately before the call it produced', () => {
    // An item emitted out of order is worse than one dropped: it pairs the reasoning with the
    // wrong call.
    const turn = {
      role: 'assistant',
      content: [
        text('thinking out loud'),
        { type: 'opaque', provider: 'openai', raw: REASONING },
        toolUse('c1', 'search_exercises', {})
      ]
    }
    const body = PROVIDERS.openai.toRequest({ model: 'm', maxTokens: 10, messages: [turn] })
    expect(body.input.map(i => i.type || i.role)).toEqual(['assistant', 'reasoning', 'function_call'])
  })

  it('never sends one provider’s item to another', () => {
    const turn = { role: 'assistant', content: [{ type: 'opaque', provider: 'openai', raw: REASONING }, text('hi')] }
    for (const id of ['anthropic', 'gemini']) {
      expect(JSON.stringify(PROVIDERS[id].toRequest({ model: 'm', maxTokens: 10, messages: [turn] })))
        .not.toContain('encrypted_content')
    }
  })

  it('keeps a gemini part it does not model', () => {
    const part = { thoughtSignature: 'abc' }
    const r = PROVIDERS.gemini.fromResponse({
      candidates: [{ content: { parts: [part, { text: 'hi' }] }, finishReason: 'STOP' }]
    })
    expect(r.content[0]).toEqual({ type: 'opaque', provider: 'gemini', raw: part })
    const body = PROVIDERS.gemini.toRequest({ model: 'm', maxTokens: 10, messages: [{ role: 'assistant', content: r.content }] })
    expect(body.contents[0].parts[0]).toEqual(part)
  })

  it('does not count as text or as a tool call', () => {
    const turn = { content: [{ type: 'opaque', provider: 'openai', raw: REASONING }, text('hi')] }
    expect(textOf(turn)).toBe('hi')
    expect(toolCalls(turn)).toEqual([])
  })
})

describe('providerOf', () => {
  it('returns null for something we do not speak', () => {
    expect(providerOf('ollama')).toBe(null)
  })
})
