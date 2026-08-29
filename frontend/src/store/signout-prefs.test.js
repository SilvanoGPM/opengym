// @vitest-environment happy-dom
// Signing out clears what you logged. It must not also reset how the app looks and reads: those
// are choices about this browser, and the sign-in screen — the one screen that only ever renders
// in this state — is where losing them shows.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { DEF, useStore } from './useStore.js'

vi.mock('../lib/api.js', () => ({
  api: vi.fn(() => Promise.reject(new Error('offline'))),
  webauthnOK: () => false,
}))

const clone = value => JSON.parse(JSON.stringify(value))

describe('signing out', () => {
  beforeEach(() => {
    localStorage.clear()
    const S = clone(DEF)
    S.lang = 'pt-BR'
    S.theme = 'light'
    S.accent = 'violet'
    S.unit = 'lb'
    S.workouts = [{ id: 'w1', d: '2026-08-11', entries: [], prs: [], vol: 0, start: 0, end: 0 }]
    S.routines = [{ id: 'r1', name: 'Push', ex: [] }]
    useStore.setState({ S, user: { id: 'u1', name: 'Ana' } })
  })

  it('keeps the language, theme and accent', async () => {
    await useStore.getState().signOut()
    const S = useStore.getState().S
    expect(S.lang).toBe('pt-BR')
    expect(S.theme).toBe('light')
    expect(S.accent).toBe('violet')
  })

  it('still clears the training data and the session', async () => {
    await useStore.getState().signOut()
    const S = useStore.getState().S
    expect(S.workouts).toEqual([])
    expect(S.routines).toEqual([])
    expect(S.unit).toBe(DEF.unit)          // account data, restored by the next pull
    expect(useStore.getState().user).toBe(null)
    expect(localStorage.getItem('gym_guest')).toBe(null)
  })

  it('leaves the defaults alone for a profile that never chose', async () => {
    useStore.setState({ S: clone(DEF), user: { id: 'u1', name: 'Ana' } })
    await useStore.getState().signOut()
    const S = useStore.getState().S
    expect(S.lang).toBe(DEF.lang)
    expect(S.theme).toBe(DEF.theme)
    expect(S.accent).toBe(DEF.accent)
  })
})
