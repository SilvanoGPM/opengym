// Browser-only shell of the i18n module. The runtime-agnostic state and readers live
// in i18n-core.js (plain Node-loadable); this file adds the two pieces that genuinely need
// the browser: `setLang` (which lazy-loads locale packs via import.meta.glob) and the React
// subscription hook `useLang`.

import { useSyncExternalStore } from 'react'
import {
  LANGS, INSTR_LANGS, EXERCISE_NAME_LANGS, DATE_LOCALES, DERIVED_LOCALES, RTL_LANGS,
  getLang, dateLocale, t, instrFor, exerciseNameFor, exerciseNameSearchText, getVersion,
  baseLang, derivePack, _setLangState, exerciseNameClass
} from './i18n-core.js'

export {
  LANGS, INSTR_LANGS, EXERCISE_NAME_LANGS, DATE_LOCALES, DERIVED_LOCALES, RTL_LANGS,
  getLang, dateLocale, t, instrFor, exerciseNameFor, exerciseNameSearchText, exerciseNameClass, baseLang
}

// Vite code-splits locale, instruction and exercise-name packs via import.meta.glob. They are
// lazy, so the production bundle ships English only until another language is selected.
const localePacks = import.meta.glob('../locales/*.js')
const instrPacks = import.meta.glob('../instr/*.js')
const exerciseNamePacks = import.meta.glob('../exercise-names/*.js')

// React subscription bookkeeping — kept here, not in core, so core has zero React coupling.
const subs = new Set()
const notify = () => { subs.forEach(f => f()) }
let lastShowEn = undefined
let lastEnOnly = undefined
// Bumped by every setLang; a pack that lands after a newer call belongs to a language (or a
// display setting) nobody is looking at any more, and must not reinstate itself.
let seq = 0
// Instructions and exercise names per base language, once loaded. Toggling the English-name
// switches re-runs setLang for the same language, and without this the instructions would drop
// back to English for as long as it took to fetch the pack again.
const content = new Map()

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
export async function setLang(l, showEn, enOnly) {
  if (!LANGS[l]) l = 'en'
  const show = showEn !== false
  const only = enOnly === true
  // Both display switches participate in the early-exit, so toggling the parens or the
  // English-only switch re-applies state even when l did not change.
  if (l === getLang() && getVersion() > 0 && show === lastShowEn && only === lastEnOnly) return
  // A derived locale (de-CH) ships no packs of its own: it loads its base language's and
  // transforms the strings on the way through. `l` stays the selected language throughout, so
  // dateLocale() still reports de-CH and formats numbers Swiss-style.
  lastShowEn = show
  lastEnOnly = only
  const req = ++seq
  const base = baseLang(l)
  let dict = {}
  try { dict = base === 'en' ? {} : (await localePacks['../locales/' + base + '.js']()).default } catch (e) { dict = {} }
  if (req !== seq) return
  dict = derivePack(l, dict)
  const have = content.get(base)
  _setLangState(l, dict, derivePack(l, have?.instr || null), derivePack(l, have?.exerciseNames || null), show, only)
  document.documentElement.lang = l
  document.documentElement.dir = RTL_LANGS.has(l) ? 'rtl' : 'ltr'
  notify()
  if (!have) loadContentPacks(req, l, dict, show, only)      // deliberately not awaited
}

/**
 * Exercise instructions and translated exercise names, fetched after the interface has already
 * switched over. In parallel, because they are independent and two round trips in series were
 * two waits for no reason.
 */
async function loadContentPacks(req, l, dict, show, only) {
  const base = baseLang(l)
  const wantInstr = base !== 'en' && INSTR_LANGS.includes(base) ? instrPacks['../instr/' + base + '.js'] : null
  const wantNames = base !== 'en' && EXERCISE_NAME_LANGS.includes(base) ? exerciseNamePacks['../exercise-names/' + base + '.js'] : null
  if (!wantInstr && !wantNames) return
  const [instr, exerciseNames] = await Promise.all([
    wantInstr ? wantInstr().then(m => m.default).catch(() => null) : null,
    wantNames ? wantNames().then(m => m.default).catch(() => null) : null,
  ])
  // Cached even when stale: the language that asked may well come back.
  if ((!wantInstr || instr) && (!wantNames || exerciseNames)) content.set(base, { instr, exerciseNames })
  if (req !== seq) return
  _setLangState(l, dict, derivePack(l, instr), derivePack(l, exerciseNames), show, only)
  notify()
}

// Re-renders the subscribing component (and its children) whenever the language changes.
export function useLang() {
  return useSyncExternalStore(fn => { subs.add(fn); return () => subs.delete(fn) }, getVersion)
}
