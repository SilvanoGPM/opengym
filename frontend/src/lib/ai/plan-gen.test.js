import { describe, expect, it } from 'vitest'
import {
  toPlanBundle, planFromAnswer, exercisesFromAnswer, exerciseFromAnswer,
  PLAN_SCHEMA, ROUTINE_SCHEMA, ONE_EXERCISE_SCHEMA, LIMITS
} from './plan-gen.js'
import { mergePlan } from '../plan-share.js'
import { EXIDX } from '../exercises.js'

// 0025 barbell bench press, 0027 barbell bent over row, 0043 barbell full squat.
const answer = extra => ({
  name: 'Semana',
  summary: 'Três dias.',
  routines: [{ name: 'Empurrar', weekday: 1, exercises: [{ id: '0025', sets: 4, reps: 8 }] }],
  ...extra
})

describe('toPlanBundle', () => {
  it('produces the same shape a shared plan file has', () => {
    const b = toPlanBundle(answer())
    expect(b.opengym_plan).toBe(1)
    expect(b.routines[0].ex[0]).toEqual({ id: '0025', sets: 4, reps: 8, weight: 0 })
    expect(b.customEx).toEqual([])
  })

  it('never prescribes a weight', () => {
    // The first weight is the progression engine's job. A number a model guesses is a number
    // somebody loads onto a bar.
    const b = toPlanBundle(answer({
      routines: [{ name: 'A', weekday: 1, exercises: [{ id: '0025', sets: 3, reps: 5, weight: 180 }] }]
    }))
    expect(b.routines[0].ex[0].weight).toBe(0)
  })

  it('clamps every number it is given', () => {
    const b = toPlanBundle(answer({
      routines: [{ name: 'A', weekday: 1, exercises: [
        { id: '0025', sets: 9999, reps: -4 },
        { id: '0027', sets: 0, reps: 999 },
        { id: '0043', sets: 'three', reps: null }
      ] }]
    }))
    expect(b.routines[0].ex.map(e => [e.sets, e.reps])).toEqual([
      [LIMITS.sets, 1], [1, LIMITS.reps], [3, 10]
    ])
  })

  it('cuts long text rather than storing it', () => {
    const b = toPlanBundle(answer({
      name: 'x'.repeat(500),
      routines: [{ name: 'y'.repeat(500), weekday: 1, exercises: [{ id: '0025', sets: 3, reps: 8, note: 'z'.repeat(900) }] }]
    }))
    expect(b.name.length).toBe(LIMITS.nameChars)
    expect(b.routines[0].name.length).toBe(LIMITS.nameChars)
    expect(b.routines[0].ex[0].note.length).toBe(LIMITS.noteChars)
  })

  it('caps how much plan one answer can produce', () => {
    const many = n => Array.from({ length: n }, (_, i) => ({
      name: 'R' + i, weekday: -1, exercises: Array.from({ length: 40 }, () => ({ id: '0025', sets: 3, reps: 8 }))
    }))
    const b = toPlanBundle(answer({ routines: many(30) }))
    expect(b.routines.length).toBe(LIMITS.routines)
    expect(b.routines[0].ex.length).toBe(LIMITS.exercises)
  })

  it('does not let two routines claim the same day', () => {
    // The second would silently overwrite the first in the week, and the plan the user was
    // shown would not be the plan they got.
    const b = toPlanBundle(answer({
      routines: [
        { name: 'A', weekday: 1, exercises: [{ id: '0025', sets: 3, reps: 8 }] },
        { name: 'B', weekday: 1, exercises: [{ id: '0027', sets: 3, reps: 8 }] }
      ]
    }))
    expect(Object.keys(b.week)).toEqual(['1'])
    expect(b.routines.length).toBe(2)
    expect(b.week['1']).toBe(b.routines[0].id)
  })

  it('treats an out-of-range weekday as unscheduled', () => {
    const b = toPlanBundle(answer({ routines: [{ name: 'A', weekday: 99, exercises: [{ id: '0025', sets: 3, reps: 8 }] }] }))
    expect(Object.keys(b.week)).toEqual(['6'])
    const c = toPlanBundle(answer({ routines: [{ name: 'A', weekday: -1, exercises: [{ id: '0025', sets: 3, reps: 8 }] }] }))
    expect(c.week).toEqual({})
  })

  it('drops a routine with nothing in it', () => {
    const b = toPlanBundle(answer({
      routines: [{ name: 'Vazia', weekday: 2, exercises: [] }, { name: 'A', weekday: 1, exercises: [{ id: '0025', sets: 3, reps: 8 }] }]
    }))
    expect(b.routines.map(r => r.name)).toEqual(['A'])
    expect(b.week).toEqual({ 1: b.routines[0].id })
  })

  it('gives every routine its own fresh id', () => {
    const b = toPlanBundle(answer({
      routines: [
        { name: 'A', weekday: 1, exercises: [{ id: '0025', sets: 3, reps: 8 }] },
        { name: 'B', weekday: 2, exercises: [{ id: '0027', sets: 3, reps: 8 }] }
      ]
    }))
    expect(new Set(b.routines.map(r => r.id)).size).toBe(2)
  })

  it('refuses an answer that is not one', () => {
    expect(toPlanBundle(null)).toBe(null)
    expect(toPlanBundle({})).toBe(null)
    expect(toPlanBundle({ routines: 'nope' })).toBe(null)
    expect(toPlanBundle({ routines: [] })).toBe(null)
  })
})

describe('planFromAnswer', () => {
  it('reports the exercises it had to drop', () => {
    // The count belongs in front of the user: a plan that lost three exercises is not the plan
    // the summary described.
    const r = planFromAnswer(answer({
      routines: [{ name: 'A', weekday: 1, exercises: [
        { id: '0025', sets: 3, reps: 8 },
        { id: 'INVENTED', sets: 3, reps: 8 }
      ] }]
    }))
    expect(r.dropped).toBe(1)
    expect(r.exerciseCount).toBe(1)
    expect(r.bundle.routines[0].ex.map(e => e.id)).toEqual(['0025'])
  })

  it('refuses a plan whose exercises were all invented', () => {
    // toPlanBundle cannot catch this — the ids are strings, so the routine looks populated until
    // parsePlan resolves them. Left alone it would offer the user an empty day.
    expect(planFromAnswer(answer({
      routines: [{ name: 'A', weekday: 1, exercises: [{ id: 'zzz', sets: 3, reps: 8 }] }]
    }))).toBe(null)
  })

  it('drops the day that emptied out but keeps the ones that did not', () => {
    const r = planFromAnswer(answer({
      routines: [
        { name: 'Boa', weekday: 1, exercises: [{ id: '0025', sets: 3, reps: 8 }] },
        { name: 'Inventada', weekday: 2, exercises: [{ id: 'zzz', sets: 3, reps: 8 }] }
      ]
    }))
    expect(r.routineCount).toBe(1)
    expect(r.bundle.routines[0].name).toBe('Boa')
    expect(r.scheduledDays).toBe(1)
    expect(Object.keys(r.bundle.week)).toEqual(['1'])
  })

  it('carries the summary through for the preview', () => {
    expect(planFromAnswer(answer({ summary: 'Porque você treina 3x.' })).summary).toBe('Porque você treina 3x.')
  })
})

describe('the plan a user would actually get', () => {
  it('merges in without touching what they already had', () => {
    // mergePlan is the app's own import path: fresh ids, never an overwrite.
    const existing = { id: 'mine', name: 'Minha rotina', ex: [{ id: '0043', sets: 5, reps: 5 }] }
    const s = { routines: [existing], customEx: [], week: { 5: 'mine' } }
    const r = planFromAnswer(answer())
    mergePlan(s, r.bundle, { schedule: false })

    expect(s.routines).toHaveLength(2)
    expect(s.routines[0]).toEqual(existing)
    expect(s.week).toEqual({ 5: 'mine' })
  })

  it('replaces the week only when asked', () => {
    const s = { routines: [{ id: 'mine', name: 'M', ex: [] }], customEx: [], week: { 5: 'mine' } }
    mergePlan(s, planFromAnswer(answer()).bundle, { schedule: true })
    expect(s.week[5]).toBeUndefined()
    expect(s.week[1]).toBeTruthy()
  })

  it('produces exercises the rest of the app can resolve', () => {
    const r = planFromAnswer(answer({
      routines: [{ name: 'A', weekday: 1, exercises: [{ id: '0025', sets: 3, reps: 8 }, { id: '0043', sets: 5, reps: 5 }] }]
    }))
    for (const ex of r.bundle.routines[0].ex) expect(EXIDX[ex.id]).toBeTruthy()
  })
})

describe('PLAN_SCHEMA', () => {
  it('uses only the schema subset every provider accepts', () => {
    const allowed = new Set(['type', 'description', 'enum', 'items', 'properties', 'required', 'additionalProperties'])
    const walk = node => {
      if (!node || typeof node !== 'object') return
      Object.keys(node).forEach(k => expect(allowed.has(k), `unsupported: ${k}`).toBe(true))
      Object.values(node.properties || {}).forEach(walk)
      if (node.items) walk(node.items)
    }
    walk(PLAN_SCHEMA)
  })

  it('does not ask the model for anything the app decides itself', () => {
    // Every extra field is one a model can get subtly wrong in a way nobody notices until they
    // are under the bar.
    const ex = PLAN_SCHEMA.properties.routines.items.properties.exercises.items.properties
    expect(Object.keys(ex).sort()).toEqual(['id', 'note', 'reps', 'sets'])
  })
})

describe('exercisesFromAnswer', () => {
  it('fills one routine, with no name and no weekday of its own', () => {
    // The routine already has both. Letting a model rename the thing the user just named would
    // be a surprise rather than a feature.
    const r = exercisesFromAnswer({
      summary: 'Peito e tríceps.',
      exercises: [{ id: '0025', sets: 4, reps: 8 }, { id: '0047', sets: 3, reps: 10, note: 'controle' }]
    })
    expect(r.ex).toEqual([
      { id: '0025', sets: 4, reps: 8, weight: 0 },
      { id: '0047', sets: 3, reps: 10, weight: 0, note: 'controle' }
    ])
    expect(r.summary).toBe('Peito e tríceps.')
    expect(r.dropped).toBe(0)
  })

  it('runs the same gauntlet the full plan does', () => {
    // It IS the full plan, with one routine — so clamping and id resolution cannot drift between
    // the two entry points.
    const r = exercisesFromAnswer({
      summary: 's',
      exercises: [{ id: '0025', sets: 9999, reps: -1 }, { id: 'INVENTED', sets: 3, reps: 8 }]
    })
    expect(r.ex).toEqual([{ id: '0025', sets: LIMITS.sets, reps: 1, weight: 0 }])
    expect(r.dropped).toBe(1)
  })

  it('never prescribes a weight here either', () => {
    const r = exercisesFromAnswer({ summary: 's', exercises: [{ id: '0025', sets: 3, reps: 5, weight: 200 }] })
    expect(r.ex[0].weight).toBe(0)
  })

  it('refuses an answer with nothing usable in it', () => {
    expect(exercisesFromAnswer(null)).toBe(null)
    expect(exercisesFromAnswer({ summary: 's' })).toBe(null)
    expect(exercisesFromAnswer({ summary: 's', exercises: [] })).toBe(null)
    expect(exercisesFromAnswer({ summary: 's', exercises: [{ id: 'zzz', sets: 1, reps: 1 }] })).toBe(null)
  })
})

describe('ROUTINE_SCHEMA', () => {
  it('asks for exercises and a summary, and nothing the routine already has', () => {
    expect(Object.keys(ROUTINE_SCHEMA.properties).sort()).toEqual(['exercises', 'summary'])
  })

  it('shares its exercise shape with the full plan, rather than copying it', () => {
    expect(ROUTINE_SCHEMA.properties.exercises)
      .toBe(PLAN_SCHEMA.properties.routines.items.properties.exercises)
  })

  it('uses only the schema subset every provider accepts', () => {
    const allowed = new Set(['type', 'description', 'enum', 'items', 'properties', 'required', 'additionalProperties'])
    const walk = node => {
      if (!node || typeof node !== 'object') return
      Object.keys(node).forEach(k => expect(allowed.has(k), `unsupported: ${k}`).toBe(true))
      Object.values(node.properties || {}).forEach(walk)
      if (node.items) walk(node.items)
    }
    walk(ROUTINE_SCHEMA)
  })
})

describe('exerciseFromAnswer', () => {
  it('resolves and clamps one exercise', () => {
    const r = exerciseFromAnswer({ reason: 'Menos carga no punho.', exercise: { id: '0047', sets: 999, reps: 0 } })
    expect(r.ex).toEqual({ id: '0047', sets: LIMITS.sets, reps: 1, weight: 0 })
    expect(r.reason).toBe('Menos carga no punho.')
  })

  it('is null when the id does not resolve', () => {
    // The caller has to leave the original row in place: blanking it would lose a suggestion the
    // user might have been perfectly happy with.
    expect(exerciseFromAnswer({ reason: 'x', exercise: { id: 'INVENTED', sets: 3, reps: 8 } })).toBe(null)
    expect(exerciseFromAnswer({ reason: 'x' })).toBe(null)
    expect(exerciseFromAnswer(null)).toBe(null)
  })

  it('never prescribes a weight', () => {
    expect(exerciseFromAnswer({ reason: 'x', exercise: { id: '0047', sets: 3, reps: 8, weight: 90 } }).ex.weight).toBe(0)
  })
})

describe('ONE_EXERCISE_SCHEMA', () => {
  it('shares the exercise shape rather than copying it', () => {
    expect(ONE_EXERCISE_SCHEMA.properties.exercise)
      .toBe(PLAN_SCHEMA.properties.routines.items.properties.exercises.items)
  })

  it('uses only the schema subset every provider accepts', () => {
    const allowed = new Set(['type', 'description', 'enum', 'items', 'properties', 'required', 'additionalProperties'])
    const walk = node => {
      if (!node || typeof node !== 'object') return
      Object.keys(node).forEach(k => expect(allowed.has(k), `unsupported: ${k}`).toBe(true))
      Object.values(node.properties || {}).forEach(walk)
      if (node.items) walk(node.items)
    }
    walk(ONE_EXERCISE_SCHEMA)
  })
})
