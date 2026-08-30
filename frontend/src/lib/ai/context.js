// Turning state into something worth paying to send.
//
// Two rules run through all of it. First, reuse: volume comes from workoutVolume, a set's label
// from setLabel, a plan's line from exLine, muscle load from loadOfWorkouts. Re-deriving any of
// those here would be a second, quietly diverging copy of arithmetic this repo has already got
// wrong once — warm-ups counted in volume, drop-set drops counted twice — and the AI would then
// report numbers the Stats screen disagrees with.
//
// Second, size. The exercise catalogue is 1324 entries and never appears here; a routine is
// under a kilobyte and a dozen sessions are a few. What gets sent is the user's own data, small
// by nature, and the tests hold it to that.
import { exOr } from '../exercises.js'
import { exerciseNameFor } from '../i18n-core.js'
import { modeOf, workoutVolume, exLine, setLabel } from '../history.js'
import { policyFor, POLICY_NAME } from '../progression.js'
import { loadOfRoutine, rankOf } from '../muscles.js'
import { isWarmupRow } from '../workout-model.js'
import { best1RM, bestSetOf, DEFAULT_FORMULA } from '../onerm.js'
import { loadOfWorkouts, MUSCLE_NAME } from '../muscles.js'
import { fmtNum, DAYN } from '../format.js'
import { activeProfile } from '../equipment.js'

const round1 = v => Math.round(v * 10) / 10

/**
 * The config an entry was actually trained against, with its id put back.
 *
 * modeOf() falls through to isCardio(id) when a config carries no `mode`, and the exercise
 * config sheet saves a cardio target as { sets, min, speed } — no id, no mode. Passing
 * entry.target straight to modeOf therefore reads a 20-minute row as a 20-rep one. Every other
 * consumer in the app spreads the id back in for exactly this reason.
 */
const cfgOf = entry => ({ ...(entry.target || {}), id: entry.id })

const nameOf = id => exerciseNameFor(exOr(id))

function entryView(entry, unit) {
  const cfg = cfgOf(entry)
  const rows = entry.sets || []
  const work = rows.filter(s => s.done && !isWarmupRow(s))
  const best = bestSetOf(entry, DEFAULT_FORMULA)
  return {
    name: nameOf(entry.id),
    mode: modeOf(cfg),
    planned: entry.target ? exLine(cfg, unit) : null,
    // Only what was actually done. A set left unticked is not evidence of anything, and listing
    // its planned weight as if it had been lifted is the single most misleading thing this
    // context could do.
    sets: work.map(s => setLabel(entry.id, { ...s, done: undefined }, cfg)),
    warmups: rows.filter(s => s.done && isWarmupRow(s)).length,
    missed: rows.filter(s => !s.done && !isWarmupRow(s)).length,
    est_1rm: best ? round1(best.est) : null,
    note: entry.note || null
  }
}

/** One finished session, ready to be judged. `w` may be the workout or its id. */
export function workoutContext(S, w) {
  const workout = typeof w === 'string' ? (S.workouts || []).find(x => x.id === w) : w
  if (!workout) return null
  const unit = S.unit || 'kg'
  const entries = (workout.entries || []).map(e => entryView(e, unit))
  const ms = workout.end && workout.start ? workout.end - workout.start : 0
  return {
    date: workout.d,
    name: workout.name || null,
    unit,
    duration_min: ms > 0 ? Math.round(ms / 60000) : null,
    bodyweight: workout.bw || null,
    volume: round1(workoutVolume(workout)),
    sets_done: entries.reduce((n, e) => n + e.sets.length, 0),
    sets_missed: entries.reduce((n, e) => n + e.missed, 0),
    prs: (workout.prs || []).map(nameOf),
    note: workout.note || null,
    exercises: entries
  }
}

/** The sessions in the last `weeks` weeks, oldest first — S.workouts' own order, copied not sorted. */
export function recentWorkouts(S, weeks = 8, now = new Date()) {
  const from = new Date(now.getTime() - weeks * 7 * 86400000).toISOString().slice(0, 10)
  return (S.workouts || []).slice().filter(w => w.d >= from)
}

/** Who is training: units, weight, kit, and where the work has been going. */
export function profileContext(S, { weeks = 8, now = new Date() } = {}) {
  const unit = S.unit || 'kg'
  const recent = recentWorkouts(S, weeks, now)
  const { worked, missed } = rankOf(loadOfWorkouts(recent))
  const bw = (S.bodyweight || []).slice(-1)[0] || null
  const profile = activeProfile(S)
  return {
    unit,
    weeks,
    sessions: recent.length,
    bodyweight: bw ? { weight: bw.w, on: bw.d } : null,
    goal_weight: S.targetW || null,
    // The catalogue's own vocabulary is two vocabularies (tg/sm loose names, and the 18 canonical
    // slugs the body map uses). These are the slugs, rendered — the same words the Stats screen shows.
    trained: worked.slice(0, 8).map(m => MUSCLE_NAME[m] || m),
    untrained: missed.map(m => MUSCLE_NAME[m] || m),
    equipment: profile ? { name: profile.name, has: profile.equipment || [] } : null
  }
}

/**
 * All-time best estimated 1RM per exercise, biggest first.
 *
 * The set it came from travels with it, because best1RM says so in its own comment: "142.5 kg
 * estimated from 100x10" is a very different claim from "from 140x1", and a model handed only
 * the estimate would reason about the two as if they were the same evidence.
 */
export function prContext(S, limit = 8) {
  const ids = [...new Set((S.workouts || []).flatMap(w => (w.entries || []).map(e => e.id)))]
  return ids
    .map(id => ({ name: nameOf(id), best: best1RM(S, id, DEFAULT_FORMULA) }))
    .filter(x => x.best)
    .sort((a, b) => b.best.est - a.best.est)
    .slice(0, limit)
    .map(x => ({ name: x.name, est_1rm: round1(x.best.est), from: `${fmtNum(x.best.w)}x${x.best.r}`, on: x.best.d }))
}

/**
 * One routine as planned, plus how it has actually been trained.
 *
 * The plan on its own is not enough to judge: a routine nobody has run in two months and a
 * routine trained twice a week are different problems with the same exercise list.
 */
export function routineContext(S, routineId) {
  const routine = (S.routines || []).find(r => r.id === routineId)
  if (!routine) return null
  const unit = S.unit || 'kg'
  const done = (S.workouts || []).slice().filter(w => w.routineId === routine.id)
  const { worked, missed } = rankOf(loadOfRoutine(routine))
  const day = Object.entries(S.week || {}).find(([, id]) => id === routine.id)

  return {
    name: routine.name,
    unit,
    weekday: day ? DAYN[+day[0]] : null,
    // The routine-level default; an exercise may override it, which exercises[] reports.
    progression: POLICY_NAME[routine.prog || 'linear'] || routine.prog || null,
    trained: done.length,
    last_trained: done.length ? done[done.length - 1].d : null,
    muscles: worked.map(m => MUSCLE_NAME[m] || m),
    untrained_muscles: missed.map(m => MUSCLE_NAME[m] || m),
    exercises: (routine.ex || []).map((cfg, i, all) => ({
      name: nameOf(cfg.id),
      scheme: exLine({ ...cfg }, unit),
      mode: modeOf(cfg),
      progression: POLICY_NAME[policyFor(cfg, routine, modeOf(cfg))] || null,
      // Supersets are adjacent entries sharing an sg — the pairing is positional, so it only
      // means anything alongside its neighbour.
      superset_with: cfg.sg && all[i + 1]?.sg === cfg.sg ? nameOf(all[i + 1].id)
        : cfg.sg && all[i - 1]?.sg === cfg.sg ? nameOf(all[i - 1].id) : null,
      note: cfg.note || null
    }))
  }
}

/* ------------------------------- rendering ------------------------------- */

// Text, not JSON. Half the bytes for the same facts, and a model is far less likely to parrot
// prose back at the user than it is to echo a JSON blob it was handed.
const line = (label, value) => (value == null || value === '' ? null : `${label}: ${value}`)

export function renderWorkout(ctx) {
  if (!ctx) return ''
  const u = ctx.unit
  const head = [
    line('Session', [ctx.name, ctx.date].filter(Boolean).join(' · ')),
    line('Duration', ctx.duration_min ? ctx.duration_min + ' min' : null),
    line('Volume', fmtNum(ctx.volume) + ' ' + u + ' (warm-ups excluded)'),
    line('Sets completed', ctx.sets_done + (ctx.sets_missed ? ` (${ctx.sets_missed} planned but not done)` : '')),
    line('Body weight', ctx.bodyweight ? fmtNum(ctx.bodyweight) + ' ' + u : null),
    line('Personal records', ctx.prs.length ? ctx.prs.join(', ') : null),
    line('Their note on the session', ctx.note)
  ].filter(Boolean)

  const body = ctx.exercises.map(e => {
    const bits = [`- ${e.name}`]
    if (e.planned) bits.push(`  planned: ${e.planned}`)
    bits.push(`  done: ${e.sets.length ? e.sets.join(', ') : 'nothing logged'}`)
    if (e.warmups) bits.push(`  warm-up sets: ${e.warmups}`)
    if (e.missed) bits.push(`  not done: ${e.missed}`)
    if (e.est_1rm) bits.push(`  best estimated 1RM this session: ${fmtNum(e.est_1rm)} ${ctx.unit}`)
    if (e.note) bits.push(`  their note: ${e.note}`)
    return bits.join('\n')
  }).join('\n')

  return head.join('\n') + '\n\nExercises:\n' + body
}

export function renderProfile(ctx) {
  if (!ctx) return ''
  return [
    line('Units', ctx.unit),
    line('Sessions in the last ' + ctx.weeks + ' weeks', ctx.sessions),
    line('Body weight', ctx.bodyweight ? `${fmtNum(ctx.bodyweight.weight)} ${ctx.unit} on ${ctx.bodyweight.on}` : null),
    line('Goal weight', ctx.goal_weight ? fmtNum(ctx.goal_weight) + ' ' + ctx.unit : null),
    line('Most-trained muscles', ctx.trained.length ? ctx.trained.join(', ') : null),
    line('Untrained in that window', ctx.untrained.length ? ctx.untrained.join(', ') : null),
    line('Equipment available', ctx.equipment ? `${ctx.equipment.name} — ${ctx.equipment.has.join(', ') || 'nothing listed'}` : 'everything (no equipment profile set)')
  ].filter(Boolean).join('\n')
}

export function renderRoutine(ctx) {
  if (!ctx) return ''
  const head = [
    line('Routine', ctx.name),
    line('Scheduled on', ctx.weekday),
    line('Default progression', ctx.progression),
    line('Times trained', ctx.trained + (ctx.last_trained ? ', last on ' + ctx.last_trained : '')),
    line('Muscles it targets', ctx.muscles.join(', ') || 'none the map can see'),
    line('Muscles it leaves out', ctx.untrained_muscles.join(', '))
  ].filter(Boolean)

  const body = ctx.exercises.map(e => {
    const bits = [`- ${e.name}: ${e.scheme}`]
    if (e.progression) bits.push(`  progression: ${e.progression}`)
    if (e.superset_with) bits.push(`  superset with: ${e.superset_with}`)
    if (e.note) bits.push(`  their note: ${e.note}`)
    return bits.join('\n')
  }).join('\n')

  return head.join('\n') + '\n\nExercises, in the order they are trained:\n' + (body || '- none')
}

export function renderPRs(prs, unit) {
  if (!prs || !prs.length) return ''
  return 'Best estimated 1RMs:\n' +
    prs.map(p => `- ${p.name}: ${fmtNum(p.est_1rm)} ${unit} (estimated from ${p.from} on ${p.on})`).join('\n')
}
