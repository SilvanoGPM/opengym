// Rollups over one user's state file, for the admin dashboard.
//
// Pure and separate from server.js for the reason the rest of this directory is: server.js
// listens at module scope and exports nothing, so anything worth testing has to live beside it.
// See push-messages.js and verify-error.js for the same shape.

/**
 * The detail screen's rollups: counts, the span trained, and a month-by-month series.
 *
 * `vol` sums the `vol` each finished workout carries. Records without one — imported history,
 * anything written before the field existed — are counted into `volUnknown` rather than added as
 * zero, because the alternative is a chart that quietly under-reports. Recomputing volume here
 * would mean a second copy of workoutVolume() (frontend/src/lib/history.js) on the server, and
 * two copies of training arithmetic is exactly what this repo avoids.
 */
export function summarize(state) {
  const S = state || {};
  const workouts = Array.isArray(S.workouts) ? S.workouts : [];
  const bodyweight = Array.isArray(S.bodyweight) ? S.bodyweight : [];
  const months = new Map();
  let volUnknown = 0;

  workouts.forEach(w => {
    const d = typeof w?.d === 'string' ? w.d : null;
    if (!d) return;
    const key = d.slice(0, 7);
    const m = months.get(key) || { m: key, workouts: 0, vol: 0, ms: 0 };
    m.workouts++;
    if (typeof w.vol === 'number' && isFinite(w.vol)) m.vol += w.vol; else volUnknown++;
    // Imported sessions and days filled in later carry no clock; end === start reads as zero.
    const span = (w.end || w.start || 0) - (w.start || 0);
    if (span > 0) m.ms += span;
    months.set(key, m);
  });

  const first = workouts.find(w => w?.d)?.d || null;
  const last = workouts.length ? [...workouts].reverse().find(w => w?.d)?.d || null : null;

  return {
    counts: {
      workouts: workouts.length,
      bodyweight: bodyweight.length,
      routines: Array.isArray(S.routines) ? S.routines.length : 0,
      customEx: Array.isArray(S.customEx) ? S.customEx.length : 0,
    },
    first,
    last,
    // Ascending, and only months that have something — the chart fills its own gaps.
    monthly: [...months.values()].sort((a, b) => (a.m < b.m ? -1 : 1)),
    volUnknown,
  };
}
