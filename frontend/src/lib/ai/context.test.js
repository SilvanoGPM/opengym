import { describe, expect, it } from 'vitest'
import { buildDemoState } from '../demoSeed.js'
import { workoutContext, profileContext, prContext, recentWorkouts, renderWorkout } from './context.js'
import { workoutVolume } from '../history.js'

// A bare state literal rather than DEF from the store: importing useStore.js pulls in a module
// that registers a visibilitychange listener at load, and these tests run without a document.
const state = extra => ({
  unit: 'kg', workouts: [], bodyweight: [], targetW: null, routines: [],
  equipProfiles: [], activeEquipId: null, equipFilterOn: false, ...extra
})

// 0043 barbell full squat, 0025 bench press, 3220 is cardio, 0001 is body weight.
const workout = entries => ({
  id: 'w1', d: '2026-08-20', start: 1000, end: 1000 + 45 * 60000,
  routineId: 'r1', name: 'Leg Day', bw: 80, prs: [], entries
})

describe('workoutContext', () => {
  it('reports the same volume the rest of the app does', () => {
    const S = buildDemoState()
    for (const w of S.workouts.slice(-5)) {
      expect(workoutContext(S, w).volume).toBeCloseTo(Math.round(workoutVolume(w) * 10) / 10, 5)
    }
  })

  it('finds a session by id as well as by object', () => {
    const S = buildDemoState()
    const w = S.workouts[S.workouts.length - 1]
    expect(workoutContext(S, w.id).date).toBe(w.d)
    expect(workoutContext(S, 'nope')).toBe(null)
  })

  it('leaves warm-ups out of the volume and counts them separately', () => {
    // Every other part of the app excludes warm-ups from volume, and the config sheet says so in
    // as many words. A context that included them would have the AI judging a number that no
    // screen in the app agrees with.
    const S = state()
    const w = workout([{
      id: '0043',
      sets: [
        { w: 40, r: 5, done: true, phase: 'warmup' },
        { w: 60, r: 5, done: true, phase: 'warmup' },
        { w: 100, r: 5, done: true },
        { w: 100, r: 5, done: true }
      ]
    }])
    const ctx = workoutContext(S, w)
    expect(ctx.volume).toBe(1000)
    expect(ctx.exercises[0].warmups).toBe(2)
    expect(ctx.exercises[0].sets).toEqual(['100×5', '100×5'])
    expect(ctx.sets_done).toBe(2)
  })

  it('counts a drop-set once and does not double-count a rest-pause', () => {
    // The two shapes mean opposite things: drops are extra work on top of the row, clusters are
    // a breakdown of the row's own reps. Adding both would count the rest-pause twice.
    const S = state()
    const w = workout([
      { id: '0043', sets: [{ type: 'dropset', w: 100, r: 5, done: true, drops: [{ w: 80, r: 5 }] }] },
      { id: '0025', sets: [{ type: 'restpause', w: 60, r: 12, done: true, clusters: [{ r: 6 }, { r: 3 }, { r: 2 }, { r: 1 }] }] }
    ])
    expect(workoutContext(S, w).volume).toBe(500 + 400 + 720)
  })

  it('never presents a set that was not done as if it had been', () => {
    const S = state()
    const w = workout([{
      id: '0043',
      sets: [{ w: 100, r: 5, done: true }, { w: 100, r: 5, done: false }]
    }])
    const ctx = workoutContext(S, w)
    expect(ctx.exercises[0].sets).toEqual(['100×5'])
    expect(ctx.exercises[0].missed).toBe(1)
    expect(ctx.sets_missed).toBe(1)
    expect(renderWorkout(ctx)).not.toContain('100×5, 100×5')
  })

  it('reads a cardio target as minutes, not as reps', () => {
    // The config sheet saves a cardio target as { sets, min, speed } with no id and no mode, so
    // modeOf() only gets it right when the id is spread back in. Without that a 20-minute row
    // renders as a 20-rep one and nothing complains.
    const S = state()
    const w = workout([{
      id: '3220',
      target: { sets: 1, min: 20, speed: 8 },
      sets: [{ min: 20, speed: 8, done: true }]
    }])
    const ctx = workoutContext(S, w)
    expect(ctx.exercises[0].mode).toBe('cardio')
    expect(ctx.exercises[0].sets[0]).toContain('min')
    expect(ctx.exercises[0].planned).toContain('20 min')
  })

  it('renders a body-weight set as what was done, not as 0 by n', () => {
    const S = state()
    const w = workout([{ id: '0001', sets: [{ w: 0, r: 12, done: true }] }])
    expect(workoutContext(S, w).exercises[0].sets).toEqual(['12'])
  })

  it('survives an exercise that is no longer in the library', () => {
    const S = state()
    const w = workout([{ id: 'c-deleted-custom', sets: [{ w: 20, r: 10, done: true }] }])
    const ctx = workoutContext(S, w)
    expect(ctx.exercises[0].name).toBe('Unknown exercise')
    expect(ctx.volume).toBe(200)
  })

  it('carries the session note and the PRs through', () => {
    const S = state()
    const w = {
      ...workout([{ id: '0043', sets: [{ w: 100, r: 5, done: true }] }]),
      prs: ['0043'], note: 'back felt fine'
    }
    const ctx = workoutContext(S, w)
    expect(ctx.note).toBe('back felt fine')
    expect(ctx.prs).toEqual(['barbell full squat'])
  })
})

describe('renderWorkout', () => {
  it('stays small enough that nobody notices the bill', () => {
    // Silent growth in what gets sent is silent growth in what every call costs. The whole point
    // of the exercise-search tool is that the catalogue never lands in a prompt; this is the
    // guard rail saying the session summary did not quietly become one either.
    const S = buildDemoState()
    const biggest = S.workouts.reduce((a, b) => (b.entries.length > a.entries.length ? b : a))
    const text = renderWorkout(workoutContext(S, biggest))
    expect(text.length).toBeGreaterThan(100)
    expect(text.length).toBeLessThan(4000)
  })

  it('says out loud that volume excludes warm-ups', () => {
    const S = buildDemoState()
    expect(renderWorkout(workoutContext(S, S.workouts[0]))).toContain('warm-ups excluded')
  })

  it('is empty rather than broken for a missing session', () => {
    expect(renderWorkout(null)).toBe('')
  })
})

describe('profileContext', () => {
  it('ranks what has been trained and names what has not', () => {
    const S = buildDemoState()
    const ctx = profileContext(S, { weeks: 8, now: new Date('2026-08-29T12:00:00Z') })
    expect(ctx.sessions).toBeGreaterThan(0)
    expect(ctx.trained).toContain('Quads')
    expect(ctx.unit).toBe('kg')
  })

  it('does not reorder the workout history it reads', () => {
    // S.workouts is oldest-first and that order is load-bearing: insertWorkout, stallCount and
    // lastEntryFor all read "most recent" as "last in the array".
    const S = buildDemoState()
    const before = S.workouts.map(w => w.id)
    recentWorkouts(S, 8, new Date('2026-08-29T12:00:00Z'))
    profileContext(S, { now: new Date('2026-08-29T12:00:00Z') })
    expect(S.workouts.map(w => w.id)).toEqual(before)
  })

  it('says everything is available when no equipment profile is set', () => {
    expect(profileContext(state()).equipment).toBe(null)
  })

  it('reports the active equipment profile when there is one', () => {
    const S = state({
      equipFilterOn: true,
      activeEquipId: 'eq1',
      equipProfiles: [{ id: 'eq1', name: 'Home', equipment: ['dumbbell', 'band'] }]
    })
    expect(profileContext(S).equipment).toEqual({ name: 'Home', has: ['dumbbell', 'band'] })
  })
})

describe('prContext', () => {
  it('lists best estimated 1RMs, biggest first', () => {
    const rows = prContext(buildDemoState(), 5)
    expect(rows.length).toBe(5)
    expect(rows[0].est_1rm).toBeGreaterThanOrEqual(rows[4].est_1rm)
    expect(rows.every(r => r.name && r.name !== 'Unknown exercise')).toBe(true)
  })

  it('is empty for a profile with no history', () => {
    expect(prContext(state())).toEqual([])
  })
})
