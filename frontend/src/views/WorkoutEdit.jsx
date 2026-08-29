import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { exOr, EXIDX } from '../lib/exercises.js'
import { historyBefore, buildSets, freestyleConfig, defaultConfig, applyIntensifierPlan } from '../lib/history.js'
import { defaultIncrement } from '../lib/progression.js'
import { exerciseMuscleSnapshot } from '../lib/muscles.js'
import { fmtDate, durPart, uid } from '../lib/format.js'
import { t, exerciseNameFor } from '../lib/i18n.js'
import { setSetField, appendSet, popSet, appendWarmup, dropSetAt, normalizeEditedWorkout, commitWorkoutEdit } from '../lib/edit-workout.js'
import { exercisePicker, exConfigSheet, confirmSheet } from '../sheets.jsx'
import ExerciseBlock from '../components/ExerciseBlock.jsx'
import Icon from '../components/Icon.jsx'
import { Button, Stepper } from '../components/ui.jsx'

const clone = x => JSON.parse(JSON.stringify(x))

/**
 * A working copy of a stored workout.
 *
 * `_k` is a stable handle per entry: React needs one that survives adding and removing rows, and
 * normalizeEditedWorkout needs it to match an entry back to how it was stored — which is how
 * `topW`, the muscle snapshot and the target of an untouched entry come through byte for byte.
 */
const makeDraft = rec => ({
  ...clone(rec),
  entries: (rec.entries || []).map((e, i) => ({ ...clone(e), _k: 'k' + i })),
  durMin: Math.max(0, Math.round(((rec.end || rec.start) - rec.start) / 60000)),
})

export default function WorkoutEdit() {
  const nav = useNavigate()
  const { id } = useParams()
  const S = useStore(s => s.S)
  const update = useStore(s => s.update)
  const toast = useUI(s => s.toast)
  // Looked up fresh on every render and never captured: `update` clones the whole state, so a
  // reference held from the first render would be detached from the store the moment we save.
  const rec = S.workouts.find(w => w.id === id)
  const original = useRef(rec ? clone(rec) : null)
  const [draft, setDraft] = useState(() => (rec ? makeDraft(rec) : null))
  const [touched, setTouched] = useState(false)
  // The history as it stood before this session, so "Last time", "Best:" and the pinned note
  // quote what you knew walking in — and the workout being edited never quotes itself.
  const histSrc = useMemo(() => historyBefore(S, draft?.d), [S, draft?.d])
  // The detail sheet can delete the very record this screen is editing.
  useEffect(() => { if (!rec) nav('/history', { replace: true }) }, [!!rec])
  if (!draft || !rec) return null

  const atEntry = (idx, fn) => setDraft(d => ({ ...d, entries: d.entries.map((e, i) => (i === idx ? fn(e) : e)) }))
  const edit = fn => { fn(); setTouched(true) }
  const mutSet = (idx, i, fn) => edit(() => atEntry(idx, e => ({ ...e, sets: e.sets.map((s, k) => (k === i ? fn(s) : s)) })))
  const setField = (idx, i, f, v) => edit(() => atEntry(idx, e => setSetField(e, i, f, v)))
  const addSet = idx => edit(() => atEntry(idx, appendSet))
  const removeSet = idx => edit(() => atEntry(idx, popSet))
  // Checked by default: a warm-up added while filling in history is one that happened.
  const addWarmup = idx => edit(() => atEntry(idx, e => appendWarmup(e, defaultIncrement(e.id, S.unit), { done: true })))
  const removeSetAt = (idx, i) => edit(() => atEntry(idx, e => dropSetAt(e, i)))
  // A plain field write. None of the live session's toggle flow — rest timer, superset
  // navigation, the working-weight sheet, the finish prompt — belongs in an editor.
  const toggle = (idx, i) => setField(idx, i, 'done', !draft.entries[idx].sets[i].done)
  const setDuration = v => edit(() => setDraft(d => ({ ...d, durMin: Math.max(0, Math.round(v || 0)) })))

  const addExercise = () => exercisePicker(ex => {
    const seed = freestyleConfig(histSrc, { id: ex.id, ...defaultConfig(ex.id) })
    exConfigSheet(ex, null, cfg => {
      const full = { ...cfg, id: ex.id }
      // Seeded from before this day, and no `plan`: the prescription for a session that already
      // happened is not a thing to explain. Rows arrive checked, because an exercise added to
      // history is one you did — an unchecked row is invisible in the detail sheet, counts for
      // nothing in the volume, and would be dropped again on save.
      const sets = applyIntensifierPlan(buildSets(histSrc, full, { step: defaultIncrement(ex.id, S.unit), preferLast: true }), full)
        .map(s => ({ ...s, done: true }))
      edit(() => setDraft(d => ({ ...d, entries: [...d.entries, { id: ex.id, target: { ...cfg }, sets, topW: null, _k: 'n' + uid() }] })))
    }, null, null, seed, { saveLabel: t('Add exercise') })
  })

  const removeExercise = idx => confirmSheet({
    title: t('Remove {0}?', exerciseNameFor(exOr(draft.entries[idx].id))),
    message: t('The sets you logged for this exercise in this session will be lost.'),
    confirmText: t('Remove'), danger: true,
    onConfirm: () => edit(() => setDraft(d => ({ ...d, entries: d.entries.filter((_, i) => i !== idx) }))),
  })

  const deleteWorkout = () => {
    update(s => { s.workouts = s.workouts.filter(w => w.id !== id) })
    nav('/history', { replace: true })
    toast(t('Workout deleted'))
  }

  const save = () => {
    const edited = normalizeEditedWorkout(draft, original.current, {
      snapshotFor: e => (EXIDX[e.id]?.custom ? exerciseMuscleSnapshot(EXIDX[e.id]) : null),
    })
    // Everything unchecked. Storing that would be a workout the finish flow could never produce.
    if (!edited.entries.length) {
      confirmSheet({
        title: t('Nothing logged yet'), message: t('This removes it from your history for good.'),
        confirmText: t('Delete'), danger: true, onConfirm: deleteWorkout,
      })
      return
    }
    // One update: the record goes back in its slot and the three values a finish froze — volume,
    // trophies, and the working-weight suggestion it fed — are repaired together.
    update(s => {
      const next = commitWorkoutEdit(s, edited)
      s.workouts = next.workouts
      s.exWeights = next.exWeights
    })
    useStore.getState().autoBackupNow()
    toast(t('Workout updated'))
    nav(-1)
  }

  const leave = () => (touched ? confirmSheet({
    title: t('Discard changes?'), message: t('Your edits to this workout will be lost.'),
    confirmText: t('Discard'), danger: true, onConfirm: () => nav(-1),
  }) : nav(-1))

  return <div className="narrow">
    <div className="hdr">
      <button className="iconbtn" aria-label={t('Cancel')} onClick={leave}><Icon name="chevronLeft" /></button>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontWeight: 600 }}>{t('Edit workout')}</div>
        <div className="sub">{draft.name} · {fmtDate(draft.d, true)}</div>
      </div>
      <button className="iconbtn" style={{ color: 'var(--acc)' }} aria-label={t('Save')} onClick={save}><Icon name="check" /></button>
    </div>

    <div className="card">
      <Stepper label={t('Duration (min)')} value={draft.durMin} step={5} decimal={false} onChange={setDuration} />
      {/* Zero reads as no clock at all, the way an imported session does — not as "0 min". */}
      <div className="small dim" style={{ marginTop: 6 }}>{durPart(draft.durMin * 60000)[0] || '—'}</div>
    </div>

    {/* Stacked rather than the session's one-at-a-time pager: that exists because you are mid-set
        with one hand, which is the wrong shape at a desk, and paging would move the ground under
        every edit. */}
    {draft.entries.map((e, idx) => <div className="card" key={e._k}>
      <ExerciseBlock
        entry={e} histSrc={histSrc} compact allowTimer={false}
        onMutSet={(i, fn) => mutSet(idx, i, fn)}
        onToggle={i => toggle(idx, i)}
        onField={(i, f, v) => setField(idx, i, f, v)}
        onAddSet={() => addSet(idx)} onRemoveSet={() => removeSet(idx)}
        onAddWarmup={() => addWarmup(idx)} onRemoveSetAt={i => removeSetAt(idx, i)} />
      <div style={{ height: 10 }} />
      <Button size="sm" variant="ghost" icon="minus" style={{ color: 'var(--red)' }}
        onClick={() => removeExercise(idx)}>{t('Remove exercise')}</Button>
    </div>)}

    {!draft.entries.length && <div className="empty">{t('Nothing logged yet')}</div>}

    <Button icon="plus" onClick={addExercise}>{t('Add exercise')}</Button>
    <div style={{ height: 14 }} />
    <Button variant="primary" onClick={save}>{t('Save')}</Button>
    <div style={{ height: 8 }} />
    <Button variant="ghost" className="dim" onClick={leave}>{t('Cancel')}</Button>
  </div>
}
