// @vitest-environment happy-dom
// Deliberately the real store rather than a mock: `update` deep-clones S, so a screen that held
// on to the record it was handed would go stale the moment it saved. That is the failure this
// file exists to catch, and a mocked store that mutates in place cannot see it.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WorkoutEdit from './WorkoutEdit.jsx'
import { DEF, useStore } from '../store/useStore.js'
import { EXDB } from '../lib/exercises.js'

vi.mock('../lib/sound.js', () => ({ beep: vi.fn(), vibrate: vi.fn() }))
vi.mock('../lib/api.js', () => ({ api: vi.fn(() => Promise.resolve({})) }))

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const clone = value => JSON.parse(JSON.stringify(value))
const LIFT = EXDB.find(e => e.bp !== 'cardio' && e.bp !== 'upper legs').id

let root
let container

// Key order matters here: it is the order buildCompletedWorkout writes, and the byte-for-byte
// round-trip test below is only meaningful against a record shaped the way a real finish leaves it.
const stored = () => ({
  id: 'w1', d: '2026-08-11', start: 1000, end: 1000 + 45 * 60000,
  routineId: null, name: 'Push', bw: 80,
  entries: [{
    id: LIFT,
    sets: [{ w: 60, r: 5, done: true }, { w: 60, r: 5, done: true }],
    topW: 60,
    target: { sets: 2, reps: 5, weight: 60 },
  }],
  prs: [LIFT],
  vol: 600,
})

function render(workout = stored(), rest = []) {
  const S = clone(DEF)
  S.workouts = [...rest, clone(workout)]
  S.exWeights = { [LIFT]: { w: 60, d: workout.d } }
  useStore.setState({ S, user: null })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root.render(
    <MemoryRouter initialEntries={['/history/w/' + workout.id]}>
      <Routes><Route path="/history/w/:id" element={<WorkoutEdit />} /></Routes>
    </MemoryRouter>,
  ))
}

const rec = () => useStore.getState().S.workouts.find(w => w.id === 'w1')
const byText = text => [...container.querySelectorAll('button')].find(b => b.textContent.includes(text))
const click = el => act(() => { el.dispatchEvent(new window.Event('click', { bubbles: true })) })
const checkboxes = () => [...container.querySelectorAll('[role="checkbox"]')]
// The weight steppers: each set row carries a "Decrease"/"Increase" pair per column.
const decrease = i => [...container.querySelectorAll('.setrow .stp.w button[aria-label="Decrease"]')][i]

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
})

describe('editing a logged workout', () => {
  it('shows the stored sets', () => {
    render()
    expect(checkboxes()).toHaveLength(2)
    expect(container.textContent).toContain('Push')
  })

  it('saving an untouched record leaves it byte for byte', () => {
    // The strongest net under normalizeEditedWorkout: a round trip must not quietly rewrite
    // vol, prs, topW, the target or the muscle snapshot.
    render()
    const before = JSON.stringify(rec())
    click(byText('Save'))
    expect(JSON.stringify(rec())).toBe(before)
  })

  it('writes an edited weight through to the store', () => {
    render()
    click(decrease(0))
    click(byText('Save'))
    expect(rec().entries[0].sets[0].w).toBe(57.5)
  })

  it('recomputes the volume of the record it saved', () => {
    render()
    click(decrease(0))
    click(byText('Save'))
    // Weight cascades to the later unfinished sets only, so set 2 keeps its 60.
    expect(rec().vol).toBe(57.5 * 5 + 60 * 5)
  })

  it('brings the working-weight suggestion down with the correction', () => {
    // The headline case. exWeights never decreases on its own — nextExWeight is non-decreasing —
    // so without the rescan a mistyped weight would seed every future session forever.
    render()
    click(decrease(0))
    click(decrease(1))
    click(byText('Save'))
    expect(rec().entries[0].sets.map(s => s.w)).toEqual([57.5, 57.5])
    expect(useStore.getState().S.exWeights[LIFT].w).toBe(57.5)
    // topW is clamped with them: it is the fallback bestWeightForEntry reads for legacy entries.
    expect(rec().entries[0].topW).toBe(57.5)
  })

  it('does not touch the record when the edit is discarded', () => {
    render()
    const before = JSON.stringify(rec())
    click(decrease(0))
    click(byText('Cancel'))                       // opens the confirm; the record is untouched either way
    expect(JSON.stringify(rec())).toBe(before)
  })

  it('moves only `end` when the duration changes', () => {
    render()
    const before = rec()
    const inc = container.querySelector('.card .stp button[aria-label="Increase"]')
    click(inc)
    click(byText('Save'))
    expect(rec().start).toBe(before.start)
    expect(rec().d).toBe(before.d)
    expect(rec().end).toBe(before.start + 50 * 60000)
  })

  it('drops an exercise whose sets were all unchecked, and nothing else', () => {
    const w = stored()
    w.entries.push({ id: EXDB.find(e => e.id !== LIFT && e.bp !== 'cardio').id, sets: [{ w: 40, r: 8, done: true }], topW: 40, target: { sets: 1, reps: 8 } })
    render(w)
    checkboxes().slice(0, 2).forEach(click)       // uncheck both sets of the first exercise
    click(byText('Save'))
    expect(rec().entries).toHaveLength(1)
    expect(rec().entries[0].id).not.toBe(LIFT)
  })

  it('leaves the other workouts in the history alone', () => {
    const earlier = { ...stored(), id: 'w0', d: '2026-08-04', prs: [LIFT], vol: 500 }
    render(stored(), [earlier])
    const before = JSON.stringify(useStore.getState().S.workouts[0])
    click(decrease(0))
    click(byText('Save'))
    expect(JSON.stringify(useStore.getState().S.workouts[0])).toBe(before)
    expect(useStore.getState().S.workouts.map(w => w.id)).toEqual(['w0', 'w1'])
  })
})
