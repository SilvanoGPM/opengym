// @vitest-environment happy-dom
// useUI pulls in api.js, which reads navigator.userAgent at module scope.
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { useUI } from './useUI.js'
import { useStore } from './useStore.js'

// "Off" has to hold at the timer itself, not at the four places that start one — the same
// reason the rest-after-a-set rule is a shared condition rather than four copies.
describe('rest timer set to Off', () => {
  beforeEach(() => { vi.useFakeTimers(); useUI.setState({ timer: null }) })
  afterEach(() => { useUI.getState().stopRest(); vi.useRealTimers() })

  it('starts nothing', () => {
    useUI.getState().startRest(0)
    expect(useUI.getState().timer).toBe(null)
  })

  it('stops a rest that is already running', () => {
    useUI.getState().startRest(90)
    expect(useUI.getState().timer).not.toBe(null)
    useUI.getState().startRest(0)
    expect(useUI.getState().timer).toBe(null)
  })

  it('still runs for a real duration', () => {
    useUI.getState().startRest(90)
    expect(useUI.getState().timer.total).toBe(90)
  })
})

// Same reasoning one level up: a session being filled in for a day that has already happened
// has nothing left to rest for, so the rule holds at the timer rather than at its four callers.
describe('rest timer during a backdated session', () => {
  const setActive = active => useStore.setState({ S: { ...useStore.getState().S, active } })

  beforeEach(() => { vi.useFakeTimers(); useUI.setState({ timer: null }) })
  afterEach(() => { useUI.getState().stopRest(); setActive(null); vi.useRealTimers() })

  it('starts no rest while a past day is being logged', () => {
    setActive({ id: 'a1', d: '2026-01-05', back: true, entries: [] })
    useUI.getState().startRest(90)
    expect(useUI.getState().timer).toBe(null)
  })

  it('still rests during a live session', () => {
    setActive({ id: 'a1', d: '2026-01-05', entries: [] })
    useUI.getState().startRest(90)
    expect(useUI.getState().timer.total).toBe(90)
  })
})
