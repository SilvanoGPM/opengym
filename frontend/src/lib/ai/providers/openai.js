// OpenAI Responses API — https://api.openai.com/v1/responses
// Flattens a turn: a message that says something AND calls two tools becomes three sibling
// items in one `input` array. Tool arguments and outputs are JSON *strings* on this wire, and
// the id that ties a call to its result is `call_id`, not `id`.
import { resultToString, opaque } from '../message.js'

const PROVIDER = 'openai'

/**
 * One input item per block, in the order the blocks came in.
 *
 * Order is load-bearing here, not cosmetic: a reasoning item belongs immediately before the call
 * it produced, and the documented way to continue a conversation is to hand every output item
 * back exactly as it arrived. Emitting all the text first and the calls afterwards — which is
 * what this did originally — breaks that pairing.
 */
const outItems = m => {
  const items = []
  let said = []
  const flush = () => {
    if (said.length) items.push({ role: m.role, content: said.join('\n') })
    said = []
  }
  for (const b of m.content) {
    if (b.type === 'text') { said.push(b.text); continue }
    flush()
    if (b.type === 'opaque') {
      // Reasoning items, replayed untouched. Without them the model loses its own train of
      // thought between turns and starts the task over on every call.
      if (b.provider === PROVIDER) items.push(b.raw)
    } else if (b.type === 'tool_use') {
      items.push({ type: 'function_call', call_id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) })
    } else if (b.type === 'tool_result') {
      items.push({ type: 'function_call_output', call_id: b.id, output: resultToString(b.output) })
    }
  }
  flush()
  return items
}

export function toRequest({ model, system, messages, tools, maxTokens = 4096, schema, effort }) {
  const input = []
  if (system) input.push({ role: 'system', content: system })
  for (const m of messages) input.push(...outItems(m))
  const body = { model, input, max_output_tokens: maxTokens }
  if (tools && tools.length) {
    body.tools = tools.map(t => ({ type: 'function', name: t.name, description: t.description, parameters: t.schema }))
  }
  // On a reasoning model max_output_tokens covers the INVISIBLE reasoning tokens as well as
  // the answer (usage.output_tokens_details.reasoning_tokens is where they show up). Left
  // alone, a model can spend the whole ceiling thinking and get cut off mid-sentence — which
  // is exactly what a short, low-stakes answer must not do. Low effort and low verbosity buy
  // the room back.
  const text = {}
  if (effort) { body.reasoning = { effort }; text.verbosity = 'low' }
  if (schema) text.format = { type: 'json_schema', name: 'result', schema, strict: true }
  if (Object.keys(text).length) body.text = text
  return body
}

export function fromResponse(json) {
  const content = []
  for (const item of json.output || []) {
    if (item.type === 'message') {
      for (const c of item.content || []) {
        if (c.type === 'output_text' && c.text) content.push({ type: 'text', text: c.text })
      }
    } else if (item.type === 'function_call') {
      // `arguments` is a JSON string on this wire. A model that emits something unparseable
      // should surface as a tool that got {} and can say so, not as a thrown exception that
      // takes the whole run down.
      let input = {}
      try { input = JSON.parse(item.arguments || '{}') } catch { input = {} }
      content.push({ type: 'tool_use', id: item.call_id, name: item.name, input })
    } else {
      // Everything else — reasoning above all — is kept verbatim and handed back next turn.
      content.push(opaque(PROVIDER, item))
    }
  }
  const calling = content.some(b => b.type === 'tool_use')
  return {
    content,
    stopReason: calling ? 'tool_use'
      : json.status === 'incomplete' ? 'max_tokens'
        : json.status === 'failed' ? 'other' : 'end',
    usage: { in: json.usage?.input_tokens || 0, out: json.usage?.output_tokens || 0 }
  }
}
