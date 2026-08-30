// The neutral shape every provider adapter translates to and from.
//
// Anthropic's shape is the neutral one on purpose: it is the only one of the three that keeps
// typed blocks INSIDE a turn, so a turn that says something and then calls two tools stays a
// single object. OpenAI and Gemini both flatten that — OpenAI into sibling items in one `input`
// array, Gemini into `parts` — and flattening is a lossless direction to travel. Going the other
// way (rebuilding turns out of a flat list) is where adapters usually get this wrong.
//
//   turn  := { role: 'user' | 'assistant', content: Block[] }
//   Block := { type: 'text',        text }
//          | { type: 'opaque',      provider, raw }   // carried, never interpreted
//          | { type: 'tool_use',    id, name, input }      // assistant side
//          | { type: 'tool_result', id, name, output }     // user side
//
// `opaque` is the block that makes multi-turn tool use work at all on a reasoning model. Every
// provider returns items in an assistant turn that mean nothing to us and everything to it —
// OpenAI's `reasoning` items, Anthropic's `thinking` blocks — and every one of them documents
// that they must be sent back unchanged on the next turn. Dropping them does not fail loudly: the
// model loses its own train of thought between turns, starts over, calls one more tool, and never
// converges. That is what a runaway loop looks like from the outside.
//
// So they ride along untouched and are re-emitted only to the provider they came from. Nothing
// else in the app looks inside one.
//
// `tool_result` carries `name` as well as `id` because Gemini's functionResponse is keyed by
// NAME and has no id at all. Dropping the name here would mean re-deriving it from the previous
// turn inside the Gemini adapter, which breaks the moment history is trimmed.

/** A tool the model may call: `schema` is a plain JSON Schema object. */
export const tool = (name, description, schema) => ({ name, description, schema })

export const text = t => ({ type: 'text', text: t })
export const toolUse = (id, name, input) => ({ type: 'tool_use', id, name, input })
export const toolResult = (id, name, output) => ({ type: 'tool_result', id, name, output })

/** A provider-native item we carry but never read. Replayed only to the provider that made it. */
export const opaque = (provider, raw) => ({ type: 'opaque', provider, raw })

export const userTurn = content => ({ role: 'user', content: Array.isArray(content) ? content : [text(content)] })
export const assistantTurn = content => ({ role: 'assistant', content: Array.isArray(content) ? content : [text(content)] })

/** Every tool_use block in a turn — the loop in run.js asks this to decide whether to keep going. */
export const toolCalls = turn => (turn?.content || []).filter(b => b.type === 'tool_use')

/** All the text of a turn, joined. Blocks that aren't text are skipped, not stringified. */
export const textOf = turn =>
  (turn?.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n').trim()

// A tool result travels as a string on all three wires. Objects are the normal case (our tools
// return JSON), but a tool that already returned a string should not come out double-quoted.
export const resultToString = output => (typeof output === 'string' ? output : JSON.stringify(output))
