import { describe, expect, it } from 'vitest'
import { replaceExerciseRequest } from './actions.js'
import { run } from './run.js'

const state = () => ({
  unit: 'kg', workouts: [], routines: [], bodyweight: [], customEx: [],
  week: {}, exWeights: {}, targetW: null,
  equipProfiles: [], activeEquipId: null, equipFilterOn: false
})

// 0025 barbell bench press, 0030 close-grip bench press, 0043 squat, 0047 an incline press.
const replacing = { id: '0047', sets: 3, reps: 10 }
const keeping = [{ id: '0025', sets: 4, reps: 8 }, { id: '0043', sets: 3, reps: 10 }]

/** A provider that searches once, then submits whatever exercise it is told to. */
const submits = ex => {
  let n = 0
  return async () => {
    n++
    if (n === 1) {
      return { reply: { content: [{ type: 'tool_use', id: 's', name: 'search_exercises', input: { muscle: 'chest' } }], stop_reason: 'tool_use', usage: {} } }
    }
    return { reply: { content: [{ type: 'tool_use', id: 'x', name: 'submit_exercise', input: { reason: 'porque sim', exercise: ex } }], stop_reason: 'tool_use', usage: {} } }
  }
}

const ask = () => replaceExerciseRequest(state(), { routineName: 'Peito', replacing, keeping })

describe('replaceExerciseRequest', () => {
  it('tells the model what it may not hand back', () => {
    // It cannot see the preview, so being told is the only thing standing between the user and a
    // "different" exercise that is already two rows above.
    const text = ask().request.messages[0].content[0].text
    expect(text).toContain('do not repeat')
    expect(text.toLowerCase()).toContain('bench press')
  })

  it('accepts a genuinely different exercise', async () => {
    const { request, capture } = ask()
    const res = await run({ provider: 'anthropic', model: 'm', ...request, transport: submits({ id: '0030', sets: 3, reps: 10 }) })
    expect(capture.result.ex.id).toBe('0030')
    expect(capture.result.ex.weight).toBe(0)
    expect(capture.result.reason).toBe('porque sim')
    expect(res.stopReason).toBe('submitted')
  })

  it('refuses one that is already in the routine', async () => {
    // Otherwise the user presses swap, sees no change, and cannot tell whether it even ran.
    const { request, capture } = ask()
    await run({ provider: 'anthropic', model: 'm', ...request, transport: submits({ id: '0025', sets: 4, reps: 8 }) })
    expect(capture.result).toBe(null)
  })

  it('refuses the very exercise it was asked to replace', async () => {
    const { request, capture } = ask()
    await run({ provider: 'anthropic', model: 'm', ...request, transport: submits({ id: '0047', sets: 3, reps: 10 }) })
    expect(capture.result).toBe(null)
  })

  it('refuses an id that does not exist', async () => {
    const { request, capture } = ask()
    await run({ provider: 'anthropic', model: 'm', ...request, transport: submits({ id: 'INVENTED', sets: 3, reps: 8 }) })
    expect(capture.result).toBe(null)
  })

  it('tells the model why it was refused, so it can try again', async () => {
    const { request } = ask()
    const seen = []
    const transport = async req => {
      seen.push(req)
      return { reply: { content: [{ type: 'tool_use', id: 'x', name: 'submit_exercise', input: { reason: 'r', exercise: { id: '0025', sets: 4, reps: 8 } } }], stop_reason: 'tool_use', usage: {} } }
    }
    await run({ provider: 'anthropic', model: 'm', ...request, maxSteps: 2, transport })
    expect(JSON.stringify(seen[1])).toContain('already in the routine')
  })

  it('is the cheapest of the builders', async () => {
    // One slot, one or two searches. It must not be allowed to wander like the week builder.
    const { request } = ask()
    expect(request.maxSteps).toBeLessThan(10)
    expect(request.maxTokens).toBeLessThan(2000)
  })
})
