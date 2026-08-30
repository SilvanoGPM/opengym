// The tool-use loop.
//
// It runs on the CLIENT, and that is the whole architecture in one sentence. The tools an
// openGym assistant needs — searching the exercise catalogue, reading a routine, estimating a
// 1RM — are all implemented in frontend/src/lib, and the api container cannot import that code
// (api/Dockerfile copies three files; the compose build context is ./api). So the client drives
// the conversation and the server stays a stateless proxy that knows nothing about training.
import { api } from '../api.js'
import { providerOf } from './providers/index.js'
import { toolCalls, textOf, toolResult } from './message.js'

// Enough for "search three muscle groups, then answer". A model that wants more than this is
// stuck in a loop, and a runaway loop spends the user's money.
//
// Building a routine legitimately needs more: one search per muscle group, and a week is several
// days of them. Those callers raise it — see `maxSteps` — because hitting the cap there is not a
// runaway, it is the task.
export const MAX_STEPS = 6

/**
 * The default transport: POST the already-built provider body to our own proxy.
 *
 * It answers with an envelope — { reply, usage, usd, spend } — rather than the provider's JSON
 * bare, because the running spend is the server's to report: it is the side that holds the price
 * table and enforces the cap. `reply` is the provider's response, untouched.
 */
export const proxy = ({ provider, model, body, signal }) =>
  api('/api/ai/chat', { method: 'POST', body: JSON.stringify({ provider, model, body }), signal })

/**
 * @param {object} o
 * @param {string} o.provider     'anthropic' | 'openai' | 'gemini'
 * @param {string} o.model
 * @param {string} [o.system]
 * @param {Array}  o.messages     neutral turns (see message.js)
 * @param {Array}  [o.tools]      neutral tool declarations
 * @param {object} [o.toolbox]    { [name]: async input => output } — executed here, locally
 * @param {object} [o.schema]     JSON Schema to constrain the final answer
 * @param {string} [o.stopAfter]  tool name that ends the run — its call IS the answer
 * @param {number} [o.maxSteps]   how many provider round trips before giving up
 * @param {AbortSignal} [o.signal] abort to stop the run; the current request is cancelled too
 * @param {string} [o.effort]     how hard to think ('low' … 'high'); ignored by providers without it
 * @param {Function} [o.transport] injectable for tests
 * @returns {Promise<{text, turns, usage, stopReason, steps}>}
 */
export async function run({
  provider, model, system, messages, tools = [], toolbox = {},
  maxTokens = 4096, schema, effort, stopAfter, maxSteps = MAX_STEPS, signal, transport = proxy
}) {
  const adapter = providerOf(provider)
  if (!adapter) throw new Error('unknown provider: ' + provider)

  const turns = messages.slice()
  const usage = { in: 0, out: 0 }
  let stopReason = 'end'
  let spend = null
  let steps = 0

  while (steps < maxSteps) {
    // Checked here, at the top, so it catches a cancel from anywhere in the previous pass —
    // including from inside a tool, which can run for a while. What a tool loop costs is the
    // NUMBER of round trips, so the one worth stopping is always the next one; the request
    // already in flight is aborted by the same signal, inside the transport.
    if (signal?.aborted) { stopReason = 'cancelled'; break }
    steps++
    const body = adapter.toRequest({ model, system, messages: turns, tools, maxTokens, schema, effort })
    const envelope = await transport({ provider, model, body, signal })
    if (envelope && envelope.spend) spend = envelope.spend
    const reply = adapter.fromResponse(envelope && envelope.reply ? envelope.reply : envelope)

    usage.in += reply.usage.in
    usage.out += reply.usage.out
    stopReason = reply.stopReason
    turns.push({ role: 'assistant', content: reply.content })

    const calls = toolCalls({ content: reply.content })
    if (!calls.length) break


    // Every call in the turn gets a result, including the ones that failed. Dropping a result
    // leaves the conversation malformed on all three wires — the next request is rejected, and
    // the error you get back describes the missing block rather than the tool that broke.
    const results = []
    for (const c of calls) {
      const fn = toolbox[c.name]
      let output
      if (typeof fn !== 'function') output = { error: 'unknown tool: ' + c.name }
      else {
        try { output = await fn(c.input || {}) } catch (e) { output = { error: String(e?.message || e) } }
      }
      results.push(toolResult(c.id, c.name, output))
    }
    turns.push({ role: 'user', content: results })

    // Some answers arrive AS a tool call — a finished plan, submitted. There is nothing left to
    // ask for once one lands, and another turn would resend the whole conversation to be told
    // so. Stopping there is a round trip the user does not pay for.
    //
    // But only when the submission was ACCEPTED. A submit handler that validates — and all of
    // them do — answers `{ ok: false, error }` for a plan it cannot use, and that error exists to
    // be read: stopping on it would end the run on the one turn where the model still had a way
    // to fix things, and the user would see 'it did not come back with anything usable' after a
    // failure the model was one sentence away from correcting.
    const submitted = results.some((r, i) => calls[i].name === stopAfter && r.output?.ok !== false)
    if (stopAfter && submitted) { stopReason = 'submitted'; break }
  }

  // Falling out of the loop still calling tools is the runaway case. Say so rather than
  // returning whatever half-thought the last turn happened to contain.
  if (steps >= maxSteps && stopReason === 'tool_use') stopReason = 'max_steps'

  return { text: textOf(turns[turns.length - 1]), turns, usage, stopReason, steps, spend }
}

/** run() plus JSON.parse of the final text, for the schema-constrained calls. */
export async function runJSON(opts) {
  const res = await run(opts)
  try { res.json = JSON.parse(res.text) } catch { res.json = null }
  return res
}

/**
 * Why a finished run produced nothing to show, or null when it produced something.
 *
 * A run can succeed and still be empty: on a reasoning model the whole output allowance can go
 * on thinking, leaving an assistant turn with reasoning blocks and no text. Left unhandled that
 * renders as silence — the question on screen, nothing under it, no error — which reads as the
 * app being broken rather than the model having run out of room.
 */
export function emptyAnswer(res) {
  if (res?.text) return null
  if (res?.stopReason === 'max_steps') return 'max_steps'
  if (res?.stopReason === 'max_tokens') return 'max_tokens'
  return 'empty'
}
