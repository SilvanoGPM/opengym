// @vitest-environment happy-dom
// The startup path, not the readers: i18n-core.test.js covers what `t` does with a dictionary,
// this covers WHEN the dictionary arrives. Lives here rather than in core because setLang is the
// Vite half — import.meta.glob over the packs — and the whole point of these assertions is which
// of those packs the interface is made to wait for.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setLang, t, getLang, instrFor, exerciseNameFor } from './i18n.js'
import { _setLangState } from './i18n-core.js'

// Real ids out of the generated packs, so this breaks if a pack stops covering them.
const EX = { id: '1000', n: 'banded reverse calf raise', st: ['Stand with your feet hip-width apart.'] }

// Long enough for a content pack to have landed if it were going to — used where the assertion
// is that one did NOT arrive, or did not win.
const settle = () => new Promise(resolve => setTimeout(resolve, 200))

describe('setLang', () => {
  beforeEach(() => _setLangState('en', {}, null, null))
  afterEach(() => _setLangState('en', {}, null, null))

  it('has the interface translated the moment it resolves', async () => {
    await setLang('pt-BR')
    expect(getLang()).toBe('pt-BR')
    expect(t('Save')).toBe('Salvar')
  })

  it('does not make the interface wait for the content packs', async () => {
    // This is the fix. The instruction pack is 660 kB against the UI pack's 30 kB, and none of it
    // is on screen at startup — waiting for it left every button in English for as long as it
    // took to arrive. Resolving with the UI translated is what that looks like from here; the
    // first load of a language is the only one that has to wait (see the toggle test below).
    await setLang('hi')
    expect(t('Save')).not.toBe('Save')
    expect(instrFor(EX)).toEqual(EX.st)
  })

  it('brings the content packs in afterwards', async () => {
    await setLang('pt-BR')
    await vi.waitFor(() => expect(instrFor(EX)).not.toEqual(EX.st))
    expect(instrFor(EX)[0]).toContain('pé')
    expect(exerciseNameFor(EX)).toContain('panturrilha')
  })

  it('keeps the content packs through a toggle of the English-name switches', async () => {
    // Settings → "show the English name" re-runs setLang for the same language. The packs are
    // already here; dropping back to English instructions while they are fetched again is a flash
    // of its own.
    await setLang('pt-BR')
    await vi.waitFor(() => expect(instrFor(EX)).not.toEqual(EX.st))
    await setLang('pt-BR', false)
    expect(instrFor(EX)[0]).toContain('pé')
  })

  it('needs no packs at all for English', async () => {
    await setLang('pt-BR')
    await vi.waitFor(() => expect(instrFor(EX)).not.toEqual(EX.st))
    await setLang('en')
    expect(getLang()).toBe('en')
    expect(t('Save')).toBe('Save')
    expect(instrFor(EX)).toEqual(EX.st)
    expect(exerciseNameFor(EX)).toBe(EX.n)
  })

  it('falls back to English for a language it does not have', async () => {
    await setLang('xx')
    expect(getLang()).toBe('en')
    expect(t('Save')).toBe('Save')
  })

  it('loads a UI pack for a language with no content packs', async () => {
    // pt has neither instructions nor translated names; it must still translate the interface,
    // and must not be left waiting on packs that do not exist.
    await setLang('pt')
    expect(t('Save')).toBe('Guardar')
    expect(instrFor(EX)).toEqual(EX.st)
  })

  it('derives a locale from its base pack', async () => {
    await setLang('de-CH')
    expect(getLang()).toBe('de-CH')
    expect(t('Just close')).toBe('Nur schliessen')
  })

  it('lets a language switched to mid-load win over a late pack', async () => {
    // The content packs are big enough to change your mind in. Whichever language is current when
    // they land is the one that counts — a stale megabyte must not reinstate itself.
    setLang('ru')
    await setLang('pt')
    await settle()
    expect(getLang()).toBe('pt')
    expect(t('Save')).toBe('Guardar')
    expect(instrFor(EX)).toEqual(EX.st)
  })
})
