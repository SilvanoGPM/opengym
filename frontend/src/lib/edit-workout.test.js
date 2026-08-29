import { describe, it, expect } from 'vitest'
import {
  setSetField, appendSet, popSet, appendWarmup, dropSetAt,
  recomputeWorkoutPRs, rebuildExWeights, normalizeEditedWorkout, commitWorkoutEdit,
} from './edit-workout.js'
import { buildCompletedWorkout } from './finish-workout.js'
import { workoutVolume } from './history.js'
import { EXDB } from './exercises.js'

const LIFT = EXDB.find(e => e.bp !== 'cardio' && e.bp !== 'upper legs').id
const OTHER = EXDB.filter(e => e.bp !== 'cardio' && e.bp !== 'upper legs')[1].id

const entry = (over = {}) => ({
  id: LIFT,
  target: { sets: 3, reps: 5, weight: 60 },
  sets: [{ w: 60, r: 5, done: true }, { w: 60, r: 5, done: true }],
  topW: 60,
  ...over,
})
// A session as the history stores it, given as [weight, ...reps].
const session = (id, d, exId, weight, reps = [5, 5, 5]) => ({
  id, d,
  routineId: 'r1', name: 'Push', bw: null, start: 1000, end: 1000, prs: [], vol: 0,
  entries: [{ id: exId, target: { sets: 3, reps: 5, weight }, sets: reps.map(r => ({ w: weight, r, done: true })), topW: weight }],
})

describe('setSetField', () => {
  it('writes a field on the addressed set only', () => {
    const out = setSetField(entry(), 1, 'r', 8)
    expect(out.sets[1].r).toBe(8)
    expect(out.sets[0].r).toBe(5)
  })

  it('drops the key when cleared rather than storing null', () => {
    const out = setSetField(entry({ sets: [{ w: 60, r: 5, eff: 2, done: true }] }), 0, 'eff', null)
    expect('eff' in out.sets[0]).toBe(false)
  })

  it('cascades a weight to the later unfinished sets of the same phase', () => {
    const e = entry({ sets: [{ w: 60, r: 5, done: true }, { w: 60, r: 5, done: false }, { w: 60, r: 5, done: false }] })
    const out = setSetField(e, 0, 'w', 70)
    expect(out.sets.map(s => s.w)).toEqual([70, 70, 70])
  })

  it('does not mutate the entry it was given', () => {
    const e = entry()
    setSetField(e, 0, 'r', 99)
    expect(e.sets[0].r).toBe(5)
  })
})

describe('appendSet', () => {
  it('seeds from the last row', () => {
    const out = appendSet(entry({ sets: [{ w: 80, r: 3, done: true }] }))
    expect(out.sets).toHaveLength(2)
    expect(out.sets[1]).toEqual({ w: 80, r: 3, done: false })
  })

  it('survives an entry with no target at all', () => {
    // Imported history and anything logged before `target` existed store it as null. The active
    // session always has one, which is why reading it bare never failed on the workout screen.
    const legacy = { id: LIFT, target: null, sets: [], topW: null }
    expect(() => appendSet(legacy)).not.toThrow()
    expect(appendSet(legacy).sets[0]).toEqual({ w: 0, r: 10, done: false })
  })

  it('falls back to the target when there is no previous row', () => {
    const out = appendSet({ id: LIFT, target: { reps: 12 }, sets: [] })
    expect(out.sets[0]).toEqual({ w: 0, r: 12, done: false })
  })
})

describe('popSet / dropSetAt', () => {
  it('drops the last set but never the only one', () => {
    expect(popSet(entry()).sets).toHaveLength(1)
    expect(popSet(entry({ sets: [{ w: 60, r: 5, done: true }] })).sets).toHaveLength(1)
  })

  it('removes a row by position', () => {
    const e = entry({ sets: [{ w: 1, r: 1, done: true }, { w: 2, r: 2, done: true }, { w: 3, r: 3, done: true }] })
    expect(dropSetAt(e, 1).sets.map(s => s.w)).toEqual([1, 3])
  })
})

describe('appendWarmup', () => {
  it('marks the inserted row done when asked, and only that row', () => {
    // A warm-up added while filling in history happened; one added mid-session has not yet.
    const out = appendWarmup(entry(), 2.5, { done: true })
    expect(out.sets).toHaveLength(3)
    expect(out.sets[0].warmup).toBe(true)
    expect(out.sets[0].done).toBe(true)
    expect(out.sets.filter(s => s.warmup)).toHaveLength(1)
  })

  it('leaves it unchecked by default, the way a live session wants it', () => {
    expect(appendWarmup(entry(), 2.5).sets[0].done).toBe(false)
  })
})

describe('recomputeWorkoutPRs', () => {
  const a = session('wa', '2026-01-01', LIFT, 100)
  const b = session('wb', '2026-01-08', LIFT, 105)

  it('calls the first heavy session a record', () => {
    expect(recomputeWorkoutPRs([a], 'wa')).toEqual([LIFT])
  })

  it('judges against the sessions before it, not the whole history', () => {
    // `b` is heavier, but on the day `a` happened it did not exist yet.
    expect(recomputeWorkoutPRs([a, b], 'wa')).toEqual([LIFT])
    expect(recomputeWorkoutPRs([a, b], 'wb')).toEqual([LIFT])
  })

  it('drops the trophy when the session is corrected below what came before', () => {
    const lowered = { ...b, entries: [{ ...b.entries[0], sets: [{ w: 90, r: 5, done: true }], topW: 90 }] }
    expect(recomputeWorkoutPRs([a, lowered], 'wb')).toEqual([])
  })

  it('never counts a warm-up as a record', () => {
    const warm = session('wc', '2026-01-15', LIFT, 60)
    warm.entries[0].sets.push({ w: 200, r: 1, done: true, warmup: true, phase: 'warmup' })
    expect(recomputeWorkoutPRs([a, warm], 'wc')).toEqual([])
  })

  it('is a no-op for an id that is not in the history', () => {
    expect(recomputeWorkoutPRs([a], 'gone')).toEqual([])
  })
})

describe('rebuildExWeights', () => {
  it('lets a corrected weight come back down — the whole point', () => {
    // nextExWeight is non-decreasing, so a mistyped 100 would otherwise stand forever: seeding
    // future sessions and suppressing the "new record!" badge for every real PR under it.
    const fixed = session('wa', '2026-01-01', LIFT, 90)
    const out = rebuildExWeights([fixed], { [LIFT]: { w: 100, d: '2026-01-01' } }, [LIFT])
    expect(out[LIFT]).toEqual({ w: 90, d: '2026-01-01' })
  })

  it('keeps the heaviest across the whole history', () => {
    const out = rebuildExWeights(
      [session('wa', '2026-01-01', LIFT, 100), session('wb', '2026-01-08', LIFT, 90)], {}, [LIFT])
    expect(out[LIFT].w).toBe(100)
  })

  it('counts topW the way doFinishWorkout does', () => {
    const w = session('wa', '2026-01-01', LIFT, 60)
    w.entries[0].topW = 80
    expect(rebuildExWeights([w], {}, [LIFT])[LIFT].w).toBe(80)
  })

  it('leaves ids the edit did not touch byte for byte', () => {
    // Including an orphan with no workout behind it — mergeImport seeds those under a different
    // rule, and a global rescan would quietly rewrite them.
    const prev = { [OTHER]: { w: 55, d: '2025-12-01' }, orphan: { w: 20, d: '2025-01-01' } }
    const out = rebuildExWeights([session('wa', '2026-01-01', LIFT, 90)], prev, [LIFT])
    expect(out[OTHER]).toEqual(prev[OTHER])
    expect(out.orphan).toEqual(prev.orphan)
  })

  it('drops an id that no longer appears in any workout', () => {
    const out = rebuildExWeights([session('wa', '2026-01-01', OTHER, 50)], { [LIFT]: { w: 100, d: '2026-01-01' } }, [LIFT])
    expect(out[LIFT]).toBeUndefined()
  })
})

describe('normalizeEditedWorkout', () => {
  const original = {
    id: 'w1', d: '2026-01-05', start: 1000, end: 1000 + 45 * 60000,
    routineId: 'r1', name: 'Push', bw: 80, prs: [LIFT], vol: 900,
    entries: [{ ...entry(), _k: 'k0' }],
  }
  const draft = () => JSON.parse(JSON.stringify({ ...original, durMin: 45 }))

  it('produces the same shape buildCompletedWorkout does', () => {
    // An edited record has to be indistinguishable from a finished one, or every reader of the
    // history grows a special case for the difference.
    const finished = buildCompletedWorkout(
      { id: 'w1', d: '2026-01-05', start: 1000, routineId: 'r1', name: 'Push', bw: 80, entries: [entry()] },
      { end: 2000, prs: [] })
    const edited = normalizeEditedWorkout(draft(), original)
    expect(Object.keys(edited)).toEqual(Object.keys(finished))
    expect(Object.keys(edited.entries[0])).toEqual(Object.keys(finished.entries[0]))
  })

  it('rebuilds end from the edited duration and leaves start alone', () => {
    const out = normalizeEditedWorkout({ ...draft(), durMin: 90 }, original)
    expect(out.start).toBe(1000)
    expect(out.end).toBe(1000 + 90 * 60000)
  })

  it('collapses a zero duration so durPart omits it, like an imported session', () => {
    expect(normalizeEditedWorkout({ ...draft(), durMin: 0 }, original).end).toBe(1000)
  })

  it('drops an exercise whose sets were all unchecked', () => {
    const d = draft()
    d.entries[0].sets = d.entries[0].sets.map(s => ({ ...s, done: false }))
    expect(normalizeEditedWorkout(d, original).entries).toEqual([])
  })

  it('strips the draft-only keys', () => {
    const d = draft()
    d.entries[0].plan = { kind: 'up' }
    d.entries[0].sg = 1
    const out = normalizeEditedWorkout(d, original)
    expect('_k' in out.entries[0]).toBe(false)
    expect('plan' in out.entries[0]).toBe(false)
    expect('sg' in out.entries[0]).toBe(false)
    expect('durMin' in out).toBe(false)
  })

  it('carries a deleted custom exercise’s snapshot and name over verbatim', () => {
    // The only memory of an exercise that is no longer in the catalogue. Regenerating it would
    // look the id up and find nothing.
    const snap = { n: 'My lift', muscleWeights: { chest: 1 } }
    const orig = { ...original, entries: [{ ...entry({ id: 'gone-custom' }), _k: 'k0', n: 'My lift', muscleSnapshot: snap }] }
    const d = JSON.parse(JSON.stringify({ ...orig, durMin: 45 }))
    d.entries[0].sets[0].r = 8
    const out = normalizeEditedWorkout(d, orig, { snapshotFor: () => ({ muscleWeights: { back: 1 } }) })
    expect(out.entries[0].muscleSnapshot).toEqual(snap)
    expect(out.entries[0].n).toBe('My lift')
  })

  it('asks the caller for a snapshot only for an entry the editor added', () => {
    const d = draft()
    d.entries.push({ id: 'new-custom', target: { sets: 1, reps: 5 }, sets: [{ w: 40, r: 5, done: true }], topW: 40, _k: 'n1' })
    const out = normalizeEditedWorkout(d, original, { snapshotFor: e => (e.id === 'new-custom' ? { muscleWeights: { arms: 1 } } : null) })
    expect(out.entries[1].muscleSnapshot).toEqual({ muscleWeights: { arms: 1 } })
    expect(out.entries[0].muscleSnapshot).toBeUndefined()
  })

  it('never rewrites the target, even when the draft carries a different one', () => {
    const d = draft()
    d.entries[0].target = { sets: 9, reps: 1, weight: 999 }
    expect(normalizeEditedWorkout(d, original).entries[0].target).toEqual(original.entries[0].target)
  })

  it('keeps a null target null', () => {
    const orig = { ...original, entries: [{ ...entry({ target: null }), _k: 'k0' }] }
    const d = JSON.parse(JSON.stringify({ ...orig, durMin: 45 }))
    expect(normalizeEditedWorkout(d, orig).entries[0].target).toBe(null)
  })

  it('leaves topW alone when the sets did not change', () => {
    const orig = { ...original, entries: [{ ...entry({ topW: 100 }), _k: 'k0' }] }
    const d = JSON.parse(JSON.stringify({ ...orig, durMin: 45 }))
    expect(normalizeEditedWorkout(d, orig).entries[0].topW).toBe(100)
  })

  it('clamps a topW the edited sets no longer support', () => {
    const orig = { ...original, entries: [{ ...entry({ topW: 100 }), _k: 'k0' }] }
    const d = JSON.parse(JSON.stringify({ ...orig, durMin: 45 }))
    d.entries[0].sets = [{ w: 90, r: 5, done: true }]
    expect(normalizeEditedWorkout(d, orig).entries[0].topW).toBe(90)
  })

  it('trims the session note and drops it when emptied', () => {
    expect(normalizeEditedWorkout({ ...draft(), note: '  felt strong  ' }, original).note).toBe('felt strong')
    expect('note' in normalizeEditedWorkout({ ...draft(), note: '   ' }, original)).toBe(false)
  })
})

describe('commitWorkoutEdit', () => {
  const untouched = session('wa', '2026-01-01', OTHER, 50)
  const target = { ...session('wb', '2026-01-08', LIFT, 100), vol: 1500 }
  const state = () => JSON.parse(JSON.stringify({
    workouts: [untouched, target],
    exWeights: { [LIFT]: { w: 100, d: '2026-01-08' }, [OTHER]: { w: 50, d: '2026-01-01' } },
  }))

  it('keeps the record in its slot and leaves the others alone', () => {
    const s = state()
    const edited = { ...s.workouts[1], entries: [{ ...s.workouts[1].entries[0], sets: [{ w: 90, r: 5, done: true }], topW: 90 }] }
    const out = commitWorkoutEdit(s, edited)
    expect(out.workouts.map(w => w.id)).toEqual(['wa', 'wb'])
    expect(out.workouts[0]).toEqual(s.workouts[0])
  })

  it('recomputes the volume of the edited record', () => {
    const s = state()
    const edited = { ...s.workouts[1], entries: [{ ...s.workouts[1].entries[0], sets: [{ w: 90, r: 5, done: true }], topW: 90 }] }
    commitWorkoutEdit(s, edited)
    expect(edited.vol).toBe(workoutVolume(edited))
    expect(edited.vol).toBe(450)
  })

  it('brings the working-weight suggestion down with the correction', () => {
    const s = state()
    const edited = { ...s.workouts[1], entries: [{ ...s.workouts[1].entries[0], sets: [{ w: 90, r: 5, done: true }], topW: 90 }] }
    const out = commitWorkoutEdit(s, edited)
    expect(out.exWeights[LIFT]).toEqual({ w: 90, d: '2026-01-08' })
    expect(out.exWeights[OTHER]).toEqual(s.exWeights[OTHER])
  })

  it('rescans an exercise the edit removed as well as one it added', () => {
    const s = state()
    const edited = { ...s.workouts[1], entries: [{ id: OTHER, target: null, sets: [{ w: 70, r: 5, done: true }], topW: 70 }] }
    const out = commitWorkoutEdit(s, edited)
    expect(out.exWeights[LIFT]).toBeUndefined()      // no workout logs it any more
    expect(out.exWeights[OTHER].w).toBe(70)
  })

  it('is a no-op when the record was deleted underneath the editor', () => {
    const s = state()
    const out = commitWorkoutEdit(s, { id: 'gone', entries: [] })
    expect(out.workouts).toBe(s.workouts)
    expect(out.exWeights).toBe(s.exWeights)
  })
})
