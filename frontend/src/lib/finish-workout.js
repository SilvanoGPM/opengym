// The persisted boundary for a finished session. Keep this pure so compatibility tests can
// exercise the exact shape the UI writes without mounting React or mutating store state.
export function buildCompletedWorkout(active, { end = Date.now(), prs = [], snapshotFor } = {}) {
  const entries = (active?.entries || []).map(entry => {
    const completed = {
      id: entry.id,
      sets: entry.sets,
      topW: entry.topW || null,
      target: entry.target || null,
    }
    const snapshot = typeof snapshotFor === 'function' ? snapshotFor(entry) : null
    if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot) && Object.keys(snapshot).length) {
      completed.muscleSnapshot = { ...snapshot }
    }
    // What you typed about this exercise today, and whether you asked to see it again next
    // time. Written only when there is something to keep, so an untouched entry is byte-for-byte
    // the shape it always was.
    const note = (entry.note || '').trim()
    if (note) {
      completed.note = note
      if (entry.notePin) completed.notePin = true
    }
    return completed
  }).filter(entry => entry.sets.some(set => set.done))

  const sessionNote = (active?.note || '').trim()

  // A session filled in after the fact has no clock: the span between `start` and now is just
  // the days you forgot to log. Collapse it to zero so durPart() leaves the duration out
  // entirely, the way it already does for imported history. `back` is a flag about how the
  // session was entered and never reaches the stored record.
  const finishedAt = active?.back ? active.start : end

  return {
    id: active.id,
    d: active.d,
    start: active.start,
    end: finishedAt,
    routineId: active.routineId,
    name: active.name,
    bw: active.bw,
    entries,
    prs,
    ...(sessionNote ? { note: sessionNote } : {}),
  }
}

/** The hour of day a session with no clock is filed under. */
export const BACKDATED_HOUR_MS = 18 * 3600000

/**
 * The `start` for a session filled in after the fact: LOCAL midnight of that day plus 18h — the
 * same formula import-csv.js uses for a row with no time column. Imported history and
 * hand-filled history have to decay identically in recovery.js and effort.js, which both fall
 * back to `w.start || new Date(w.d)` — and `new Date('YYYY-MM-DD')` is UTC, which walks the day
 * backwards in negative offsets.
 */
export const backdatedStart = iso => new Date(iso + 'T00:00:00').getTime() + BACKDATED_HOUR_MS

/**
 * Puts a finished session into the history, oldest first.
 *
 * Array order is load-bearing: sessionsFor/stallCount (progression.js) and
 * lastEntryFor/pinnedNoteFor (history.js) all read "the most recent" as "the last one in the
 * array". Pushing a backdated session would make it the base for the next prescription — the
 * bug this whole feature would otherwise introduce. Same-day ties keep insertion order, so a
 * second session logged for a day still sorts after the first; that is what the stable sort in
 * mergeImport already assumes. Deliberately no tiebreak on `start`: a backdated session is filed
 * at 18:00, which would jump it ahead of a real 07:00 session on the same day.
 */
export function insertWorkout(workouts, w) {
  const list = workouts || []
  let i = list.length
  while (i > 0 && list[i - 1].d > w.d) i--
  return [...list.slice(0, i), w, ...list.slice(i)]
}

/**
 * The next working-weight suggestion for a lift, or null when there is nothing to record.
 *
 * The long-standing rule — heaviest wins — plus a date guard: a session filled in for last
 * Tuesday must not overwrite what Wednesday's session already established. Without it, logging a
 * heavy missed day walks today's suggestion backwards in time.
 */
export function nextExWeight(cur, { w, d }) {
  if (!(w > 0)) return cur || null
  if (!cur) return { w, d }
  if (d < cur.d) return cur
  return w > cur.w ? { w, d } : cur
}
