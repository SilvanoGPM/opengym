// Anthropic Messages API — https://api.anthropic.com/v1/messages
// The neutral shape in ../message.js is modelled on this one, so both directions are nearly a
// pass-through. The two things that are not: tool results carry a string, and `schema` becomes
// output_config.format rather than a tool.
import { resultToString, opaque } from '../message.js'

const PROVIDER = 'anthropic'

const STOP = {
  end_turn: 'end', stop_sequence: 'end', tool_use: 'tool_use',
  max_tokens: 'max_tokens', refusal: 'refusal'
}

const outBlock = b =>
  b.type === 'text' ? { type: 'text', text: b.text }
    : b.type === 'tool_use' ? { type: 'tool_use', id: b.id, name: b.name, input: b.input }
      // Thinking blocks go back unchanged on the same model. Dropping them costs the model its
      // own reasoning between turns, and a tool-using conversation then never converges.
      : b.type === 'opaque' ? b.raw
        : { type: 'tool_result', tool_use_id: b.id, content: resultToString(b.output) }

export function toRequest({ model, system, messages, tools, maxTokens = 4096, schema, effort }) {
  const body = {
    model,
    max_tokens: maxTokens,
    messages: messages.map(m => ({
      role: m.role,
      // An opaque block from another provider has no meaning here; drop it rather than send it.
      content: m.content.filter(b => b.type !== 'opaque' || b.provider === PROVIDER).map(outBlock)
    }))
  }
  if (system) body.system = system
  if (tools && tools.length) {
    body.tools = tools.map(t => ({ name: t.name, description: t.description, input_schema: t.schema }))
  }
  // effort and schema are two fields of the same object, so neither may clobber the other.
  // Thinking is on by default on the current models and its tokens come out of max_tokens —
  // which is why a short answer with a low ceiling can arrive truncated with nothing to show
  // for the tokens it spent.
  const output = {}
  if (effort) output.effort = effort
  if (schema) output.format = { type: 'json_schema', schema }
  if (Object.keys(output).length) body.output_config = output
  return body
}

export function fromResponse(json) {
  const content = (json.content || []).map(b =>
    b.type === 'text' ? { type: 'text', text: b.text }
      : b.type === 'tool_use' ? { type: 'tool_use', id: b.id, name: b.name, input: b.input }
        // thinking / redacted_thinking: kept verbatim so the next turn can replay them.
        : opaque(PROVIDER, b)
  )
  return {
    content,
    stopReason: STOP[json.stop_reason] || 'other',
    usage: { in: json.usage?.input_tokens || 0, out: json.usage?.output_tokens || 0 }
  }
}
