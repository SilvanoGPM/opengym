// The admin backup file: reading one, writing one, and saying what restoring it would do.
//
// Kept out of the admin screen because it is the part that can be wrong in a way a person only
// finds out afterwards — a file parsed as the wrong kind, or a "replace" whose cost was not
// shown before it ran. Same reasoning as lib/audit.js, and like that file it is English-only:
// the operator surface stays out of the per-language string packs.

/** Current envelope version. Bumped only if the shape stops being readable by an older parser. */
export const BACKUP_VERSION = 1

/**
 * Wrap a user's state for download.
 *
 * Carries training data and preferences and nothing else — no passkey material, no push
 * subscriptions, no session version. The property worth stating plainly: a user backup cannot be
 * used to impersonate that user. It is handed to an operator, and it is training data.
 */
export function wrapBackup(state, user, { app = '', now = new Date() } = {}) {
  return {
    opengym_backup: BACKUP_VERSION,
    exported: now.toISOString(),
    app,
    user: { id: user?.id || null, name: user?.name || null },
    state,
  }
}

const slug = s => String(s || 'user').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'user'

export function backupFilename(user, iso) {
  return `opengym-${slug(user?.name)}-${user?.id || 'unknown'}-${iso}.json`
}

/**
 * Read a dropped file. Accepts the admin envelope and also the bare `S` object that Settings has
 * always exported, so every backup a user ever made from their own device can be restored here.
 * A plan file is a common mistake and gets its own message rather than a shape complaint.
 */
export function parseBackupFile(text) {
  let raw
  try { raw = JSON.parse(text) } catch { return { ok: false, error: 'That file is not JSON.' } }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'That file is not an openGym backup.' }
  if (raw.opengym_plan) return { ok: false, error: 'That is a shared plan file, not a backup. Plans are imported from Settings.' }
  const state = raw.opengym_backup ? raw.state : raw
  if (!state || typeof state !== 'object' || Array.isArray(state)) return { ok: false, error: 'That backup has no state in it.' }
  if (!Array.isArray(state.workouts) || !Array.isArray(state.routines)) {
    return { ok: false, error: 'That file is not an openGym backup — it has no workouts or routines.' }
  }
  return { ok: true, state, envelope: raw.opengym_backup ? raw : null }
}

/**
 * What restoring would actually do, counted before anyone commits to it.
 *
 * `replaceLoses` is the number that makes "replace is the explicit one" legible: it is how many
 * of the target's own workouts a replace would destroy, which a merge never touches.
 */
export function restorePreview(current, incoming) {
  const cur = current || {}
  const inc = incoming || {}
  const curDays = new Set((cur.workouts || []).map(w => w.d))
  const curBw = new Set((cur.bodyweight || []).map(b => b.d))
  const incWorkouts = inc.workouts || []
  const incBw = inc.bodyweight || []
  const overlap = incWorkouts.filter(w => curDays.has(w.d)).length
  const bwOverlap = incBw.filter(b => curBw.has(b.d)).length
  return {
    workouts: { incoming: incWorkouts.length, overlap, added: incWorkouts.length - overlap },
    bodyweight: { incoming: incBw.length, overlap: bwOverlap, added: incBw.length - bwOverlap },
    routines: { incoming: (inc.routines || []).length },
    replaceLoses: {
      workouts: (cur.workouts || []).length,
      bodyweight: (cur.bodyweight || []).length,
    },
  }
}
