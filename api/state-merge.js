// Merging a backup into a user's existing state, and replacing it outright.
//
// This is a deliberate second implementation of frontend/src/lib/import-csv.js `mergeImport`.
// It cannot import that one: mergeImport reaches for EXIDX, which pulls in the 1,324-exercise
// catalogue the frontend ships, and CONTRIBUTING makes a new dependency in api/ a hard sell.
// The rule is therefore duplicated on purpose and pinned by tests on both sides — day-keyed,
// existing wins, ascending, exWeights seeded only when the incoming day is not older.
//
// If you change the rule here, change it there. (import-csv.js carries the mirror of this note.)
import { normalizeState } from './state-schema.js';

/**
 * Fold `incoming` into `current` without losing anything.
 *
 * Deduplication is by DAY, not by workout id, matching the import path: two files describing the
 * same session almost never agree on ids, and a day that already has a workout is a day the user
 * has already accounted for. That is what makes merge the safe default — it can add, never remove.
 */
export function mergeState(current, incoming, { ts = Date.now() } = {}) {
  const cur = current || {};
  const inc = incoming || {};
  const out = { ...cur };

  const curWorkouts = Array.isArray(cur.workouts) ? cur.workouts : [];
  const incWorkouts = Array.isArray(inc.workouts) ? inc.workouts : [];
  const haveDays = new Set(curWorkouts.map(w => w.d));
  const freshWorkouts = incWorkouts.filter(w => !haveDays.has(w.d));
  out.workouts = [...curWorkouts, ...freshWorkouts];

  const curBw = Array.isArray(cur.bodyweight) ? cur.bodyweight : [];
  const incBw = Array.isArray(inc.bodyweight) ? inc.bodyweight : [];
  const haveBwDays = new Set(curBw.map(b => b.d));
  const freshBw = incBw.filter(b => !haveBwDays.has(b.d));
  out.bodyweight = [...curBw, ...freshBw];

  // Custom exercises only for lifts the new workouts actually reference — a backup can carry a
  // whole library, and importing exercises nobody did is noise in the user's own list.
  const used = new Set(freshWorkouts.flatMap(w => (w.entries || []).map(e => e.id)));
  const curCustom = Array.isArray(cur.customEx) ? cur.customEx : [];
  const haveCustom = new Set(curCustom.map(c => c.id));
  const freshCustom = (Array.isArray(inc.customEx) ? inc.customEx : [])
    .filter(c => used.has(c.id) && !haveCustom.has(c.id));
  out.customEx = [...curCustom, ...freshCustom];

  // Working-weight suggestions, under mergeImport's exact rule: an older session never lowers a
  // newer suggestion.
  out.exWeights = { ...(cur.exWeights || {}) };
  freshWorkouts.forEach(w => (w.entries || []).forEach(e => {
    const mx = Math.max(0, ...(e.sets || []).map(s => s.w || 0), e.topW || 0);
    if (mx > 0) {
      const prev = out.exWeights[e.id];
      if (!prev || w.d >= prev.d) out.exWeights[e.id] = { w: mx, d: w.d };
    }
  }));

  // Routines are left alone. A merge is about history; rewriting someone's plan from a backup is
  // a different, louder operation, and replace is where that lives.
  return {
    state: normalizeState(out, { ts }),
    added: freshWorkouts.length,
    skipped: incWorkouts.length - freshWorkouts.length,
    addedBodyweight: freshBw.length,
  };
}

/** Take the incoming state wholesale. Keeps nothing of the current one — hence the confirmation. */
export function replaceState(incoming, { ts = Date.now() } = {}) {
  const inc = incoming || {};
  return {
    state: normalizeState(inc, { ts }),
    added: Array.isArray(inc.workouts) ? inc.workouts.length : 0,
    skipped: 0,
    addedBodyweight: Array.isArray(inc.bodyweight) ? inc.bodyweight.length : 0,
  };
}
