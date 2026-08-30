// The tools the model can call, executed here in the browser.
//
// This is what keeps the 1,324-exercise catalogue out of the prompt. Serialised down to
// id|name|equipment|target it is still ~18k tokens, which would be paid for on every single
// turn of every conversation; one muscle group is 200 bytes to 7 kB. So the model searches
// instead of being handed the library.
//
// The second thing it buys is worth more: **the ids cannot be invented**. Every id the model
// writes into a routine came back from a search over the real catalogue. parsePlan would drop a
// hallucinated id anyway, but silently — a routine would just arrive one exercise short.
import { allExercises, searchScore, EXIDX } from '../exercises.js'
import { exAvailable, activeProfile, ALL_EQUIPMENT } from '../equipment.js'
import { matchesMuscleGroups, musclesOf, MUSCLES, MUSCLE_NAME } from '../muscles.js'
import { exerciseNameFor } from '../i18n-core.js'
import { BODYPARTS } from '../exercises.js'

/** Hard cap on what one search returns, whatever the model asks for. */
export const SEARCH_CAP = 25

/**
 * Match a loose equipment word against the vocabulary the catalogue actually uses.
 *
 * This used to be an exact string comparison, and that made the tool a trap. "dumbbells",
 * "Dumbbell", "machine", "cables" and "cable machine" are all things a model reasonably writes,
 * and every one of them matched nothing at all — so the search came back empty, the model tried
 * another wording, got nothing again, and the entire step budget went on searches that could
 * never have succeeded. From the outside that looks like "it kept searching and never settled".
 *
 * @returns {string[]|null} equipment values to accept, or null when nothing plausible matches
 */
export function resolveEquipment(value) {
  const norm = v => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '').replace(/s$/, '')
  const want = norm(value)
  if (!want) return null
  // Both directions: "cable machine" contains the known "cable", and the known "leverage
  // machine" contains the asked-for "machine".
  const hits = ALL_EQUIPMENT.filter(e => {
    const k = norm(e)
    return k === want || k.includes(want) || want.includes(k)
  })
  return hits.length ? hits : null
}

const view = ex => ({
  id: ex.id,
  name: exerciseNameFor(ex),
  body_part: ex.bp || null,
  target: ex.tg || null,
  equipment: ex.eq || null
})

/**
 * Search the catalogue the way the exercise picker does.
 *
 * Filters first (they are cheap and exact), then ranks whatever is left by the same fuzzy score
 * the picker uses, so "remada" and "row" both land on rows.
 */
export function searchExercises(S, { query, muscle, equipment, body_part: bodyPart, limit } = {}) {
  const cap = Math.max(1, Math.min(SEARCH_CAP, Math.round(Number(limit)) || SEARCH_CAP))
  // An unrecognisable equipment word is dropped as a FILTER rather than used as one: filtering on
  // it guarantees nothing comes back, which teaches the model nothing and costs a whole turn.
  const kit = equipment ? resolveEquipment(equipment) : null

  const pool = allExercises(S).filter(ex =>
    // The equipment profile is the user's own answer to "what can I actually use", so a search
    // that ignored it would propose a routine they cannot train.
    exAvailable(S, ex) &&
    (!bodyPart || ex.bp === bodyPart) &&
    (!kit || kit.includes(ex.eq)) &&
    (!muscle || matchesMuscleGroups(ex, muscle))
  )

  // How much the exercise ACTUALLY trains the muscle that was asked for, by the app's own
  // model. matchesMuscleGroups alone is too loose to pick exercises with: it counts secondary
  // involvement, so a search for chest returns the dumbbell arnold press — right for the muscle
  // map, wrong for building a chest day. Ranking by the weight puts the real work first, and
  // the cap then cuts the incidental stuff off the end.
  const pull = ex => (muscle ? (musclesOf(ex)[muscle] || 0) : 1)
  const rank = ex => (query ? searchScore(ex, query) : 1) * (muscle ? 0.25 + pull(ex) : 1)

  return pool
    .map(ex => ({ ex, score: rank(ex) }))
    .filter(x => x.score > 0 && (!query || searchScore(x.ex, query) > 0))
    .sort((a, b) => b.score - a.score)
    .slice(0, cap)
    .map(x => view(x.ex))
}

/** Look up exercises the model already has ids for — cheaper and exact, no searching. */
export function getExercises(S, { ids } = {}) {
  const list = Array.isArray(ids) ? ids : []
  const custom = new Map((S.customEx || []).map(c => [c.id, c]))
  return list.slice(0, SEARCH_CAP).map(id => {
    const ex = custom.get(id) || EXIDX[id]
    return ex ? view(ex) : { id, name: null, missing: true }
  })
}

/* ---------------------------------- declarations ---------------------------------- */

// Deliberately the restricted JSON Schema subset all three providers accept literally: type,
// description, enum, items, properties, required. Anything richer works on two of them and
// 400s on the third, which is the worst way to find out.
const SEARCH_SCHEMA = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'Free text, e.g. "incline dumbbell press". Optional if a filter is given.' },
    muscle: { type: 'string', enum: [...MUSCLES], description: 'Canonical muscle slug the exercise should train.' },
    // Spelled out rather than described. The description said "exact name" and the model wrote
    // "dumbbells" anyway, which is what a description gets you and an enum does not.
    equipment: { type: 'string', enum: [...ALL_EQUIPMENT], description: 'Equipment the exercise uses.' },
    body_part: { type: 'string', enum: [...BODYPARTS], description: 'Broad region of the body.' },
    limit: { type: 'integer', description: `How many to return, at most ${SEARCH_CAP}.` }
  },
  required: [],
  additionalProperties: false
}

const GET_SCHEMA = {
  type: 'object',
  properties: {
    ids: { type: 'array', items: { type: 'string' }, description: 'Exercise ids to look up.' }
  },
  required: ['ids'],
  additionalProperties: false
}

/** The tool declarations, with the muscle vocabulary spelled out so the model uses ours. */
export const EXERCISE_TOOLS = [
  {
    name: 'search_exercises',
    description:
      'Search the exercise library this app ships. Returns at most ' + SEARCH_CAP + ' matches, ' +
      'already filtered to the equipment the user actually has. Every id you put in a routine ' +
      'MUST come from a result of this tool — ids you invent are dropped and the exercise ' +
      'silently goes missing. Muscle slugs: ' +
      MUSCLES.map(m => `${m} (${MUSCLE_NAME[m]})`).join(', ') + '.',
    schema: SEARCH_SCHEMA
  },
  {
    name: 'get_exercises',
    description: 'Look up exercises by id, for ids you already have. Cheaper than searching again.',
    schema: GET_SCHEMA
  }
]

/**
 * A search, as the model sees it.
 *
 * An empty array is the least useful answer a tool can give: it says nothing about WHY, so the
 * model reasonably assumes it phrased the query badly and tries again, and again, until the run
 * is out of steps. Saying what was actually filtered on turns a dead end into something it can
 * act on in one turn.
 */
function searchResult(S, input) {
  const results = searchExercises(S, input)
  if (results.length) return { count: results.length, results }

  const why = []
  if (input.equipment && !resolveEquipment(input.equipment)) {
    why.push(`"${input.equipment}" is not equipment this library knows, so it was ignored`)
  }
  if (input.body_part && !BODYPARTS.includes(input.body_part)) {
    why.push(`"${input.body_part}" is not a body part here — use one of: ${BODYPARTS.join(', ')}`)
  }
  if (input.muscle && !MUSCLES.includes(input.muscle)) {
    why.push(`"${input.muscle}" is not a muscle slug here — use one of: ${MUSCLES.join(', ')}`)
  }
  if (activeProfile(S)) {
    why.push('their equipment profile is limiting what is available')
  }
  if (input.query) why.push(`no exercise matches "${input.query}"; try a broader word, or drop it and filter by muscle instead`)

  return {
    count: 0,
    results: [],
    note: why.length ? why.join('. ') : 'nothing matched those filters together — try fewer of them at once'
  }
}

/** Bind the tools to a state, ready for run()'s `toolbox`. */
export const exerciseToolbox = S => ({
  search_exercises: input => searchResult(S, input || {}),
  get_exercises: input => getExercises(S, input || {})
})
