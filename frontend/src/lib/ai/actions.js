// The things the app actually asks for, assembled from the pieces.
//
// Each one is a pure function returning a request — system prompt, messages, tools, ceiling — so
// what gets sent is testable without a network, a key, or a provider. The view adds `provider`
// and `model` and hands the whole thing to run().
import {
  workoutContext, routineContext, profileContext, prContext,
  renderWorkout, renderRoutine, renderProfile, renderPRs
} from './context.js'
import {
  chatSystem,
  evaluateWorkoutSystem, evaluateWorkoutUser,
  analyseRoutineSystem, analyseRoutineUser,
  buildRoutineSystem, buildRoutineUser,
  buildOneRoutineSystem, buildOneRoutineUser,
  replaceExerciseSystem, replaceExerciseUser
} from './prompts.js'
import { userTurn } from './message.js'
import { EXERCISE_TOOLS, exerciseToolbox } from './tools.js'
import { CHAT_TOOLS, chatToolbox, MUSCLE_VOCAB } from './chat-tools.js'
import {
  PLAN_SCHEMA, ROUTINE_SCHEMA, ONE_EXERCISE_SCHEMA,
  planFromAnswer, exercisesFromAnswer, exerciseFromAnswer
} from './plan-gen.js'
import { exOr } from '../exercises.js'
import { exerciseNameFor } from '../i18n-core.js'

// Two things share every ceiling here: the answer, and the model's INVISIBLE reasoning. At 1200
// a reasoning model spent almost all of it thinking and the answer arrived cut off mid-sentence —
// the user saw a truncated paragraph and a bill for tokens they never read. So: room, plus
// `effort` telling the providers that support it not to need much of it.
const VERDICT_TOKENS = 2400

/**
 * Judge one finished session.
 *
 * The session, plus enough context to say anything useful about it. Around 1.5k tokens in — the
 * cheapest thing this feature does, which is why it shipped first.
 *
 * @returns {{system: string, messages: Array, maxTokens: number, effort: string}|null}
 */
export function evaluateWorkoutRequest(S, workout, { ask, lang } = {}) {
  const ctx = workoutContext(S, workout)
  if (!ctx) return null
  return {
    system: evaluateWorkoutSystem(lang),
    messages: [userTurn(evaluateWorkoutUser({
      workout: renderWorkout(ctx),
      profile: renderProfile(profileContext(S)),
      prs: renderPRs(prContext(S, 6), ctx.unit),
      ask
    }))],
    maxTokens: VERDICT_TOKENS,
    effort: 'low'
  }
}

/** Review a routine they already train. No tools: the routine is already in front of it. */
export function analyseRoutineRequest(S, routineId, { ask, lang } = {}) {
  const ctx = routineContext(S, routineId)
  if (!ctx) return null
  return {
    system: analyseRoutineSystem(lang),
    messages: [userTurn(analyseRoutineUser({
      routine: renderRoutine(ctx),
      profile: renderProfile(profileContext(S)),
      prs: renderPRs(prContext(S, 6), ctx.unit),
      ask
    }))],
    maxTokens: VERDICT_TOKENS,
    effort: 'low'
  }
}

/** The tool the finished plan arrives through. Its schema IS the plan schema. */
export const SUBMIT_PLAN_TOOL = {
  name: 'submit_plan',
  description:
    'Submit the finished training week. Call this exactly once, after searching for every ' +
    'exercise you intend to use. Every exercise id must have come from a search_exercises result.',
  schema: PLAN_SCHEMA
}

/**
 * Build a whole training week.
 *
 * The expensive one: the model searches the catalogue two to five times before it answers, and
 * every turn resends the conversation. Still under four cents on a mid-tier model, because what
 * comes back from a search is a couple of kilobytes rather than the 18k-token catalogue.
 *
 * `capture` is filled in by the toolbox when the model calls submit_plan — read `capture.plan`
 * after run() returns.
 *
 * @returns {{request: object, capture: {plan: object|null, raw: object|null}}}
 */
export function buildRoutineRequest(S, { ask, lang } = {}) {
  const capture = { plan: null, raw: null }
  const current = (S.routines || []).length
    ? (S.routines || []).map(r => `- ${r.name} (${(r.ex || []).length} exercises)`).join('\n')
    : null

  return {
    capture,
    request: {
      system: buildRoutineSystem(lang),
      messages: [userTurn(buildRoutineUser({
        profile: renderProfile(profileContext(S)),
        prs: renderPRs(prContext(S, 6), S.unit || 'kg'),
        current,
        ask
      }))],
      tools: [...EXERCISE_TOOLS, SUBMIT_PLAN_TOOL],
      toolbox: {
        ...exerciseToolbox(S),
        submit_plan: input => {
          capture.raw = input
          capture.plan = planFromAnswer(input)
          // What goes back to the model is a receipt, not the plan. It has no reason to see the
          // clamped version, and telling it how many ids were dropped invites a second attempt
          // that costs another round of searches for one missing exercise.
          return capture.plan
            ? { ok: true, routines: capture.plan.routineCount, exercises: capture.plan.exerciseCount }
            : { ok: false, error: 'that plan had no usable exercises — search again and resubmit' }
        }
      },
      // The submit_plan call is the answer; run() ends there rather than paying for a turn
      // whose only content would be the model agreeing that it had submitted a plan.
      stopAfter: SUBMIT_PLAN_TOOL.name,
      // A week is several days, and a day is a search or two. Six round trips ran out before the
      // model had looked at everything it needed to.
      maxSteps: 14,
      maxTokens: 4000,
      effort: 'low'
    }
  }
}

/**
 * A turn of free conversation.
 *
 * `history` is the neutral turns so far, so the whole thread is resent each time — which is what
 * every provider expects and also what makes a long conversation cost more than a short one.
 * The view trims it; see CHAT_TURNS.
 */
export function chatRequest(S, history, { lang } = {}) {
  return {
    system: chatSystem(lang, MUSCLE_VOCAB),
    messages: history,
    tools: CHAT_TOOLS,
    toolbox: chatToolbox(S),
    maxTokens: 2400,
    effort: 'low'
  }
}

/** The tool one routine's exercises arrive through. */
export const SUBMIT_EXERCISES_TOOL = {
  name: 'submit_exercises',
  description:
    'Submit the exercises for this routine. Call this exactly once, after searching for every ' +
    'exercise you intend to use. Every id must have come from a search_exercises result.',
  schema: ROUTINE_SCHEMA
}

/**
 * Fill in one routine that already exists and already has a name.
 *
 * The cheaper sibling of buildRoutineRequest: one day rather than a week, so fewer searches and
 * a smaller answer. Same capture pattern — read `capture.result` after run() returns.
 *
 * @returns {{request: object, capture: {result: object|null, raw: object|null}}}
 */
export function buildOneRoutineRequest(S, { name, ask, lang } = {}) {
  const capture = { result: null, raw: null }
  return {
    capture,
    request: {
      system: buildOneRoutineSystem(lang),
      messages: [userTurn(buildOneRoutineUser({
        name: name || '',
        profile: renderProfile(profileContext(S)),
        prs: renderPRs(prContext(S, 6), S.unit || 'kg'),
        ask
      }))],
      tools: [...EXERCISE_TOOLS, SUBMIT_EXERCISES_TOOL],
      toolbox: {
        ...exerciseToolbox(S),
        submit_exercises: input => {
          capture.raw = input
          capture.result = exercisesFromAnswer(input)
          return capture.result
            ? { ok: true, exercises: capture.result.ex.length }
            : { ok: false, error: 'none of those exercises exist here — search again and resubmit' }
        }
      },
      stopAfter: SUBMIT_EXERCISES_TOOL.name,
      // Five to eight exercises is five to eight searches if the model works one at a time.
      maxSteps: 12,
      maxTokens: 3000,
      effort: 'low'
    }
  }
}

/** The tool a single replacement arrives through. */
export const SUBMIT_EXERCISE_TOOL = {
  name: 'submit_exercise',
  description:
    'Submit the one replacement exercise. Call this exactly once, after searching. The id must ' +
    'have come from a search_exercises result.',
  schema: ONE_EXERCISE_SCHEMA
}

/**
 * Swap one suggested exercise for a different one.
 *
 * The cheapest of the builders by a wide margin: one slot, one or two searches. `keeping` is what
 * stops it handing back something already in the routine — the model cannot see the preview.
 *
 * @returns {{request: object, capture: {result: object|null, raw: object|null}}}
 */
export function replaceExerciseRequest(S, { routineName, replacing, keeping, ask, lang } = {}) {
  const capture = { result: null, raw: null }
  const label = e => `${exerciseNameFor(exOr(e.id))} (${e.sets} x ${e.reps})`

  return {
    capture,
    request: {
      system: replaceExerciseSystem(lang),
      messages: [userTurn(replaceExerciseUser({
        routineName: routineName || '',
        replacing: label(replacing),
        keeping: (keeping || []).map(label).join('\n') || 'none',
        profile: renderProfile(profileContext(S)),
        ask
      }))],
      tools: [...EXERCISE_TOOLS, SUBMIT_EXERCISE_TOOL],
      toolbox: {
        ...exerciseToolbox(S),
        submit_exercise: input => {
          capture.raw = input
          const got = exerciseFromAnswer(input)
          // Handing back the same exercise is the failure worth naming: the user pressed swap and
          // would be shown no change at all, with no way to tell whether it had even run.
          const same = got && (got.ex.id === replacing.id || (keeping || []).some(k => k.id === got.ex.id))
          capture.result = same ? null : got
          return capture.result
            ? { ok: true }
            : { ok: false, error: same ? 'that one is already in the routine — pick a different exercise' : 'that id does not exist here — search again' }
        }
      },
      stopAfter: SUBMIT_EXERCISE_TOOL.name,
      maxSteps: 8,
      maxTokens: 1500,
      effort: 'low'
    }
  }
}
