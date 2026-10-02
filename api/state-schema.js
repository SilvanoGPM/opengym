// What a state file has to look like before this server will write it.
//
// PUT /api/data checks the shape of the lists and drops entries that are not objects — it is the
// user's own data coming back from their own client. An admin restore is different: the file
// arrives from a person's disk, is written into somebody else's account, and is read afterwards
// by the reminder tick, the dashboard, the Coach and the MCP bridge. So it is checked further.
//
// Pure, because server.js exports nothing and listens at module scope. See push-messages.js.

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Structural check only. It does NOT enforce a whitelist of keys: a client one version ahead of
 * the server may legitimately carry a field this build has never heard of, and silently dropping
 * it on restore would corrupt a backup that was perfectly good.
 */
export function validateState(state) {
  const errors = [];
  if (!isObj(state)) return { ok: false, errors: ['the backup contains no state object'] };

  for (const key of ['workouts', 'routines', 'bodyweight', 'customEx']) {
    if (state[key] !== undefined && !Array.isArray(state[key])) errors.push(`${key} is not a list`);
  }
  if (Array.isArray(state.workouts)) {
    state.workouts.forEach((w, i) => {
      if (!isObj(w)) { errors.push(`workout ${i} is not an object`); return; }
      if (!w.id) errors.push(`workout ${i} has no id`);
      if (!ISO_DAY.test(String(w.d || ''))) errors.push(`workout ${i} has no valid date (got ${JSON.stringify(w.d)})`);
      if (w.entries !== undefined && !Array.isArray(w.entries)) errors.push(`workout ${i} has a broken entry list`);
    });
  }
  if (Array.isArray(state.bodyweight)) {
    state.bodyweight.forEach((b, i) => {
      if (!isObj(b)) { errors.push(`weigh-in ${i} is not an object`); return; }
      if (!ISO_DAY.test(String(b.d || ''))) errors.push(`weigh-in ${i} has no valid date`);
      if (typeof b.w !== 'number' || !isFinite(b.w)) errors.push(`weigh-in ${i} has no weight`);
    });
  }
  // Enough to tell someone what is wrong without printing a thousand lines at them.
  return { ok: errors.length === 0, errors: errors.slice(0, 10) };
}

// By day, then by start: the order every other writer keeps (frontend/src/lib/sync-merge.js).
const byDayStart = (a, b) => (a.d === b.d ? (a.start || 0) - (b.start || 0) : a.d < b.d ? -1 : 1);

/**
 * Put a state into the shape the rest of the app assumes.
 *
 * Sorting matters more than it looks: array order is how progression.js and history.js decide
 * which session is the most recent one, and GET /api/admin/user hands its list out newest-first.
 * A restore built from a screen's payload would otherwise write history backwards.
 */
export function normalizeState(state, { ts = Date.now() } = {}) {
  const out = { ...state };
  delete out.active;                       // in-progress sessions are device-local, as in PUT /api/data
  delete out._rev;                         // the server's own count, set by whoever writes the file
  if (Array.isArray(out.workouts)) {
    const seen = new Set();
    out.workouts = out.workouts
      .filter(w => { if (!w || seen.has(w.id)) return false; seen.add(w.id); return true; })
      .sort(byDayStart);
  }
  if (Array.isArray(out.bodyweight)) {
    out.bodyweight = out.bodyweight.slice().sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  }
  out._ts = ts;
  return out;
}
