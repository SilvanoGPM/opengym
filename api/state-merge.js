// Merging a backup into a user's existing state, replacing it outright, and stamping what an
// administrative write took away so the user's own devices do not bring it back.
//
// mergeState is a deliberate second implementation of frontend/src/lib/import-csv.js
// `mergeImport`. It cannot import that one: mergeImport reaches for EXIDX, which pulls in the
// exercise catalogue the frontend ships, and the api image carries nothing from frontend/. The
// rule is therefore duplicated on purpose — day-keyed, existing wins, exWeights seeded only when
// the incoming day is not older. If you change the rule here, change it there.
//
// stampRemoval mirrors the entry names of frontend/src/lib/sync-merge.js (RESET_LISTS and
// RESET_MAPS) for the same reason. Those names are what a device that has not seen the change
// drops when it merges, so the two lists must agree key for key.
import { normalizeState } from './state-schema.js';

/**
 * Fold `incoming` into `current` without losing anything.
 *
 * Deduplication is by DAY, not by workout id, matching the import path: two files describing the
 * same session almost never agree on ids, and a day that already has a workout is a day the user
 * has already accounted for. That is what makes merge the safe default — it can add, never remove.
 *
 * Stamped with the time of the merge like any change to the document. A device that meets this
 * copy without a revision to go by (one upgrading from a client before revisions) keeps whichever
 * copy is newer, and an older stamp here would have its copy pushed over what the merge added.
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

// How an entry is named in `resetIds`, per field — sync-merge.js RESET_LISTS / RESET_MAPS.
const RESET_LISTS = {
  workouts: w => (w?.id != null ? w.id : `${w?.d}|${w?.start}`),
  routines: x => x?.id, customEx: x => x?.id,
  bodyweight: e => `${e?.d}|${e?.t ?? ''}`,
  gymCards: x => x?.id, equipProfiles: x => x?.id, favEx: x => x,
};
const RESET_MAPS = ['exNotes', 'barWeights', 'balanceOverrides', 'loadKind', 'plates'];
// sync-merge.js RESET_ID_MAX: per field, the most names kept; past it the oldest go first.
const RESET_ID_MAX = 20000;
const list = v => (Array.isArray(v) ? v : []);
const isMap = v => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Stamp `next` — a document an admin is about to write over `cur` — as a reset of the entries it
 * no longer holds. Mutates and returns `next`.
 *
 * This is the stamp "Reset everything" uses (`resetAt`, with `resetIds`: what it wiped), and it
 * is what keeps a restore or a deleted workout from coming back. A device that last saw `cur` and
 * still owes a change of its own pushes it on an old revision, gets the 409, and merges: without
 * the stamp its union would carry every removed entry straight back. With it, that device drops
 * exactly the entries named here and keeps the rest — including whatever it logged meanwhile,
 * which no admin write knew about.
 *
 * The names of an earlier reset are carried over, so a device that missed that one too still
 * drops what it wiped; and the stamp only moves forward, as the PUT route and the client both
 * require.
 */
export function stampRemoval(cur, next, now = Date.now()) {
  const gone = {};
  for (const [f, key] of Object.entries(RESET_LISTS)) {
    const keep = new Set(list(next?.[f]).filter(x => x != null).map(x => String(key(x))));
    gone[f] = list(cur?.[f]).filter(x => x != null).map(x => String(key(x))).filter(k => !keep.has(k));
  }
  for (const f of RESET_MAPS) {
    const keep = isMap(next?.[f]) ? next[f] : {};
    gone[f] = Object.keys(isMap(cur?.[f]) ? cur[f] : {}).filter(k => !(k in keep));
  }
  const earlier = isMap(cur?.resetIds) ? cur.resetIds : {};
  const ids = {};
  for (const f of [...Object.keys(RESET_LISTS), ...RESET_MAPS]) {
    const xs = [...new Set([...list(earlier[f]), ...gone[f]].filter(k => k != null).map(String))];
    if (xs.length) ids[f] = xs.length > RESET_ID_MAX ? xs.slice(xs.length - RESET_ID_MAX) : xs;
  }
  next.resetAt = Math.max(now, (Number(cur?.resetAt) || 0) + 1);
  next.resetIds = ids;
  return next;
}
