// Browser-only shell of the i18n module. The runtime-agnostic state and readers live
// in i18n-core.js (plain Node-loadable); this file adds the two pieces that genuinely need
// the browser: `setLang` (which lazy-loads locale packs via import.meta.glob) and the React
// subscription hook `useLang`.

import { useSyncExternalStore } from 'react'
import {
  LANGS, INSTR_LANGS, EXERCISE_NAME_LANGS, DATE_LOCALES,
  getLang, dateLocale, t, instrFor, exerciseNameFor, exerciseNameSearchText, getVersion, _setLangState
} from './i18n-core.js'

export {
  LANGS, INSTR_LANGS, EXERCISE_NAME_LANGS, DATE_LOCALES,
  getLang, dateLocale, t, instrFor, exerciseNameFor, exerciseNameSearchText
}

// Vite code-splits locale, instruction and exercise-name packs via import.meta.glob. They are
// lazy, so the production bundle ships English only until another language is selected.
const localePacks = import.meta.glob('../locales/*.js')
const instrPacks = import.meta.glob('../instr/*.js')
const exerciseNamePacks = import.meta.glob('../exercise-names/*.js')

// React subscription bookkeeping — kept here, not in core, so core has zero React coupling.
const subs = new Set()
const notify = () => { subs.forEach(f => f()) }

/**
 * Switch language. Resolves as soon as the *interface* is speaking it.
 *
 * The three packs are wildly different sizes — for pt-BR the UI strings are 30 kB against 680 kB
 * of exercise instructions, and hindi's are 1.5 MB — and only the first is on screen at startup.
 * Waiting for all three before applying any of them left every button, title and tab label in
 * English until a megabyte of step-by-step text had arrived, which is exactly as long as the app
 * appeared to be in the wrong language. So the UI pack lands on its own, and the heavy ones
 * follow without holding anyone up.
 */
export async function setLang(l) {
  if (!LANGS[l]) l = 'en'
  if (l === getLang() && getVersion() > 0) return
  if (l === 'en') { _setLangState('en', {}, null, null); notify(); return }
  let dict = {}
  try { dict = (await localePacks['../locales/' + l + '.js']()).default } catch (e) { dict = {} }
  _setLangState(l, dict, null, null)
  notify()
  loadContentPacks(l, dict)      // deliberately not awaited
}

/**
 * Exercise instructions and translated exercise names, fetched after the interface has already
 * switched over. In parallel, because they are independent and two round trips in series were
 * two waits for no reason.
 */
async function loadContentPacks(l, dict) {
  const wantInstr = INSTR_LANGS.includes(l) ? instrPacks['../instr/' + l + '.js'] : null
  const wantNames = EXERCISE_NAME_LANGS.includes(l) ? exerciseNamePacks['../exercise-names/' + l + '.js'] : null
  if (!wantInstr && !wantNames) return
  const [instr, exerciseNames] = await Promise.all([
    wantInstr ? wantInstr().then(m => m.default).catch(() => null) : null,
    wantNames ? wantNames().then(m => m.default).catch(() => null) : null,
  ])
  // A megabyte is long enough to change your mind in: if the language moved on while these were
  // in flight, they belong to a language nobody is looking at any more.
  if (getLang() !== l) return
  _setLangState(l, dict, instr, exerciseNames)
  notify()
}

// Re-renders the subscribing component (and its children) whenever the language changes.
export function useLang() {
  return useSyncExternalStore(fn => { subs.add(fn); return () => subs.delete(fn) }, getVersion)
}
