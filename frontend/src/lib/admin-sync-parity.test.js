// The admin panel writes into a user's state on the server (api/server.js, writeStateAsAdmin), and
// the user's own device may still owe a change made before it saw that write. That device pushes
// on an old revision, gets the 409 and merges its copy with the server's — mergeStates, here. The
// union it takes would carry back everything the admin removed, unless the write was stamped the
// way "Reset everything" stamps a reset. The stamp is computed on the server (api/state-merge.js
// stampRemoval) from names it duplicates out of this file's sync-merge.js, so the two are run
// against each other here, the way coach-parity.test.js does for the Coach payload.
import { describe, it, expect } from 'vitest'
import { mergeStates } from './sync-merge.js'
import { stampRemoval, mergeState, replaceState } from '../../../api/state-merge.js'

const w = (id, d, over = {}) => ({ id, d, name: 'Push', start: Date.parse(d + 'T18:00:00Z'), end: Date.parse(d + 'T19:00:00Z'), entries: [], ...over })
const clone = v => JSON.parse(JSON.stringify(v))

// What the server held, and the phone's copy of it plus a workout it logged and has not sent.
const server = () => ({
  unit: 'kg', _ts: 1000, theme: 'dark',
  workouts: [w('a', '2026-01-05'), w('b', '2026-01-12')],
  routines: [{ id: 'r1', name: 'Push', ex: [] }, { id: 'r2', name: 'Pull', ex: [] }],
  bodyweight: [{ d: '2026-01-05', w: 80, t: 1 }],
  exNotes: { '0025': 'elbows in' },
})
const phone = () => {
  const S = clone(server())
  S.workouts.push(w('c', '2026-01-19'))
  S.bodyweight.push({ d: '2026-01-19', w: 79, t: 5 })
  S._ts = 5000
  return S
}

describe('an admin write meets a device that still owes a change', () => {
  it('a deleted workout stays deleted, and what the device logged meanwhile is kept', () => {
    const cur = server()
    const next = stampRemoval(cur, { ...clone(cur), workouts: [w('a', '2026-01-05')], _ts: 3000 }, 3000)
    const merged = mergeStates(phone(), next)
    expect(merged.workouts.map(x => x.id)).toEqual(['a', 'c'])
    expect(merged.bodyweight.map(e => e.d)).toEqual(['2026-01-05', '2026-01-19'])
    expect(merged.resetAt).toBe(3000)
  })

  it('without the stamp the union would have brought it back — which is why it exists', () => {
    const cur = server()
    const unstamped = { ...clone(cur), workouts: [w('a', '2026-01-05')], _ts: 3000 }
    expect(mergeStates(phone(), unstamped).workouts.map(x => x.id)).toEqual(['a', 'b', 'c'])
  })

  it('a replace removes routines, weigh-ins and notes the backup did not have', () => {
    const cur = server()
    const backup = { unit: 'kg', theme: 'light', workouts: [w('a', '2026-01-05')], routines: [{ id: 'r1', name: 'Push', ex: [] }], bodyweight: [] }
    const { state } = replaceState(backup, { ts: 3000 })
    stampRemoval(cur, state, 3000)
    const merged = mergeStates(phone(), state)
    expect(merged.routines.map(r => r.id)).toEqual(['r1'])
    expect(merged.workouts.map(x => x.id)).toEqual(['a', 'c'])
    expect(merged.bodyweight.map(e => e.d)).toEqual(['2026-01-19'])
    expect(merged.exNotes).toEqual({})
    expect(merged.theme).toBe('light')          // the restored copy decides the settings
  })

  it('a merge needs no stamp: the union keeps what it added', () => {
    const cur = server()
    const { state } = mergeState(cur, { workouts: [w('m', '2025-12-01')] }, { ts: 3000 })
    const merged = mergeStates(phone(), state)
    expect(merged.workouts.map(x => x.id)).toEqual(['m', 'a', 'b', 'c'])
    expect(merged.resetAt).toBeUndefined()
  })

  it('names a workout without an id the way the device does', () => {
    const cur = { ...server(), workouts: [w('a', '2026-01-05'), { d: '2026-01-12', start: 42, entries: [] }] }
    const next = stampRemoval(cur, { ...clone(cur), workouts: [w('a', '2026-01-05')] }, 3000)
    const device = { ...clone(cur), _ts: 5000 }
    expect(mergeStates(device, next).workouts.map(x => x.id)).toEqual(['a'])
  })
})
