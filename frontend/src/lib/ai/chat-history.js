// Deciding how much of a conversation to send.
//
// Every turn resends the whole thread, so an unbounded chat costs more with each message until
// it eventually exceeds the proxy's request cap and fails outright. Trimming keeps the cost flat.
//
// Trimming to a WHOLE number of exchanges is what keeps it valid: a tool call separated from its
// result is a malformed conversation on all three wires, and what comes back describes the
// missing block rather than anything a user could act on.

/** How many turns of history travel with each question. */
export const CHAT_TURNS = 12

/** A plain question — as opposed to a user turn that carries tool results. */
export const isQuestion = turn =>
  turn?.role === 'user' && (turn.content || []).every(b => b.type === 'text')

/** Drop the oldest turns, never landing between a tool call and its result. */
export function trimHistory(turns, cap = CHAT_TURNS) {
  if (turns.length <= cap) return turns
  let cut = turns.length - cap
  // A user turn made only of tool results makes no sense without the assistant turn that asked
  // for them, so walk forward to the next real question and start the conversation there.
  while (cut < turns.length && !isQuestion(turns[cut])) cut++
  return cut >= turns.length ? turns.slice(-1) : turns.slice(cut)
}
