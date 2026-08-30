// Turning a model's answer into a plan the app will accept.
//
// This is the only place in the feature where an LLM's output becomes data the user keeps, so it
// is the only place that really has to be paranoid. Three layers, in order:
//
//   1. The output SCHEMA constrains the shape at the provider (structured outputs).
//   2. `toPlanBundle` here clamps every number and drops anything it does not recognise.
//   3. `parsePlan` (lib/plan-share.js) then validates it as what it is — a plan file from
//      somewhere else — and drops exercise ids that resolve to nothing.
//
// Layer 2 exists because layer 1 is a promise and layer 3 checks a different thing: parsePlan
// happily passes `sets: 9999` through, because a hand-written plan file has never had a reason
// to lie about that. A model does.
//
// Nothing here writes. The caller shows a preview, and mergePlan runs only if a person agrees.
import { uid } from '../format.js'
import { MAX_PLANNED_WARMUPS } from '../history.js'
import { parsePlan } from '../plan-share.js'

/** Ceilings a routine has to stay under. Generous enough to never bite a sane plan. */
export const LIMITS = {
  routines: 7,          // one per weekday, at most
  exercises: 15,        // per routine
  sets: 10,
  reps: 50,
  nameChars: 40,
  noteChars: 200
}

const clampInt = (v, lo, hi, fallback) => {
  // null and '' have to be caught before Number() sees them: Number(null) is 0, which is finite,
  // so a field the model simply left out would clamp to the FLOOR instead of falling back — a
  // missing rep count would arrive as 1 rep rather than the sensible default.
  if (v == null || v === '') return fallback
  const n = Math.round(Number(v))
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback
}

const clean = (s, max) => String(s == null ? '' : s).trim().slice(0, max)

/**
 * The JSON Schema the model answers with.
 *
 * Deliberately narrow: id, sets, reps and an optional note. No mode, no progression policy, no
 * intensifier, no per-side flag. Every one of those is a field the app can get right on its own
 * from the exercise and the user's defaults, and every one is a field a model can get subtly
 * wrong in a way nobody notices until they are under the bar. The plan is the shape of the
 * training week; the details stay with the app.
 *
 * Only the subset all three providers accept literally — no minimum/maximum (clamped in code
 * instead), no oneOf, no $ref.
 */
export const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Short name for the whole plan, in the user language.' },
    summary: { type: 'string', description: 'Two or three sentences: what this plan is and why it suits them. User language.' },
    routines: {
      type: 'array',
      description: `The training days. At most ${LIMITS.routines}.`,
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name of the day, in the user language, e.g. "Peito e tríceps".' },
          weekday: {
            type: 'integer',
            description: 'Day of the week: 0 Sunday, 1 Monday … 6 Saturday. Use -1 for a routine that is not on the schedule.'
          },
          exercises: {
            type: 'array',
            description: `In the order they should be trained. At most ${LIMITS.exercises}.`,
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Exercise id, exactly as returned by search_exercises. Never invent one.' },
                sets: { type: 'integer', description: 'Working sets.' },
                reps: { type: 'integer', description: 'Reps per set.' },
                note: { type: 'string', description: 'Optional short cue, in the user language.' }
              },
              required: ['id', 'sets', 'reps'],
              additionalProperties: false
            }
          }
        },
        required: ['name', 'weekday', 'exercises'],
        additionalProperties: false
      }
    }
  },
  required: ['name', 'summary', 'routines'],
  additionalProperties: false
}

/**
 * Model answer → openGym plan bundle (the same shape `buildPlanBundle` exports).
 *
 * Everything is clamped or dropped here; nothing is trusted. Returns null for an answer that is
 * not even the right shape, so the caller can say "that did not work" rather than showing an
 * empty preview.
 */
export function toPlanBundle(answer) {
  if (!answer || !Array.isArray(answer.routines)) return null

  const week = {}
  const routines = answer.routines.slice(0, LIMITS.routines).map(r => {
    const id = uid()
    // -1, absent, or a duplicate weekday all mean the same thing: available, not scheduled.
    // A duplicate would otherwise silently overwrite the earlier routine on that day.
    const day = clampInt(r?.weekday, -1, 6, -1)
    if (day >= 0 && !week[day]) week[day] = id

    return {
      id,
      name: clean(r?.name, LIMITS.nameChars) || 'Routine',
      // No `emoji`. glyphOf() already answers a missing one with the default, and importing
      // glyphs.js for that one constant would drag components/Icon.jsx in and cost this module
      // its ability to load outside Vite.
      ex: (Array.isArray(r?.exercises) ? r.exercises : [])
        .slice(0, LIMITS.exercises)
        .filter(e => e && typeof e.id === 'string' && e.id)
        .map(e => {
          const out = {
            id: e.id,
            sets: clampInt(e.sets, 1, LIMITS.sets, 3),
            reps: clampInt(e.reps, 1, LIMITS.reps, 10),
            // Never a weight. The first session's weight is the progression engine's job, and a
            // number guessed by a model is a number somebody loads onto a bar.
            weight: 0
          }
          const note = clean(e.note, LIMITS.noteChars)
          if (note) out.note = note
          return out
        })
    }
  }).filter(r => r.ex.length)

  if (!routines.length) return null

  // Drop schedule entries whose routine did not survive having no exercises.
  const live = new Set(routines.map(r => r.id))
  for (const d of Object.keys(week)) if (!live.has(week[d])) delete week[d]

  return {
    opengym_plan: 1,
    exported: new Date().toISOString().slice(0, 10),
    name: clean(answer.name, LIMITS.nameChars),
    summary: clean(answer.summary, 600),
    week,
    routines,
    customEx: []
  }
}

/**
 * The full gauntlet: clamp, then hand it to the app's own plan-file parser.
 *
 * `parsePlan` is what resolves the exercise ids, and it drops the ones it cannot — so `dropped`
 * is the count of exercises the model named that do not exist. That number belongs in front of
 * the user: a plan that lost three exercises is not the plan they were shown a summary of.
 *
 * @returns {{ bundle, summary, dropped, routineCount, exerciseCount, scheduledDays } | null}
 */
export function planFromAnswer(answer) {
  const bundle = toPlanBundle(answer)
  if (!bundle) return null
  let parsed
  try { parsed = parsePlan(bundle) } catch { return null }

  // A routine can arrive here empty even though toPlanBundle rejected empty ones: parsePlan
  // drops unresolvable ids, so a day whose every exercise was invented survives as a routine
  // with nothing in it. Importing that gives somebody an empty day in their week, and the
  // preview would have counted it as a routine. Drop them, then recount from what is left.
  const routines = parsed.routines.filter(r => (r.ex || []).length)
  if (!routines.length) return null
  const live = new Set(routines.map(r => r.id))
  const week = Object.fromEntries(Object.entries(parsed.week || {}).filter(([, id]) => live.has(id)))

  return {
    bundle: { ...bundle, routines, week },
    summary: bundle.summary,
    dropped: parsed.dropped,
    routineCount: routines.length,
    exerciseCount: routines.reduce((n, r) => n + r.ex.length, 0),
    scheduledDays: Object.keys(week).length
  }
}

/**
 * The narrower schema for filling in ONE routine that already exists.
 *
 * No name and no weekday: the routine already has both, and letting a model rename the thing
 * the user just named would be a surprise, not a feature. Same fields per exercise as the
 * full plan, for the same reasons.
 */
export const ROUTINE_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'One or two sentences on why these exercises, in the user language.' },
    exercises: PLAN_SCHEMA.properties.routines.items.properties.exercises
  },
  required: ['summary', 'exercises'],
  additionalProperties: false
}

/**
 * Model answer -> the `ex` list of one routine.
 *
 * Runs the identical gauntlet the full plan does, by being one: clamped by toPlanBundle, then
 * resolved by parsePlan. Reusing it rather than repeating it is the point — the clamps and the
 * id resolution are the part that must not drift between the two entry points.
 *
 * @returns {{ ex: Array, summary: string, dropped: number } | null}
 */
export function exercisesFromAnswer(answer) {
  if (!answer || !Array.isArray(answer.exercises)) return null
  const plan = planFromAnswer({
    name: '',
    summary: answer.summary,
    routines: [{ name: 'x', weekday: -1, exercises: answer.exercises }]
  })
  if (!plan) return null
  return { ex: plan.bundle.routines[0].ex, summary: plan.summary, dropped: plan.dropped }
}

/** One exercise, for swapping a single suggestion out. Same item shape as everywhere else. */
export const ONE_EXERCISE_SCHEMA = {
  type: 'object',
  properties: {
    reason: { type: 'string', description: 'One short sentence on why this one instead, in the user language.' },
    exercise: PLAN_SCHEMA.properties.routines.items.properties.exercises.items
  },
  required: ['reason', 'exercise'],
  additionalProperties: false
}

/**
 * Model answer -> one clamped, resolved exercise.
 *
 * Through the same gauntlet as everything else, by being a routine of one. Returns null when the
 * id does not resolve, which is the case the caller has to handle: a swap that produced nothing
 * must leave the original in place rather than blanking the row.
 *
 * @returns {{ ex: object, reason: string } | null}
 */
export function exerciseFromAnswer(answer) {
  if (!answer || !answer.exercise) return null
  const r = exercisesFromAnswer({ summary: answer.reason, exercises: [answer.exercise] })
  return r && r.ex.length ? { ex: r.ex[0], reason: r.summary } : null
}

/** Planned warm-ups are not part of the generated shape; named so the ceiling is visible here too. */
export const WARMUP_CEILING = MAX_PLANNED_WARMUPS
