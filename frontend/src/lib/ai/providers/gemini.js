// Google Gemini — https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
// The most distant of the three: the assistant role is called 'model', the system prompt lives
// in its own `systemInstruction` field, tool calls have NO id (they pair with their responses
// positionally, by name), and token counts come back under `usageMetadata` with different names.
import { resultToString, opaque } from '../message.js'

const PROVIDER = 'gemini'

// Gemini's schema dialect rejects `additionalProperties`, which our schemas carry because the
// other two providers want it. Strip it on the way out rather than keeping two copies of every
// schema — the field is a constraint we can afford to lose here, and parsePlan validates anyway.
function geminiSchema(s) {
  if (Array.isArray(s)) return s.map(geminiSchema)
  if (!s || typeof s !== 'object') return s
  const out = {}
  for (const [k, v] of Object.entries(s)) {
    if (k === 'additionalProperties') continue
    out[k] = geminiSchema(v)
  }
  return out
}

const outParts = m => m.content
  .filter(b => b.type !== 'opaque' || b.provider === PROVIDER)
  .map(b =>
    b.type === 'text' ? { text: b.text }
      : b.type === 'tool_use' ? { functionCall: { name: b.name, args: b.input ?? {} } }
        // Parts we do not model — thought signatures among them — go back exactly as they came.
        : b.type === 'opaque' ? b.raw
          // `response` is an object here, not a string — a bare string is rejected.
          : { functionResponse: { name: b.name, response: { result: resultToString(b.output) } } }
  )

// `effort` is accepted and deliberately ignored here. Gemini's equivalent lives under
// generationConfig.thinkingConfig, and the REST spelling of it is not something this was able
// to confirm — sending a field this API does not know is a 400, which would break Gemini
// outright to save some tokens. It gets the same larger ceiling as the others instead.
export function toRequest({ model, system, messages, tools, maxTokens = 4096, schema, effort }) {
  const body = {
    contents: messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: outParts(m) })),
    generationConfig: { maxOutputTokens: maxTokens }
  }
  if (system) body.systemInstruction = { parts: [{ text: system }] }
  if (tools && tools.length) {
    body.tools = [{
      functionDeclarations: tools.map(t => ({
        name: t.name, description: t.description, parameters: geminiSchema(t.schema)
      }))
    }]
  }
  if (schema) {
    body.generationConfig.responseMimeType = 'application/json'
    body.generationConfig.responseSchema = geminiSchema(schema)
  }
  // `model` is intentionally NOT in the body: on this API it goes in the URL path, and
  // generateContent rejects fields it does not know. The proxy gets it from the envelope.
  return body
}

export function fromResponse(json) {
  const cand = (json.candidates || [])[0]
  const content = []
  let call = 0
  for (const p of cand?.content?.parts || []) {
    if (p.text) content.push({ type: 'text', text: p.text })
    else if (!p.functionCall) { content.push(opaque(PROVIDER, p)); continue }
    else {
      // Gemini gives no call id. Synthesize a stable one so the neutral shape — and every other
      // provider we might replay this history to — has something to pair on.
      content.push({ type: 'tool_use', id: 'call_' + call++, name: p.functionCall.name, input: p.functionCall.args || {} })
    }
  }
  const u = json.usageMetadata || {}
  return {
    content,
    stopReason: content.some(b => b.type === 'tool_use') ? 'tool_use'
      : cand?.finishReason === 'MAX_TOKENS' ? 'max_tokens'
        : cand?.finishReason === 'SAFETY' ? 'refusal'
          : 'end',
    usage: { in: u.promptTokenCount || 0, out: u.candidatesTokenCount || 0 }
  }
}
