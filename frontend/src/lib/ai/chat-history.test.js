import { describe, expect, it } from 'vitest'
import { trimHistory, CHAT_TURNS } from './chat-history.js'
import { userTurn, assistantTurn, toolUse, toolResult } from './message.js'

// One exchange that used a tool: question, the call, the result, the answer.
const exchange = n => [
  userTurn('question ' + n),
  assistantTurn([toolUse('c' + n, 'list_workouts', {})]),
  { role: 'user', content: [toolResult('c' + n, 'list_workouts', [])] },
  assistantTurn('answer ' + n)
]

const plain = n => [userTurn('q' + n), assistantTurn('a' + n)]

describe('trimHistory', () => {
  it('leaves a short conversation alone', () => {
    const turns = [...plain(1), ...plain(2)]
    expect(trimHistory(turns)).toBe(turns)
  })

  it('drops the oldest turns once the conversation is long', () => {
    const turns = Array.from({ length: 20 }, (_, i) => plain(i)).flat()
    const kept = trimHistory(turns)
    expect(kept.length).toBeLessThanOrEqual(CHAT_TURNS)
    expect(kept.at(-1)).toBe(turns.at(-1))
  })

  it('never starts a conversation on a tool result', () => {
    // A tool result with no call in front of it is a malformed conversation on all three wires,
    // and the error names the missing block rather than anything useful. The cut has to land on
    // a real question.
    const turns = Array.from({ length: 8 }, (_, i) => exchange(i)).flat()
    const kept = trimHistory(turns)
    expect(kept[0].role).toBe('user')
    expect(kept[0].content.every(b => b.type === 'text')).toBe(true)
  })

  it('never keeps a tool call whose result was trimmed away', () => {
    const turns = Array.from({ length: 8 }, (_, i) => exchange(i)).flat()
    const kept = trimHistory(turns)
    const calls = kept.flatMap(t => t.content.filter(b => b.type === 'tool_use')).map(b => b.id)
    const results = kept.flatMap(t => t.content.filter(b => b.type === 'tool_result')).map(b => b.id)
    expect(calls.sort()).toEqual(results.sort())
  })

  it('keeps something to send even when nothing can be kept whole', () => {
    const turns = [userTurn('only question'), ...Array.from({ length: 30 }, (_, i) =>
      [assistantTurn([toolUse('c' + i, 'x', {})]), { role: 'user', content: [toolResult('c' + i, 'x', [])] }]).flat()]
    expect(trimHistory(turns, 4).length).toBeGreaterThan(0)
  })

  it('respects a cap passed in', () => {
    const turns = Array.from({ length: 10 }, (_, i) => plain(i)).flat()
    expect(trimHistory(turns, 4).length).toBeLessThanOrEqual(4)
  })
})
