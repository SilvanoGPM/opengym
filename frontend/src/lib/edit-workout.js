// Editing a workout that is already in the history.
//
// A logged session is not just its sets: finishing one froze three values that nothing else in
// the app recomputes — `w.vol`, `w.prs`, and the `S.exWeights` suggestion it fed. Everything
// else (1RM, strength curves, fatigue, effort, the progression engine) derives from the history
// on every read and fixes itself. These helpers are the part that has to be told.
//
// Kept pure and beside its test because the rules here decide what you lift next: a phantom
// working weight, or a trophy on a session that is no longer a record, is not something you can
// see by clicking through the screen.
import { cascadeWeight, insertWarmupRow, removeRowAt, workoutVolume, bestWeightFor, modeOf } from './history.js'
import { isWarmupRow } from './workout-model.js'
import { nextExWeight } from './finish-workout.js'

/** The heaviest work set actually logged in an entry — the number both `prs` and `exWeights` ask for. */
const topDoneWeight = entry =>
  Math.max(0, ...(entry.sets || []).filter(s => s.done && !isWarmupRow(s)).map(s => s.w || 0))

/* ============================ entry transforms ============================ */
/* Immutable: each returns a new entry. The active session and the history editor drive the same
   rows, so they share these rather than keeping two copies of the arithmetic in step by hand. */

/** Write one field of one set. A null clears the key rather than storing null, so a set carries
 *  only what was actually logged — in the session, in history and in a backup. */
export function setSetField(entry, i, field, v) {
  const sets = entry.sets.map((s, k) => {
    if (k !== i) return s
    const row = { ...s }
    if (v == null) delete row[field]; else row[field] = v
    return row
  })
  // Changing a weight cascades to the following sets of the same phase, so a heavier bar
  // carries through the set instead of retyping every row.
  return { ...entry, sets: field === 'w' ? cascadeWeight(sets, i, v) : sets }
}

/**
 * Add a set, seeded from the last row and falling back to the target.
 *
 * `target` is read defensively because a logged workout may not have one: it is `null` for
 * anything imported from CSV and for history written before the field existed. The active
 * session always has one, which is why reading it bare never failed here before.
 */
export function appendSet(entry) {
  const tgt = entry.target || {}
  const l = entry.sets[entry.sets.length - 1]
  const m = modeOf({ ...tgt, id: entry.id })
  const row = m === 'cardio'
    ? { min: l ? l.min : (tgt.min || 20), speed: l ? l.speed : (tgt.speed || 8), done: false }
    : m === 'time'
      ? { sec: l ? l.sec : (tgt.sec || 45), w: l ? (l.w || 0) : (tgt.weight || 0), done: false }
      : { w: l ? l.w : 0, r: l ? l.r : (tgt.reps ?? 10), done: false }
  return { ...entry, sets: [...entry.sets, row] }
}

/** Drop the last set. An entry always keeps at least one row. */
export function popSet(entry) {
  return entry.sets.length > 1 ? { ...entry, sets: entry.sets.slice(0, -1) } : { ...entry }
}

/**
 * Add a warm-up row at the end of the warm-up block.
 *
 * `insertWarmupRow` stamps `done: false`, which is right in a live session — you have not done it
 * yet. Filling in history is the opposite case: the row is being recorded because it happened.
 */
export function appendWarmup(entry, step, { done = false } = {}) {
  const rows = insertWarmupRow(entry.sets, modeOf({ ...(entry.target || {}), id: entry.id }), entry.target || {}, step)
  if (!done || rows.length === entry.sets.length) return { ...entry, sets: rows }
  // Where insertWarmupRow splices: the end of the warm-up block, i.e. just before the first
  // work row. Recomputed rather than diffed so this cannot drift if the rows look alike.
  const firstWork = entry.sets.findIndex(x => !isWarmupRow(x))
  const at = firstWork === -1 ? entry.sets.length : firstWork
  return { ...entry, sets: rows.map((r, i) => (i === at ? { ...r, done: true } : r)) }
}

/** Remove one row by position. */
export function dropSetAt(entry, i) {
  return { ...entry, sets: removeRowAt(entry.sets, i) }
}

/* ============================ frozen derived values ============================ */

/**
 * The PR list for one workout, judged against the sessions BEFORE it.
 *
 * Ordinal by array position rather than by date: `insertWorkout` keeps same-day sessions in the
 * order they were logged, and a date filter would drop an earlier session on the same day. This
 * is what keeps a trophy meaning "this was a record when you did it" — editing one session
 * therefore never rewrites the trophies of the sessions after it.
 *
 * Deliberately diverges from doFinishWorkout, which compares against the whole history including
 * a backdated session's own future. The ordinal rule is the stricter one.
 */
export function recomputeWorkoutPRs(workouts, id) {
  const list = workouts || []
  const at = list.findIndex(w => w.id === id)
  if (at < 0) return []
  const before = { workouts: list.slice(0, at) }
  const out = []
  ;(list[at].entries || []).forEach(e => {
    const mx = topDoneWeight(e)
    if (mx > 0 && mx > bestWeightFor(before, e.id) && !out.includes(e.id)) out.push(e.id)
  })
  return out
}

/**
 * Rebuild the working-weight suggestions for the given exercise ids by replaying the history.
 *
 * This is the only one of the three frozen values that cannot correct itself: `nextExWeight` is
 * non-decreasing by design, so correcting a mistyped 100 back down to 90 would otherwise leave
 * the 100 standing forever — seeding future sessions, and silently suppressing the "new record!"
 * badge for every legitimate PR between 90 and 100.
 *
 * Scoped to the ids an edit touched, never global. A full rescan would also rewrite entries that
 * mergeImport seeded under a different rule (`w.d >= cur.d`, which lets a later lighter session
 * lower the number), quietly raising the suggestions of anyone who imported a CSV.
 *
 * Replaying in array order means `d` is non-decreasing, so nextExWeight's date guard never fires
 * here — the sequence reproduces exactly what a run of finishes would have written.
 */
export function rebuildExWeights(workouts, prev, ids) {
  const only = ids ? new Set(ids) : null
  const out = { ...(prev || {}) }
  if (only) only.forEach(id => delete out[id]); else Object.keys(out).forEach(id => delete out[id])
  ;(workouts || []).forEach(w => (w.entries || []).forEach(e => {
    if (only && !only.has(e.id)) return
    const mx = Math.max(topDoneWeight(e), e.topW || 0)
    const nxt = nextExWeight(out[e.id], { w: mx, d: w.d })
    if (nxt) out[e.id] = nxt
  }))
  return out
}

/* ============================ save ============================ */

/**
 * Turn an edit draft back into a stored workout, shaped exactly like buildCompletedWorkout's
 * output — same keys, same order, same omissions. A record that has been edited must be
 * indistinguishable from one that was finished, or every reader of the history grows a special
 * case for the difference.
 */
export function normalizeEditedWorkout(draft, original, { snapshotFor } = {}) {
  const byKey = new Map((original?.entries || []).map((e, i) => [e._k || 'k' + i, e]))
  const entries = (draft.entries || []).map(entry => {
    const before = byKey.get(entry._k)
    const completed = {
      id: entry.id,
      sets: entry.sets,
      topW: clampTopW(entry, before),
      // Taken from the stored entry, not the draft: `target` is the yardstick readSession judges
      // a session by, so rewriting it would re-decide, years later, whether you hit your numbers
      // — moving the stall count and firing a deload nobody asked for. An entry the editor added
      // has no stored version, and there its target is the config just chosen for it.
      target: (before ? before.target : entry.target) || null,
    }
    // The only memory of a custom exercise that has since been deleted. Carried over verbatim —
    // regenerating it from the catalogue would look the id up and find nothing.
    const snapshot = before?.muscleSnapshot || (typeof snapshotFor === 'function' ? snapshotFor(entry) : null)
    if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot) && Object.keys(snapshot).length) {
      completed.muscleSnapshot = { ...snapshot }
    }
    const name = before?.n || entry.n
    if (name) completed.n = name
    const note = (entry.note || '').trim()
    if (note) {
      completed.note = note
      if (entry.notePin) completed.notePin = true
    }
    return completed
  }).filter(entry => entry.sets.some(set => set.done))

  const sessionNote = (draft.note || '').trim()
  const minutes = Math.max(0, Math.round(draft.durMin || 0))

  return {
    id: draft.id,
    d: draft.d,
    start: draft.start,
    end: draft.start + minutes * 60000,
    routineId: draft.routineId,
    name: draft.name,
    bw: draft.bw,
    entries,
    prs: [],                                  // filled in by commitWorkoutEdit, which sees the history
    ...(sessionNote ? { note: sessionNote } : {}),
  }
}

/**
 * `topW` is the working weight you confirmed at the end of the exercise, and bestWeightForEntry
 * falls back to it for legacy entries. Left exactly as it was when the sets did not change, so an
 * untouched entry round-trips byte for byte; clamped down when they did, since a stored 100 on an
 * entry whose heaviest row now reads 90 is the same phantom rebuildExWeights exists to kill.
 */
function clampTopW(entry, before) {
  const stored = entry.topW ?? null
  if (stored == null) return null
  const unchanged = before && JSON.stringify(before.sets) === JSON.stringify(entry.sets)
  if (unchanged) return stored
  const mx = topDoneWeight(entry)
  return mx > 0 && stored > mx ? mx : stored
}

/**
 * Put an edited workout back into the history and repair what it invalidated.
 *
 * Pure so the whole repair is one testable step: the caller assigns the result inside a single
 * store update. Only the edited record's `vol` and `prs` are rewritten — every other workout
 * comes back byte for byte.
 */
export function commitWorkoutEdit(state, edited) {
  const list = state.workouts || []
  const at = list.findIndex(w => w.id === edited.id)
  // Deleted from under us — the detail sheet can delete the very record this screen is editing.
  if (at < 0) return { workouts: list, exWeights: state.exWeights }
  const touched = new Set([
    ...(list[at].entries || []).map(e => e.id),
    ...(edited.entries || []).map(e => e.id),
  ])
  // The date is not editable, so the record keeps its slot and the array stays ordered.
  const workouts = [...list.slice(0, at), edited, ...list.slice(at + 1)]
  edited.vol = workoutVolume(edited)
  edited.prs = recomputeWorkoutPRs(workouts, edited.id)
  return { workouts, exWeights: rebuildExWeights(workouts, state.exWeights, touched) }
}
