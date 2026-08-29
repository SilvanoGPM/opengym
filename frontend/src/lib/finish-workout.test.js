import { describe, expect, it } from 'vitest'
import { buildCompletedWorkout, backdatedStart, insertWorkout, nextExWeight } from './finish-workout.js'
import { durPart, isoOf } from './format.js'
import { nextPrescription, sessionsFor, stallCount } from './progression.js'
import { lastEntryFor } from './history.js'
import { EXDB } from './exercises.js'

describe('completed workout boundary', () => {
  it('builds the same legacy-shaped record doFinishWorkout stores and keeps it visible', () => {
    const active = {
      id: 'active-1', d: '2026-08-08', start: 1000, routineId: 'routine-1', name: 'Push', bw: 80,
      entries: [{ id: '0025', sets: [{ done: true, w: 60, r: 8 }], topW: 60, target: { sets: 1, reps: 8 } }],
    }
    const completed = buildCompletedWorkout(active, { end: 2000, prs: [] })
    expect(completed).toEqual({
      id: 'active-1', d: '2026-08-08', start: 1000, end: 2000, routineId: 'routine-1', name: 'Push', bw: 80,
      entries: [{ id: '0025', sets: [{ done: true, w: 60, r: 8 }], topW: 60, target: { sets: 1, reps: 8 } }],
      prs: []
    })
  })

  it('persists a muscle snapshot only when the caller supplies one', () => {
    const active = {
      id: 'active-1', d: '2026-08-08', start: 1000,
      entries: [
        { id: 'catalogue', sets: [{ done: true }] },
        { id: 'custom', sets: [{ done: true }] },
      ],
    }
    const completed = buildCompletedWorkout(active, {
      end: 2000,
      snapshotFor: entry => entry.id === 'custom'
        ? { n: 'Custom lift', muscleWeights: { chest: 1 } }
        : null,
    })

    expect(completed.entries[0]).not.toHaveProperty('muscleSnapshot')
    expect(completed.entries[1].muscleSnapshot).toEqual({
      n: 'Custom lift', muscleWeights: { chest: 1 },
    })
  })
})

// Notes written during a session have to survive it, or "write a note during your workout"
// means "write a note and lose it when you tap Finish".
describe('session notes', () => {
  const active = (entry) => ({
    id: 'w1', d: '2026-08-25', start: 1, routineId: 'r1', name: 'Push', bw: null,
    entries: [{ id: '0025', sets: [{ w: 100, r: 5, done: true }], ...entry }],
  })

  it('keeps a per-exercise note and its pin', () => {
    const w = buildCompletedWorkout(active({ note: '  narrower grip next time  ', notePin: true }))
    expect(w.entries[0].note).toBe('narrower grip next time')
    expect(w.entries[0].notePin).toBe(true)
  })

  it('keeps an unpinned note without inventing a pin', () => {
    const w = buildCompletedWorkout(active({ note: 'shoulder twinged' }))
    expect(w.entries[0].note).toBe('shoulder twinged')
    expect('notePin' in w.entries[0]).toBe(false)
  })

  it('writes no note fields at all when nothing was typed', () => {
    const w = buildCompletedWorkout(active({ note: '   ', notePin: true }))
    expect('note' in w.entries[0]).toBe(false)
    expect('notePin' in w.entries[0]).toBe(false)
  })

  it('keeps a whole-session note on the workout', () => {
    const a = active({})
    expect(buildCompletedWorkout({ ...a, note: 'slept badly' }).note).toBe('slept badly')
    expect('note' in buildCompletedWorkout(a)).toBe(false)
  })
})

describe('backdated sessions', () => {
  it('collapses the duration of a session filled in after the fact', () => {
    const active = { id: 'a1', d: '2026-08-08', start: 5000, back: true, entries: [{ id: '0025', sets: [{ done: true, w: 60, r: 8 }] }] }
    // `end` is what the clock said when Finish was tapped — days later. Keeping it would report
    // a three-day workout; durPart() leaves a zero-length one out entirely.
    const completed = buildCompletedWorkout(active, { end: 999999999, prs: [] })
    expect(completed.end).toBe(5000)
    expect(durPart(completed.end - completed.start)).toEqual([])
  })

  it('keeps the real clock on a live session', () => {
    const active = { id: 'a1', d: '2026-08-08', start: 5000, entries: [{ id: '0025', sets: [{ done: true, w: 60, r: 8 }] }] }
    expect(buildCompletedWorkout(active, { end: 3605000, prs: [] }).end).toBe(3605000)
  })

  it('never writes the back flag into the stored record', () => {
    const active = { id: 'a1', d: '2026-08-08', start: 5000, back: true, entries: [{ id: '0025', sets: [{ done: true }] }] }
    expect(buildCompletedWorkout(active, { end: 5000 })).not.toHaveProperty('back')
  })
})

describe('backdatedStart', () => {
  it('files the session at 18:00 local on the day it belongs to', () => {
    const at = new Date(backdatedStart('2026-08-25'))
    expect(at.getHours()).toBe(18)
    expect(at.getMinutes()).toBe(0)
  })

  it('lands on the given day in every timezone', () => {
    // The guard this exists for: new Date('2026-08-25') is UTC midnight, which is still the
    // 24th anywhere west of Greenwich — recovery.js and effort.js both fall back to it.
    for (const iso of ['2026-01-01', '2026-06-15', '2026-12-31']) {
      expect(isoOf(new Date(backdatedStart(iso)))).toBe(iso)
    }
  })

  it('agrees with the timestamp import-csv gives a row with no time column', () => {
    const iso = '2026-03-09'
    expect(backdatedStart(iso)).toBe(new Date(iso + 'T00:00:00').getTime() + 18 * 3600000)
  })
})

describe('insertWorkout', () => {
  const w = d => ({ id: 'w' + d, d })

  it('appends when the session is the newest — the everyday path', () => {
    const list = [w('2026-01-01'), w('2026-01-08')]
    expect(insertWorkout(list, w('2026-01-15')).map(x => x.d))
      .toEqual(['2026-01-01', '2026-01-08', '2026-01-15'])
  })

  it('does not mutate the history it was given', () => {
    const list = [w('2026-01-01'), w('2026-01-08')]
    insertWorkout(list, w('2026-01-04'))
    expect(list.map(x => x.d)).toEqual(['2026-01-01', '2026-01-08'])
  })

  it('drops a backdated session into its place in the middle', () => {
    const list = [w('2026-01-01'), w('2026-01-08'), w('2026-01-15')]
    expect(insertWorkout(list, w('2026-01-10')).map(x => x.d))
      .toEqual(['2026-01-01', '2026-01-08', '2026-01-10', '2026-01-15'])
  })

  it('puts a session older than everything at the front', () => {
    const list = [w('2026-01-08'), w('2026-01-15')]
    expect(insertWorkout(list, w('2025-12-30')).map(x => x.d))
      .toEqual(['2025-12-30', '2026-01-08', '2026-01-15'])
  })

  it('files a second session for a day after the ones already there', () => {
    // Two sessions in one day is allowed, and the one logged second is the later one.
    const list = [w('2026-01-08'), { id: 'morning', d: '2026-01-10' }, w('2026-01-15')]
    expect(insertWorkout(list, { id: 'evening', d: '2026-01-10' }).map(x => x.id))
      .toEqual(['w2026-01-08', 'morning', 'evening', 'w2026-01-15'])
  })

  it('starts a history that does not exist yet', () => {
    expect(insertWorkout(undefined, w('2026-01-01')).map(x => x.d)).toEqual(['2026-01-01'])
    expect(insertWorkout([], w('2026-01-01')).map(x => x.d)).toEqual(['2026-01-01'])
  })
})

describe('insertWorkout keeps the progression engine reading the right session', () => {
  // sessionsFor/stallCount and lastEntryFor all take "the most recent session" to be the last
  // element of S.workouts. Appending a backdated one would silently make a session from two
  // weeks ago the basis for the next prescription.
  const LIFT = EXDB.find(e => e.bp !== 'cardio').id
  const session = (d, weight, reps) => ({
    id: 'w' + d, d,
    entries: [{
      id: LIFT,
      target: { sets: 3, reps: 5, weight },
      sets: reps.map(r => ({ w: weight, r, done: true })),
    }],
  })
  const cfg = { id: LIFT, sets: 3, reps: 5, weight: 65 }
  const state = workouts => ({ unit: 'kg', workouts })

  const live = [session('2026-01-01', 60, [5, 5, 5]), session('2026-01-08', 65, [5, 5, 5])]
  const missed = session('2026-01-05', 40, [5, 5, 5])

  it('leaves the next prescription untouched when a missed day is filled in', () => {
    const before = nextPrescription(state(live), cfg)
    const after = nextPrescription(state(insertWorkout(live, missed)), cfg)
    expect(after).toEqual(before)
    expect(after.weight).not.toBe(40)
  })

  it('still reads the newest session as the last one', () => {
    const sessions = sessionsFor(state(insertWorkout(live, missed)), LIFT, cfg)
    expect(sessions.map(s => s.d)).toEqual(['2026-01-01', '2026-01-05', '2026-01-08'])
    expect(sessions[sessions.length - 1].weight).toBe(65)
  })

  it('does not count an old failed session as a current stall', () => {
    const failed = session('2026-01-05', 65, [5, 5, 2])
    expect(stallCount(sessionsFor(state(insertWorkout(live, failed)), LIFT, cfg))).toBe(0)
  })

  it('keeps "last time" pointing at the newest session', () => {
    expect(lastEntryFor(state(insertWorkout(live, missed)), LIFT).d).toBe('2026-01-08')
  })
})

describe('nextExWeight', () => {
  it('seeds a lift that has no suggestion yet', () => {
    expect(nextExWeight(undefined, { w: 60, d: '2026-01-08' })).toEqual({ w: 60, d: '2026-01-08' })
  })

  it('refuses to let a backdated session overwrite a newer suggestion', () => {
    // The whole point: logging a heavy Tuesday you forgot must not move the number Wednesday set.
    const cur = { w: 60, d: '2026-01-08' }
    expect(nextExWeight(cur, { w: 100, d: '2026-01-05' })).toBe(cur)
  })

  it('takes the heavier weight on the same day or later', () => {
    expect(nextExWeight({ w: 60, d: '2026-01-08' }, { w: 65, d: '2026-01-08' })).toEqual({ w: 65, d: '2026-01-08' })
    expect(nextExWeight({ w: 60, d: '2026-01-08' }, { w: 65, d: '2026-01-15' })).toEqual({ w: 65, d: '2026-01-15' })
  })

  it('keeps the current suggestion when a later session went lighter', () => {
    // Unchanged legacy behaviour: a deload does not drop the working weight you have proven.
    const cur = { w: 60, d: '2026-01-08' }
    expect(nextExWeight(cur, { w: 50, d: '2026-01-15' })).toBe(cur)
  })

  it('records nothing for a session with no load', () => {
    expect(nextExWeight(undefined, { w: 0, d: '2026-01-08' })).toBe(null)
    const cur = { w: 60, d: '2026-01-08' }
    expect(nextExWeight(cur, { w: 0, d: '2026-01-15' })).toBe(cur)
  })
})
