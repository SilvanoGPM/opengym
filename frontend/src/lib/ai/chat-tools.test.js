import { describe, expect, it } from 'vitest'
import { buildDemoState } from '../demoSeed.js'
import { chatToolbox, CHAT_TOOLS, LIST_CAP } from './chat-tools.js'
import { workoutVolume } from '../history.js'

const empty = () => ({
  unit: 'kg', workouts: [], routines: [], bodyweight: [], customEx: [],
  week: {}, dayPlan: {}, exWeights: {}, targetW: null,
  equipProfiles: [], activeEquipId: null, equipFilterOn: false
})

describe('the chat tools', () => {
  const S = buildDemoState()
  const box = chatToolbox(S)

  it('reports the same volume the rest of the app does', () => {
    // The point of going through context.js: these numbers, the Stats screen and the MCP server
    // are the same functions, so they cannot drift apart.
    const rows = box.list_workouts({ limit: 5 }).workouts
    for (const row of rows) {
      const w = S.workouts.find(x => x.id === row.id)
      expect(row.volume).toBeCloseTo(Math.round(workoutVolume(w) * 10) / 10, 5)
    }
  })

  it('lists sessions newest first without reordering the history', () => {
    // S.workouts is oldest-first and that order is load-bearing — insertWorkout, stallCount and
    // lastEntryFor all read "most recent" as "last in the array".
    const before = S.workouts.map(w => w.d)
    const dates = box.list_workouts({ limit: 5 }).workouts.map(w => w.date)
    expect([...dates].sort().reverse()).toEqual(dates)
    expect(S.workouts.map(w => w.d)).toEqual(before)
  })

  it('caps every list, because a conversation resends its history each turn', () => {
    expect(box.list_workouts({ limit: 9999 }).workouts.length).toBeLessThanOrEqual(LIST_CAP)
    expect(box.get_bodyweight({ limit: 9999 }).weigh_ins.length).toBeLessThanOrEqual(LIST_CAP)
  })

  it('hands back both ids when a date has two sessions', () => {
    // Picking one silently would answer about the wrong workout.
    const day = S.workouts[0].d
    const twice = { ...S, workouts: [...S.workouts, { ...S.workouts[0], id: 'second' }] }
    const r = chatToolbox(twice).get_workout({ date: day })
    expect(r.ambiguous).toBe(true)
    expect(r.workouts.length).toBe(2)
  })

  it('tells apart "never trained" from "trained, but no estimate"', () => {
    // These are different answers and they used to share one vague sentence. The first is
    // usually a sign the id came from the library rather than from their log, and saying so is
    // what lets the model recover in the same turn instead of reporting a false negative.
    const never = chatToolbox(empty()).estimate_1rm({ exercise_id: '0025' })
    expect(never.estimate).toBe(null)
    expect(never.reason).toContain('never logged this exercise')
    expect(never.reason).toContain('exercise')

    // A body-weight exercise they did log: trained, but nothing an estimate can be built from.
    const logged = {
      ...empty(),
      workouts: [{ id: 'w', d: '2026-08-01', entries: [{ id: '0001', sets: [{ w: 0, r: 20, done: true }] }] }]
    }
    const r = chatToolbox(logged).estimate_1rm({ exercise_id: '0001' })
    expect(r.estimate).toBe(null)
    expect(r.reason).toContain('they have trained this')
  })

  it('gives the set an estimate came from, not just the number', () => {
    const id = S.workouts.at(-1).entries[0].id
    const r = box.estimate_1rm({ exercise_id: id })
    expect(r.estimate).toBeGreaterThan(0)
    expect(r.from).toMatch(/x/)
    expect(r.on).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('answers a bad routine id with a way forward', () => {
    expect(box.get_routine({ routine_id: 'nope' }).error).toContain('list_routines')
  })

  it('ranks muscles and names the neglected ones', () => {
    const r = box.muscle_balance({ period: 'month' })
    expect(r.worked[0].effective_sets).toBeGreaterThanOrEqual(r.worked.at(-1).effective_sets)
    expect(Array.isArray(r.neglected)).toBe(true)
  })

  it('survives a profile with nothing in it', () => {
    const bare = chatToolbox(empty())
    expect(bare.list_routines().routines).toEqual([])
    expect(bare.list_workouts({}).workouts).toEqual([])
    expect(bare.get_bodyweight({}).latest).toBe(null)
    expect(bare.get_workout({ date: '2026-01-01' }).error).toBeTruthy()
    expect(bare.muscle_balance({}).sessions).toBe(0)
    expect(bare.get_week_plan().today_routine).toBe(null)
  })

  it('can be called with no arguments at all', () => {
    // A model that calls a tool with {} must not crash the run.
    for (const name of Object.keys(box)) expect(() => box[name]()).not.toThrow()
  })
})

describe('the chat declarations', () => {
  it('is read-only — nothing here can change anything', () => {
    // The chat cannot write. The plan builder is the only thing that can, and it asks first.
    const writes = /^(add|set|save|log|create|update|delete|edit|submit|merge)_/
    for (const tool of CHAT_TOOLS) expect(tool.name).not.toMatch(writes)
  })

  it('uses only the schema subset every provider accepts', () => {
    const allowed = new Set(['type', 'description', 'enum', 'items', 'properties', 'required', 'additionalProperties'])
    const walk = node => {
      if (!node || typeof node !== 'object') return
      Object.keys(node).forEach(k => expect(allowed.has(k), `${k} is not portable`).toBe(true))
      Object.values(node.properties || {}).forEach(walk)
      if (node.items) walk(node.items)
    }
    CHAT_TOOLS.forEach(t => walk(t.schema))
  })

  it('declares a handler for every tool, and a tool for every handler', () => {
    // A declared tool with no handler answers "unknown tool" mid-conversation; a handler with no
    // declaration is never called. Both are silent.
    expect(Object.keys(chatToolbox(empty())).sort()).toEqual(CHAT_TOOLS.map(t => t.name).sort())
  })
})

describe('asking about a movement rather than one catalogue entry', () => {
  // The bug this exists for, from a real conversation: asked "what is my bench PR", the model
  // searched the LIBRARY, got the canonical barbell bench press, and answered "no PR" to somebody
  // who benches every week — on a decline bar and a seated dumbbell press. The library knows every
  // exercise that exists; the question was about the fifteen they actually do.
  const S = {
    unit: 'kg', routines: [], bodyweight: [], customEx: [], week: {}, exWeights: {}, targetW: null,
    equipProfiles: [], activeEquipId: null, equipFilterOn: false,
    workouts: [{
      id: 'w1', d: '2026-08-27', entries: [
        // 0033 barbell decline bench press, 0290 dumbbell bench seated press — neither is 0025.
        { id: '0033', sets: [{ w: 40, r: 10, done: true }] },
        { id: '0290', sets: [{ w: 18, r: 8, done: true }] },
        { id: '0110', sets: [{ w: 25, r: 10, done: true }] }
      ]
    }]
  }
  const box = chatToolbox(S)

  it('finds every bench variation they actually train', () => {
    const r = box.estimate_1rm({ exercise: 'bench press' })
    expect(r.matched.map(m => m.exercise_id).sort()).toEqual(['0033', '0290'])
    expect(r.matched[0].estimate).toBeGreaterThan(0)
  })

  it('puts the biggest estimate first, because that is the PR', () => {
    const r = box.estimate_1rm({ exercise: 'bench press' })
    expect(r.matched[0].exercise_id).toBe('0033')
    expect(r.matched[0].estimate).toBeGreaterThanOrEqual(r.matched[1].estimate)
  })

  it('never reaches an exercise they have not done', () => {
    // The whole point: 0025 is what a library search returns for "bench press", and it must not
    // appear in an answer about their own training.
    const r = box.estimate_1rm({ exercise: 'bench press' })
    expect(r.matched.some(m => m.exercise_id === '0025')).toBe(false)
  })

  it('says so plainly when they have never trained anything like it', () => {
    const r = box.estimate_1rm({ exercise: 'squat' })
    expect(r.matched).toEqual([])
    expect(r.note).toContain('never logged anything matching')
    expect(r.note).toContain('list_trained_exercises')
  })
})

describe('list_trained_exercises', () => {
  const S = buildDemoState()

  it('is their log, not the library', () => {
    const r = chatToolbox(S).list_trained_exercises({})
    expect(r.count).toBeGreaterThan(0)
    expect(r.count).toBeLessThan(60)
    expect(r.exercises[0].sessions).toBeGreaterThan(0)
    expect(r.exercises[0].last_trained).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('lists what they did most recently first', () => {
    const dates = chatToolbox(S).list_trained_exercises({}).exercises.map(e => e.last_trained)
    expect([...dates].sort().reverse()).toEqual(dates)
  })

  it('filters by a plain word', () => {
    const r = chatToolbox(S).list_trained_exercises({ query: 'squat' })
    expect(r.count).toBeGreaterThan(0)
    expect(r.exercises.every(e => /squat|agachamento/i.test(e.name))).toBe(true)
  })

  it('says what to do next when the filter matches nothing', () => {
    const r = chatToolbox(S).list_trained_exercises({ query: 'xyzzy' })
    expect(r.count).toBe(0)
    expect(r.note).toContain('broader word')
  })
})
