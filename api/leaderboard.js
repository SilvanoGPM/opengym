// Rollups that feed the cross-profile leaderboard.
//
// Pure and separate from server.js for the same reason as user-summary.js: server.js listens at
// module scope and exports nothing, so anything worth testing has to live beside it.
//
// The rule this file obeys above all: it never looks inside a set. Everything is built from the
// two fields a finished workout already carries — `d` (the local YYYY-MM-DD it happened on) and
// `vol` (weight x reps, warm-ups already excluded by workoutVolume in the frontend). A second copy
// of training arithmetic on the server is exactly what this repo avoids; see user-summary.js.

const LB_TO_KG = 0.45359237;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Guard for a range parameter off the query string. */
export const isDay = s => typeof s === 'string' && DAY_RE.test(s);

/**
 * Volume in a profile's own unit -> kg.
 *
 * Every number in a state is in its `unit` (a kg <-> lb switch converts the history, stored totals
 * included), which is harmless while every profile is an island and fatal the moment two are put
 * in one list: a pound profile would out-rank a kilo one by 2.2x for the same work. Ranking
 * happens in kg; the view converts back to whoever is looking.
 *
 * Known limit: a switch made with "keep the numbers, change the label" leaves history logged in
 * the other unit, and it is read as the current one — as the profile's own charts read it.
 */
export function toKg(vol, unit) {
  if (!(typeof vol === 'number' && isFinite(vol))) return 0;
  return unit === 'lb' ? vol * LB_TO_KG : vol;
}

/**
 * One pass over a user's history into a per-day roll: { 'YYYY-MM-DD': { n, vol, volUnknown } }.
 *
 * The server caches this per state file, so the parse is paid once per change rather than once per
 * request, and any date range is then a cheap scan over a small object — a year of daily training
 * is a few hundred keys.
 */
export function dailyRoll(state) {
  const S = state || {};
  const workouts = Array.isArray(S.workouts) ? S.workouts : [];
  const unit = S.unit === 'lb' ? 'lb' : 'kg';
  const days = Object.create(null);

  for (const w of workouts) {
    const d = typeof w?.d === 'string' ? w.d : null;
    if (!d) continue;
    const day = days[d] || (days[d] = { n: 0, vol: 0, volUnknown: 0 });
    day.n++;
    // Imported history carries no volume. Counted apart rather than added as zero, so the screen
    // can say "N sessions without volume" instead of quietly under-reporting somebody's total.
    if (typeof w.vol === 'number' && isFinite(w.vol)) day.vol += toKg(w.vol, unit);
    else day.volUnknown++;
  }
  return { unit, days };
}

/**
 * Totals over a closed [from, to] range, both ends inclusive.
 *
 * Compared as strings: ISO dates sort lexicographically, so no Date is constructed and no timezone
 * question reaches the server. The client picks the range — it owns weekKey and knows the user's
 * calendar — and the server only filters. `w.d` is already the local date of whoever trained.
 *
 * `checkins` counts distinct days, not sessions: going twice in one day is still one day you
 * showed up. `sessions` rides along as the secondary number.
 */
export function rangeTotals(roll, from, to) {
  const days = (roll && roll.days) || {};
  let checkins = 0, sessions = 0, volKg = 0, volUnknown = 0;

  for (const d in days) {
    if (d < from || d > to) continue;
    const day = days[d];
    checkins++;
    sessions += day.n;
    volKg += day.vol;
    volUnknown += day.volUnknown;
  }
  // One decimal is past anything a plate can express; the rest is float dust from the lb factor.
  return { checkins, sessions, volKg: Math.round(volKg * 10) / 10, volUnknown };
}
