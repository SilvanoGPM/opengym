// @vitest-environment happy-dom
// Signing out clears what you logged. It must not also reset how the app looks and reads: those
// are choices about this browser, and the sign-in screen — the one screen that only ever renders
// in this state — is where losing them shows.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/api.js', () => ({ api: vi.fn(() => Promise.resolve({})), webauthnOK: () => false }))
vi.mock('./useUI.js', () => ({ useUI: { getState: () => ({ toast: vi.fn() }) } }))

import { effectiveLang } from '../lib/default-lang.js'
import { useStore, DEF } from './useStore.js'

const clone = v => JSON.parse(JSON.stringify(v))
const shown = () => { const { S, config } = useStore.getState(); return effectiveLang(S, config, ['en-US']) }

describe('signing out', () => {
  beforeEach(() => {
    localStorage.clear()
    const S = clone(DEF)
    S.lang = 'pt-BR'
    S.langAuto = false
    S.theme = 'light'
    S.accent = 'violet'
    S.unit = 'lb'
    S.workouts = [{ id: 'w1', d: '2026-08-11', entries: [], prs: [], vol: 0, start: 0, end: 0 }]
    S.routines = [{ id: 'r1', name: 'Push', ex: [] }]
    useStore.setState({ S, user: { id: 'u1', name: 'Ana' }, config: null })
  })
  afterEach(() => { localStorage.clear(); useStore.setState({ S: clone(DEF), user: null, config: null }) })

  it('keeps the language, theme and accent', async () => {
    await useStore.getState().signOut({ force: true })
    const S = useStore.getState().S
    expect(S.lang).toBe('pt-BR')
    expect(S.theme).toBe('light')
    expect(S.accent).toBe('violet')
  })

  it('keeps a picked language over the instance default', async () => {
    // DEFAULT_LANG is for a device nobody has chosen a language on; this one has.
    await useStore.getState().signOut({ force: true })
    useStore.setState({ config: { default_lang: 'de' } })
    expect(useStore.getState().S.langAuto).toBe(false)
    expect(shown()).toBe('pt-BR')
  })

  it('leaves a language that was never picked following the instance default', async () => {
    useStore.setState({ S: { ...useStore.getState().S, langAuto: true } })
    await useStore.getState().signOut({ force: true })
    useStore.setState({ config: { default_lang: 'de' } })
    expect(useStore.getState().S.langAuto).toBe(true)
    expect(shown()).toBe('de')
  })

  it('still clears the training data and the session', async () => {
    await useStore.getState().signOut({ force: true })
    const S = useStore.getState().S
    expect(S.workouts).toEqual([])
    expect(S.routines).toEqual([])
    expect(S.unit).toBe(DEF.unit)          // account data, restored by the next pull
    expect(useStore.getState().user).toBe(null)
    expect(localStorage.getItem('gym_guest')).toBe(null)
  })
})
