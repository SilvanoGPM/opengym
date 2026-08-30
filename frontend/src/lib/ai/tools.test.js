import { describe, expect, it } from 'vitest'
import { searchExercises, getExercises, exerciseToolbox, resolveEquipment, EXERCISE_TOOLS, SEARCH_CAP } from './tools.js'
import { EXIDX, registerCustom } from '../exercises.js'
import { MUSCLES } from '../muscles.js'

const state = extra => ({ customEx: [], equipProfiles: [], activeEquipId: null, equipFilterOn: false, ...extra })

describe('searchExercises', () => {
  it('only ever returns ids that resolve', () => {
    // The property the whole design rests on: a routine can only name exercises that came back
    // from here, so if everything here is real, nothing the model writes can be invented.
    const S = state()
    for (const q of ['bench press', 'row', 'squat', 'curl', 'zzzz nonsense']) {
      for (const ex of searchExercises(S, { query: q })) {
        expect(EXIDX[ex.id], `${q} → ${ex.id}`).toBeTruthy()
      }
    }
  })

  it('never hands back more than the cap, whatever is asked for', () => {
    // Without this the model gets the catalogue back, which is the cost the tool exists to avoid.
    const S = state()
    expect(searchExercises(S, {}).length).toBe(SEARCH_CAP)
    expect(searchExercises(S, { limit: 9999 }).length).toBe(SEARCH_CAP)
    expect(searchExercises(S, { limit: -5 }).length).toBe(1)
    expect(searchExercises(S, { limit: 'abc' }).length).toBe(SEARCH_CAP)
  })

  it('stays small enough to send on every turn', () => {
    const bytes = JSON.stringify(searchExercises(state(), { muscle: 'chest' })).length
    expect(bytes).toBeLessThan(4000)
  })

  it('puts the exercises that actually train the muscle first', () => {
    // matchesMuscleGroups counts secondary involvement, so a chest search reaches the dumbbell
    // arnold press — right for the muscle map, wrong for building a chest day.
    const rows = searchExercises(state(), { muscle: 'chest', limit: 10 })
    expect(rows.every(r => r.target === 'pectorals')).toBe(true)
  })

  it('honours the equipment profile, because it is what they can actually train', () => {
    const S = state({
      equipFilterOn: true,
      activeEquipId: 'e1',
      equipProfiles: [{ id: 'e1', name: 'Home', equipment: ['dumbbell'] }]
    })
    const kit = new Set(searchExercises(S, { muscle: 'chest', limit: SEARCH_CAP }).map(r => r.equipment))
    // Body weight is never gated by a profile — no setup can take it away from you.
    expect([...kit].every(e => e === 'dumbbell' || e === 'body weight')).toBe(true)
    expect(kit.has('barbell')).toBe(false)
  })

  it('filters by body part exactly and by equipment forgivingly', () => {
    // Body part is a closed enum, so it is exact. Equipment is deliberately not: asking for
    // "barbell" reaches the EZ and olympic bars too, which is what somebody means by it.
    const S = state()
    expect(searchExercises(S, { body_part: 'chest', limit: 10 }).every(r => r.body_part === 'chest')).toBe(true)
    const bars = new Set(searchExercises(S, { equipment: 'barbell', limit: SEARCH_CAP }).map(r => r.equipment))
    expect([...bars].every(e => e.includes('barbell'))).toBe(true)
  })

  it('finds nothing rather than everything for a query that matches nothing', () => {
    expect(searchExercises(state(), { query: 'xyzzy quux nonsense' })).toEqual([])
  })

  it('includes the user’s own exercises', () => {
    // registerCustom mutates the global id index, which persist() calls on every save.
    const custom = { id: 'c-mine', n: 'my machine row', bp: 'back', tg: 'upper back', eq: 'custom', custom: true }
    registerCustom([custom])
    try {
      const hit = searchExercises(state({ customEx: [custom] }), { query: 'my machine row' })
      expect(hit[0]?.id).toBe('c-mine')
    } finally {
      registerCustom([])
    }
  })
})

describe('getExercises', () => {
  it('resolves ids and says plainly when one does not exist', () => {
    const rows = getExercises(state(), { ids: ['0025', 'not-a-real-id'] })
    expect(rows[0].name).toBeTruthy()
    expect(rows[1]).toEqual({ id: 'not-a-real-id', name: null, missing: true })
  })

  it('survives being called with nothing', () => {
    expect(getExercises(state(), {})).toEqual([])
    expect(getExercises(state(), { ids: 'nope' })).toEqual([])
  })
})

describe('the declarations', () => {
  it('teaches the model our muscle vocabulary rather than letting it guess', () => {
    const search = EXERCISE_TOOLS.find(t => t.name === 'search_exercises')
    expect(search.schema.properties.muscle.enum).toEqual([...MUSCLES])
    // Equipment used to be described rather than enumerated, and the model wrote 'dumbbells'.
    expect(search.schema.properties.equipment.enum).toContain('dumbbell')
    expect(search.schema.properties.equipment.enum).toContain('leverage machine')
    expect(search.description).toContain('gluteal')
    expect(search.description).toContain('ids you invent are dropped')
  })

  it('uses only the schema subset every provider accepts', () => {
    // A richer schema works on two providers and 400s on the third, which is the worst way to
    // find out. Allowed: type, description, enum, items, properties, required, additionalProperties.
    const allowed = new Set(['type', 'description', 'enum', 'items', 'properties', 'required', 'additionalProperties'])
    const walk = node => {
      if (!node || typeof node !== 'object') return
      for (const key of Object.keys(node)) {
        expect(allowed.has(key), `unsupported schema key: ${key}`).toBe(true)
      }
      Object.values(node.properties || {}).forEach(walk)
      if (node.items) walk(node.items)
    }
    EXERCISE_TOOLS.forEach(t => walk(t.schema))
  })
})

describe('resolveEquipment', () => {
  // This was an exact string match, and it made the tool a trap: every plausible wording a model
  // writes matched nothing, so the search came back empty, it rephrased, and the whole step
  // budget went on searches that could never have succeeded.
  it('accepts the wordings a model actually writes', () => {
    expect(resolveEquipment('dumbbells')).toEqual(['dumbbell'])
    expect(resolveEquipment('Dumbbell')).toEqual(['dumbbell'])
    expect(resolveEquipment('cables')).toEqual(['cable'])
    expect(resolveEquipment('cable machine')).toEqual(['cable'])
    expect(resolveEquipment('bodyweight')).toEqual(['body weight'])
  })

  it('reads a broad word as every kind it could mean', () => {
    const machines = resolveEquipment('machine')
    expect(machines).toContain('leverage machine')
    expect(machines).toContain('smith machine')
    const bars = resolveEquipment('barbells')
    expect(bars).toContain('barbell')
    expect(bars).toContain('ez barbell')
  })

  it('gives up rather than matching nothing', () => {
    // null means "not a filter", which is what stops an unrecognisable word from guaranteeing an
    // empty result.
    expect(resolveEquipment('teleporter')).toBe(null)
    expect(resolveEquipment('')).toBe(null)
    expect(resolveEquipment(undefined)).toBe(null)
  })

  it('an unrecognisable word never empties the search', () => {
    const S = state()
    expect(searchExercises(S, { muscle: 'chest', equipment: 'teleporter' }).length).toBe(SEARCH_CAP)
    expect(searchExercises(S, { muscle: 'chest', equipment: 'dumbbells' }).length).toBeGreaterThan(0)
  })
})

describe('exerciseToolbox', () => {
  it('binds the state so run() can call the tools with just their input', () => {
    const box = exerciseToolbox(state())
    expect(box.search_exercises({ query: 'bench press' }).results[0].id).toBeTruthy()
    expect(box.get_exercises({ ids: ['0025'] })[0].id).toBe('0025')
    expect(box.search_exercises().results).toHaveLength(SEARCH_CAP)
  })

  it('says why a search found nothing, instead of just saying nothing', () => {
    // A bare empty array tells the model only that it failed, so it rephrases and fails again
    // until the run is out of steps. A reason it can act on ends that in one turn.
    const box = exerciseToolbox(state())
    expect(box.search_exercises({ query: 'xyzzy quux' }).note).toContain('no exercise matches')
    expect(box.search_exercises({ body_part: 'peito' }).note).toContain('not a body part')
    expect(box.search_exercises({ muscle: 'peitoral', query: 'zzz' }).note).toBeTruthy()
    expect(box.search_exercises({ equipment: 'teleporter', query: 'zzz' }).note).toContain('not equipment')
  })

  it('blames the equipment profile when that is what emptied it', () => {
    const S = state({
      equipFilterOn: true, activeEquipId: 'e1',
      equipProfiles: [{ id: 'e1', name: 'Home', equipment: ['band'] }]
    })
    const r = exerciseToolbox(S).search_exercises({ query: 'barbell squat' })
    expect(r.count).toBe(0)
    expect(r.note).toContain('equipment profile')
  })

  it('carries no note when it found something', () => {
    const r = exerciseToolbox(state()).search_exercises({ muscle: 'chest' })
    expect(r.count).toBeGreaterThan(0)
    expect(r.note).toBeUndefined()
  })
})
