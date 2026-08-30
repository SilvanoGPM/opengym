// Read-only views of the profile, shaped as tools a model can call in a conversation.
//
// These answer the same questions the MCP server answers (mcp/src/tools.js) — what routines are
// there, how did that session go, what has my chest done this month — and they answer them with
// the SAME underlying functions: history.js, onerm.js, muscles.js, through context.js. So the
// numbers here match the Stats screen and the MCP server, because none of the three does its own
// arithmetic.
//
// What is NOT shared is the tool-shaped wrapper: eight small projections exist twice, once here
// and once in mcp/src/tools.js. Consolidating them means moving that layer into frontend/src/lib
// and having the MCP call it — the direction the two already run in — which is worth doing and is
// not worth doing blind. It is a change to a server with its own suite, so it belongs in a pass
// that can run that suite.
//
// Everything here is read-only. The chat cannot write; the plan builder is the only thing that
// can, and it asks first.
import { workoutContext, routineContext, profileContext, prContext, recentWorkouts } from './context.js'
import { exOr, matchExercise } from '../exercises.js'
import { exerciseNameFor } from '../i18n-core.js'
import { workoutVolume, setsDone, effectiveRoutineId } from '../history.js'
import { best1RM, DEFAULT_FORMULA } from '../onerm.js'
import { loadOfWorkouts, rankOf, levelsOf, MUSCLE_NAME, MUSCLES } from '../muscles.js'
import { DAYN, todayISO } from '../format.js'
import { EXERCISE_TOOLS, exerciseToolbox, searchExercises } from './tools.js'

/** Nothing that lists returns more than this. A conversation resends its history every turn. */
export const LIST_CAP = 20

const round1 = v => Math.round(v * 10) / 10
const nameOf = id => exerciseNameFor(exOr(id))

/* ------------------------------------ readers ------------------------------------ */

export const listRoutines = S => ({
  unit: S.unit || 'kg',
  routines: (S.routines || []).map(r => ({
    id: r.id,
    name: r.name,
    exercises: (r.ex || []).length,
    weekday: (Object.entries(S.week || {}).find(([, id]) => id === r.id) || [])[0] ?? null
  }))
})

export const getRoutine = (S, { routine_id: id } = {}) =>
  routineContext(S, id) || { error: 'no routine with that id — call list_routines first' }

export function getWeekPlan(S) {
  const today = todayISO()
  const byId = Object.fromEntries((S.routines || []).map(r => [r.id, r.name]))
  return {
    today,
    today_routine: byId[effectiveRoutineId(S, today)] || null,
    week: DAYN.map((day, i) => ({ day, routine: byId[(S.week || {})[i]] || null }))
  }
}

export function listWorkouts(S, { limit, from, to } = {}) {
  const cap = Math.max(1, Math.min(LIST_CAP, Math.round(Number(limit)) || 10))
  // Newest first is what a question about "recently" means, but S.workouts is oldest-first and
  // that order is load-bearing elsewhere — so copy before reversing, never sort in place.
  const rows = (S.workouts || []).slice()
    .filter(w => (!from || w.d >= from) && (!to || w.d <= to))
    .reverse()
    .slice(0, cap)
  return {
    unit: S.unit || 'kg',
    total: (S.workouts || []).length,
    workouts: rows.map(w => ({
      id: w.id,
      date: w.d,
      name: w.name || null,
      sets_done: setsDone(w),
      volume: round1(workoutVolume(w)),
      duration_min: w.end && w.start ? Math.round((w.end - w.start) / 60000) : null,
      personal_records: (w.prs || []).map(nameOf)
    }))
  }
}

export function getWorkout(S, { workout_id: id, date } = {}) {
  if (id) return workoutContext(S, id) || { error: 'no session with that id' }
  const sameDay = (S.workouts || []).filter(w => w.d === date)
  if (!sameDay.length) return { error: 'no session logged on that date' }
  // Two sessions in a day is a real thing; picking one of them silently would answer about the
  // wrong workout. The MCP server hands back the ids for the same reason.
  if (sameDay.length > 1) {
    return { ambiguous: true, workouts: sameDay.map(w => ({ id: w.id, name: w.name, sets_done: setsDone(w) })) }
  }
  return workoutContext(S, sameDay[0])
}

export function getBodyweight(S, { limit } = {}) {
  const cap = Math.max(1, Math.min(LIST_CAP, Math.round(Number(limit)) || 10))
  const all = (S.bodyweight || []).slice()
  const rows = all.slice(-cap)
  const latest = all[all.length - 1] || null
  return {
    unit: S.unit || 'kg',
    latest: latest ? { weight: latest.w, on: latest.d } : null,
    goal: S.targetW || null,
    delta_vs_goal: latest && S.targetW ? round1(latest.w - S.targetW) : null,
    weigh_ins: rows.map(b => ({ date: b.d, weight: b.w }))
  }
}

/**
 * The exercises they have ACTUALLY logged — typically a dozen or two, not 1,324.
 *
 * This is the set almost every question about their own training is really about, and it is the
 * set the exercise-library search does not know: searching the catalogue for "bench press"
 * returns the canonical barbell bench press whether or not they have ever done it.
 */
export function trainedExercises(S, { query } = {}) {
  const seen = new Map()
  for (const w of S.workouts || []) {
    for (const e of w.entries || []) {
      const row = seen.get(e.id) || { id: e.id, ex: exOr(e.id), sessions: 0, last: null }
      row.sessions++
      if (!row.last || w.d > row.last) row.last = w.d
      seen.set(e.id, row)
    }
  }
  const rows = [...seen.values()]
  return query ? rows.filter(r => matchExercise(r.ex, query)) : rows
}

export function listTrainedExercises(S, { query } = {}) {
  const rows = trainedExercises(S, { query })
  return {
    query: query || null,
    count: rows.length,
    exercises: rows
      .sort((a, b) => (b.last || '').localeCompare(a.last || ''))
      .slice(0, LIST_CAP)
      .map(r => ({ id: r.id, name: nameOf(r.id), sessions: r.sessions, last_trained: r.last })),
    note: rows.length ? undefined
      : (query
        ? `nothing they have trained matches "${query}" — try a broader word, or call this with no query to see everything they do`
        : 'they have not logged any workouts yet')
  }
}

const oneRM = (S, id) => {
  const best = best1RM(S, id, DEFAULT_FORMULA)
  return {
    exercise: nameOf(id),
    exercise_id: id,
    estimate: best ? round1(best.est) : null,
    ...(best ? { from: `${best.w} x ${best.r}`, on: best.d } : {})
  }
}

export function estimate1RMTool(S, { exercise_id: id, exercise } = {}) {
  /* A question about a MOVEMENT, not one catalogue entry.

     This exists because the id-only version answered "no PR for barbell bench press" to somebody
     who benches every week — on a decline bar and a seated dumbbell press, neither of which is
     id 0025. The model had searched the LIBRARY, which knows every exercise that exists rather
     than the fifteen they do. Matching over their own history is the only way that question has
     a right answer. */
  if (exercise && !id) {
    const hits = trainedExercises(S, { query: exercise })
    if (!hits.length) {
      return {
        query: exercise,
        matched: [],
        note: `they have never logged anything matching "${exercise}" — call list_trained_exercises to see what they do train`
      }
    }
    const rows = hits.map(h => oneRM(S, h.id)).sort((a, b) => (b.estimate || 0) - (a.estimate || 0))
    return {
      query: exercise,
      unit: S.unit || 'kg',
      matched: rows,
      note: rows.some(r => r.estimate != null) ? undefined
        : 'they have trained these, but no completed set produces an estimate ' +
          '(bodyweight work, or only high-rep sets — an estimate past 12 reps would be work capacity, not strength)'
    }
  }

  if (!id) return { unit: S.unit || 'kg', best: prContext(S, LIST_CAP) }

  const row = oneRM(S, id)
  if (row.estimate != null) return { unit: S.unit || 'kg', ...row }

  // An id with no estimate is the answer that misled somebody once already. Two different
  // things produce it, and they deserve different replies: an exercise they have logged but
  // never in a rep range an estimate is honest about, and an exercise they have simply never
  // done — usually because the id came from the library rather than from their log.
  const trained = trainedExercises(S).some(x => x.id === id)
  return {
    ...row,
    reason: trained
      ? 'they have trained this, but no completed set produces an estimate (bodyweight work, or only high-rep sets)'
      : 'they have never logged this exercise. If the question was about a MOVEMENT rather than this exact ' +
        'catalogue entry, call estimate_1rm again with `exercise` set to a plain word for it'
  }
}

export function muscleBalance(S, { period } = {}) {
  const weeks = period === 'week' ? 1 : period === 'month' ? 4 : 520
  const recent = recentWorkouts(S, weeks)
  const load = loadOfWorkouts(recent)
  const { worked, missed } = rankOf(load)
  const levels = levelsOf(load)
  return {
    period: period || 'all',
    sessions: recent.length,
    worked: worked.map(m => ({ muscle: MUSCLE_NAME[m] || m, level: levels[m], effective_sets: round1(load[m] || 0) })),
    neglected: missed.map(m => MUSCLE_NAME[m] || m)
  }
}

/* --------------------------------- declarations --------------------------------- */

const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false })

export const CHAT_TOOLS = [
  ...EXERCISE_TOOLS,
  { name: 'list_routines', description: 'The routines in their plan, with ids and how many exercises each has.', schema: obj({}) },
  {
    name: 'get_routine',
    description: 'One routine in full: every exercise, its sets and reps, its progression rule, and how often it has been trained.',
    schema: obj({ routine_id: { type: 'string', description: 'From list_routines.' } }, ['routine_id'])
  },
  { name: 'get_week_plan', description: 'What is planned on each weekday, and what today is.', schema: obj({}) },
  {
    name: 'list_workouts',
    description: `Finished sessions, newest first, with volume, sets and PRs. At most ${LIST_CAP}.`,
    schema: obj({
      limit: { type: 'integer', description: `How many, at most ${LIST_CAP}.` },
      from: { type: 'string', description: 'ISO date, inclusive.' },
      to: { type: 'string', description: 'ISO date, inclusive.' }
    })
  },
  {
    name: 'get_workout',
    description: 'One session set by set. Give a workout_id, or a date. A date with two sessions returns both ids to choose from.',
    schema: obj({
      workout_id: { type: 'string' },
      date: { type: 'string', description: 'ISO date, e.g. 2026-08-28.' }
    })
  },
  {
    name: 'get_bodyweight',
    description: 'Weigh-ins, the latest weight, the goal, and the gap to it.',
    schema: obj({ limit: { type: 'integer' } })
  },
  {
    name: 'list_trained_exercises',
    description:
      'What they have ACTUALLY trained, with how often and when last. This is a dozen or two ' +
      'exercises, not the 1,324 in the library — and it is what almost every question about their ' +
      'own training is really about. Optionally filtered by a plain word, in any language.',
    schema: obj({ query: { type: 'string', description: 'e.g. "bench", "supino", "curl". Omit for everything.' } })
  },
  {
    name: 'estimate_1rm',
    description:
      'Best estimated 1RM. Give `exercise` — a plain word for the movement, in any language — and it ' +
      'matches against what they have actually trained and reports every variation. That is what ' +
      'you want for "what is my bench PR": they may never have done the one exercise the library ' +
      'calls a bench press, while benching every week on a decline bar. Give `exercise_id` only ' +
      'for one exact entry. Give neither for the whole table.',
    schema: obj({
      exercise: {
        type: 'string',
        description:
          'A word for the MOVEMENT, e.g. "bench press", "supino", "curl". Prefer that to a muscle ' +
          'name: matching covers secondary muscles too, so "biceps" also reaches every row ' +
          'and pulldown. For a muscle, muscle_balance is the better question.'
      },
      exercise_id: { type: 'string', description: 'One exact exercise. Prefer `exercise` unless you have a specific id from their log.' }
    })
  },
  {
    name: 'muscle_balance',
    description: 'Which muscles have been trained and which have been neglected, over a window.',
    schema: obj({ period: { type: 'string', enum: ['week', 'month', 'all'] } })
  }
]

/** Bind every chat tool to a state, ready for run()'s `toolbox`. */
export const chatToolbox = S => ({
  ...exerciseToolbox(S),
  list_routines: () => listRoutines(S),
  get_routine: i => getRoutine(S, i || {}),
  get_week_plan: () => getWeekPlan(S),
  list_workouts: i => listWorkouts(S, i || {}),
  get_workout: i => getWorkout(S, i || {}),
  get_bodyweight: i => getBodyweight(S, i || {}),
  list_trained_exercises: i => listTrainedExercises(S, i || {}),
  estimate_1rm: i => estimate1RMTool(S, i || {}),
  muscle_balance: i => muscleBalance(S, i || {})
})

/** The muscle vocabulary, for the system prompt. */
export const MUSCLE_VOCAB = MUSCLES.map(m => `${m} (${MUSCLE_NAME[m]})`).join(', ')

export { searchExercises, profileContext }
