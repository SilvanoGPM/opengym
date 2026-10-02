import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { api } from '../lib/api.js'
import { fmtDate, fmtNum, fmtVol, durPart, todayISO } from '../lib/format.js'
import { setsDone, setLabel } from '../lib/history.js'
import { hasCompletedWork } from '../lib/workout-model.js'
import { speedUnitOf } from '../lib/speed.js'
import { wrapBackup, backupFilename, parseBackupFile, restorePreview } from '../lib/admin-backup.js'
import { parseImport } from '../lib/import-csv.js'
import { EXIDX } from '../lib/exercises.js'
import { exerciseNameFor } from '../lib/i18n.js'
import { confirmSheet } from '../sheets.jsx'
import LineChart from '../components/LineChart.jsx'
import { Thumb } from '../components/Media.jsx'
import { glyphOf } from '../lib/glyphs.js'
import Icon from '../components/Icon.jsx'
import { Button, TextField, Segmented } from '../components/ui.jsx'
import '../admin.css'

// One user, for whoever runs the server. A route rather than a sheet: this carries the history,
// two charts and a set of destructive actions, which is past what a bottom sheet is for — the
// same reason RoutineEdit is a route.
//
// English-only, like the rest of the admin surface (see the header of Admin.jsx).

const rel = ts => {
  if (!ts) return 'never'
  const s = Math.max(0, (Date.now() - ts) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return Math.floor(s / 60) + ' min ago'
  if (s < 86400) return Math.floor(s / 3600) + ' h ago'
  return Math.floor(s / 86400) + ' d ago'
}

const RANGES = [
  { k: '3m', label: '3 months', months: 3 },
  { k: '12m', label: '12 months', months: 12 },
  { k: 'all', label: 'All', months: 0 },
]
const PAGE = 50

// The document comes straight off the user's state file. PUT /api/data drops null and shapeless
// entries now, but a file written before it did still answers with them, and setsDone walks
// entries and sets — so an entry without either has nothing to show and is skipped rather than
// drawn (QA C16: one throw here used to leave the account un-disableable).
const shown = w => !!w && Array.isArray(w.entries) && w.entries.every(e => e && Array.isArray(e.sets))

// One session, opened from the history. The workout arrived with the page — GET /api/admin/user
// returns whole records, without their photos and videos — so this needs no request of its own.
//
// Set labels come from setLabel(), the same function the user's own history uses, so a per-side
// set, a bodyweight set, a timed hold or a run reads here exactly as it reads to them.
function WorkoutSheet({ w, unit, canWrite, onDelete, close }) {
  const done = w.entries.filter(e => e.sets.some(hasCompletedWork))
  const speed = speedUnitOf({ unit })
  return <>
    <h3>{w.name}</h3>
    <div className="muted small" style={{ marginBottom: 12 }}>
      {[fmtDate(w.d, true, true), ...durPart(w.end - w.start), setsDone(w) + ' sets',
        ...(w.vol ? [fmtVol(w.vol, unit)] : []), ...(w.bw ? [fmtNum(w.bw) + ' ' + unit] : [])].join(' · ')}
    </div>
    {done.length ? done.map((e, i) => {
      const ex = EXIDX[e.id]
      return <div key={i} className="row" style={{ marginBottom: 12, alignItems: 'flex-start' }}>
        {ex && <Thumb ex={ex} />}
        <div className="grow">
          <div className="tt capitalize" style={{ fontWeight: 600 }}>
            {ex ? exerciseNameFor(ex) : (e.n || e.id)}
            {w.prs?.includes(e.id) && <span className="pr"><Icon name="trophy" />PR</span>}
          </div>
          <div className="ss">{e.sets.filter(hasCompletedWork).map(s => setLabel(e.id, s, e.target, speed)).join('  ·  ') || 'no sets'}</div>
          {e.note && <div className="small dim" style={{ marginTop: 3 }}>
            {e.notePin && <Icon name="flag" style={{ fontSize: 12, marginInlineEnd: 4, verticalAlign: '-1px', color: 'var(--yellow)' }} />}{e.note}
          </div>}
        </div>
      </div>
    }) : <div className="muted small">Nothing was checked off in this session.</div>}
    {w.note && <><div className="small muted" style={{ margin: '4px 0 6px' }}>Session note</div>
      <div className="small">{w.note}</div></>}
    <div style={{ height: 14 }} />
    {canWrite && <><Button variant="danger" icon="trash" onClick={onDelete}>Delete this workout</Button>
      <div style={{ height: 8 }} /></>}
    <Button variant="ghost" className="dim" onClick={close}>Close</Button>
  </>
}

// What a restore would do, counted before anyone commits to it. Merge is the primary button
// because merge is the one that cannot lose anything; replace is below it, and says what it costs.
function RestoreSheet({ name, file, preview, onMerge, onReplace, close }) {
  const p = preview
  return <>
    <h3>Restore {name}</h3>
    <div className="muted small" style={{ marginBottom: 12 }}>{file}</div>
    <div className="tiles" style={{ textAlign: 'start' }}>
      <div className="tile"><div className="l">In the file</div><div className="v" style={{ fontSize: '1.1rem' }}>{p.workouts.incoming}</div></div>
      <div className="tile"><div className="l">Already there</div><div className="v" style={{ fontSize: '1.1rem' }}>{p.workouts.overlap}</div></div>
      <div className="tile"><div className="l">Would be added</div><div className="v" style={{ fontSize: '1.1rem', color: 'var(--acc)' }}>{p.workouts.added}</div></div>
      <div className="tile"><div className="l">Weigh-ins</div><div className="v" style={{ fontSize: '1.1rem' }}>+{p.bodyweight.added}</div></div>
    </div>
    <Button variant="primary" icon="plus" onClick={onMerge}>Merge — add {p.workouts.added} workouts</Button>
    <div className="adm-hint" style={{ margin: '8px 0 16px' }}>
      Days {name} already has are kept exactly as they are. A merge can only add.
    </div>
    <Button variant="danger" icon="warning" onClick={onReplace}>Replace everything</Button>
    <div className="adm-hint" style={{ marginTop: 8 }}>
      Throws away {p.replaceLoses.workouts} workouts and {p.replaceLoses.bodyweight} weigh-ins
      currently in the account and keeps only what is in this file. A snapshot is taken first.
    </div>
    <div style={{ height: 10 }} />
    <Button variant="ghost" className="dim" onClick={close}>Cancel</Button>
  </>
}

function SnapshotSheet({ snapshots, keep, live, onRestore, onDelete, onDeleteAll, close }) {
  const total = snapshots.reduce((a, s) => a + s.bytes, 0)
  return <>
    <h3>Snapshots</h3>
    <div className="adm-lead">
      Taken automatically before every change made from this panel. The newest {keep} are kept,
      then the oldest is dropped.
    </div>
    {snapshots.length ? <><div className="rowlist">
      {snapshots.map(s => <div key={s.ts} className="row between">
        <div><div className="small" style={{ fontWeight: 600 }}>{new Date(s.ts).toLocaleString()}</div>
          <div className="dim" style={{ fontSize: '.72rem' }}>{Math.round(s.bytes / 1024)} kB</div></div>
        <div className="row" style={{ gap: 4, flex: 'none' }}>
          <Button size="sm" disabled={live} onClick={() => onRestore(s.ts)}>Roll back</Button>
          <button className="iconbtn adm-iconbtn" style={{ color: 'var(--red)' }}
            aria-label="delete snapshot" onClick={() => onDelete(s.ts)}><Icon name="trash" /></button>
        </div>
      </div>)}
    </div>
      <div className="dim small" style={{ margin: '10px 0' }}>
        {snapshots.length} snapshots · {Math.round(total / 1024)} kB
      </div>
      <Button variant="danger" size="sm" icon="trash" onClick={onDeleteAll}>Delete all snapshots</Button>
    </> : <div className="adm-empty">No changes have been made from this panel yet.</div>}
    <div style={{ height: 14 }} />
    <Button variant="ghost" className="dim" onClick={close}>Close</Button>
  </>
}

// Type-the-name confirmation, for the two operations that destroy data.
function TypeName({ name, verb, destructive, onConfirm, close }) {
  const [typed, setTyped] = useState('')
  const ready = typed === name
  return <div style={{ padding: '4px 0' }}>
    <h3 style={{ marginBottom: 8 }}>{verb}</h3>
    <div className="adm-lead">
      This cannot be undone from here. Type <b>{name}</b> to confirm.
    </div>
    <TextField value={typed} onChange={e => setTyped(e.target.value)} placeholder={name} autoFocus />
    <div style={{ height: 12 }} />
    <button className={'btn ' + (destructive ? 'danger' : 'primary')} disabled={!ready} onClick={onConfirm}>{verb}</button>
    <div style={{ height: 8 }} />
    <Button variant="ghost" className="dim" onClick={close}>Cancel</Button>
  </div>
}

// The one time the reset code is visible. Locked, so a tap beside the sheet cannot lose it
// before it has been copied or written down.
function ResetCodeSheet({ name, email, code, expires, close }) {
  const toast = useUI(s => s.toast)
  const copy = () => { navigator.clipboard?.writeText(code).catch(() => {}); toast('Copied') }
  return <>
    <h3>Reset code for {name}</h3>
    <div className="adm-lead">Give them this code. They choose “Sign in with password” → “Have a reset code from your admin?”, enter their name <b>{name}</b>{email && <> (or their sign-in e-mail <b>{email}</b>)</>}, the code and a new password. It works once, until {new Date(expires).toLocaleString()}, and will not be shown again.</div>
    <button className="adm-code" style={{ fontSize: 22, width: '100%', padding: '14px 0' }} onClick={copy} aria-label="copy code">{code}</button>
    <div style={{ height: 12 }} />
    <Button variant="primary" onClick={close}>Done</Button>
  </>
}

export default function AdminUser() {
  const nav = useNavigate()
  const { id } = useParams()
  const user = useStore(s => s.user)
  const toast = useUI(s => s.toast)
  const [d, setD] = useState(null)
  const [count, setCount] = useState(PAGE)
  const [range, setRange] = useState('12m')
  const [busy, setBusy] = useState(false)
  const [snapCount, setSnapCount] = useState(0)
  const openSheet = useUI(s => s.openSheet)

  const loadSnapshots = () => api('/api/admin/user/snapshots?id=' + encodeURIComponent(id))
    .then(r => setSnapCount(r.snapshots.length)).catch(() => {})
  const load = () => api('/api/admin/user?id=' + encodeURIComponent(id))
    .then(setD).catch(e => toast(e.message || 'Failed to load'))

  useEffect(() => { if (!user?.admin) return; load(); loadSnapshots() }, [id])
  if (!user?.admin) return null
  if (!d) return <div className="narrow"><div className="muted small" style={{ padding: 20 }}>Loading…</div></div>

  const u = d.user
  const liveNow = !!d.live
  const workouts = (d.workouts || []).filter(shown)       // newest first, as the route sends them
  const routines = d.routines || []
  const counts = d.counts || { workouts: workouts.length, bodyweight: (d.bodyweight || []).length, routines: routines.length }

  // Every write goes through here so the refusals land in one place: the server's own message is
  // shown rather than a generic failure, because "they are training right now" and "that file is
  // not a backup" need entirely different reactions from whoever is reading.
  const write = async (path, payload, done) => {
    setBusy(true)
    try {
      const r = await api(path, { method: 'POST', body: JSON.stringify(payload) })
      await load(); loadSnapshots()
      done(r)
    } catch (e) { toast(e.message || 'That did not go through') } finally { setBusy(false) }
  }

  const pick = (onFile, accept = 'application/json,.json') => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.onchange = () => { const f = input.files[0]; if (f) onFile(f) }
    input.click()
  }

  const readFile = file => new Promise((resolve, reject) => {
    // 5 MB is the API's own limit; refusing here names the number instead of letting the upload
    // travel just to come back a 413.
    if (file.size > 5 * 1024 * 1024) { reject(new Error('That file is over 5 MB, which is more than the server accepts.')); return }
    const rd = new FileReader()
    rd.onload = () => resolve(String(rd.result))
    rd.onerror = () => reject(new Error('Could not read that file'))
    rd.readAsText(file)
  })

  const onBackupFile = async file => {
    let parsed
    try { parsed = parseBackupFile(await readFile(file)) } catch (e) { toast(e.message); return }
    if (!parsed.ok) { toast(parsed.error); return }
    const cur = await api('/api/admin/user/state?id=' + encodeURIComponent(id)).catch(() => ({ state: null }))
    const preview = restorePreview(cur.state, parsed.state)
    openSheet(close => <RestoreSheet
      name={u.name} file={file.name} preview={preview} close={close}
      onMerge={() => { close(); write('/api/admin/user/state', { id, mode: 'merge', state: parsed.state }, r => toast(`Merged — ${r.added} added, ${r.skipped} already there`)) }}
      onReplace={() => { close(); openSheet(c2 => <TypeName name={u.name} verb="Replace everything" close={c2}
        onConfirm={() => { c2(); write('/api/admin/user/state', { id, mode: 'replace', state: parsed.state, confirm: true }, () => toast('Data replaced')) }} />, { kind: 'center' }) }}
    />)
  }

  const onCsvFile = async file => {
    let parsed
    try { parsed = parseImport(await readFile(file), { unit: d.unit }) } catch (e) { toast(e.message || 'Could not read that export'); return }
    const fragment = parsed.kind === 'bodyweight'
      ? { workouts: [], routines: [], bodyweight: parsed.bodyweight }
      : { workouts: parsed.workouts, routines: [], customEx: parsed.customEx || [] }
    const n = parsed.kind === 'bodyweight' ? parsed.bodyweight.length : parsed.workouts.length
    confirmSheet({
      title: `Import ${n} ${parsed.kind === 'bodyweight' ? 'weigh-ins' : 'workouts'}?`,
      message: `From ${parsed.source || 'that export'}. Days ${u.name} already has are kept as they are — an import can only add.`,
      confirmText: 'Import',
      onConfirm: () => write('/api/admin/user/state', { id, mode: 'merge', state: fragment }, r => toast(`Imported — ${r.added + r.addedBodyweight} added, ${r.skipped} already there`)),
    })
  }

  const openSnapshots = async () => {
    const r = await api('/api/admin/user/snapshots?id=' + encodeURIComponent(id)).catch(() => null)
    if (!r) { toast('Could not load snapshots'); return }
    show(r.snapshots, r.keep)

    // Reopened with the new list after each delete rather than closed: clearing several in a row
    // is the whole reason the button exists, and a sheet that vanishes per click fights that.
    function show(snapshots, keep) {
      return openSheet(close => <SnapshotSheet
        snapshots={snapshots} keep={keep} live={liveNow} close={close}
        onRestore={ts => { close(); write('/api/admin/user/snapshots/restore', { id, ts, confirm: true }, () => toast('Rolled back')) }}
        onDelete={ts => remove(ts, close, snapshots.length === 1)}
        onDeleteAll={() => confirmSheet({
          title: 'Delete all snapshots?',
          message: 'The undo points for this account go for good. Nothing they logged is touched.',
          confirmText: 'Delete all', danger: true,
          onConfirm: () => remove('all', close, true),
        })} />)
      function remove(ts, close, closeAfter) {
        api('/api/admin/user/snapshots/delete', { method: 'POST', body: JSON.stringify({ id, ts }) })
          .then(res => {
            setSnapCount(res.snapshots.length)
            toast(res.removed === 1 ? 'Snapshot deleted' : res.removed + ' snapshots deleted')
            close()
            if (!closeAfter && res.snapshots.length) show(res.snapshots, keep)
          })
          .catch(e => toast(e.message || 'Could not delete that snapshot'))
      }
    }
  }

  const openWorkout = w => openSheet(close => <WorkoutSheet
    w={w} unit={d.unit} canWrite={!liveNow} close={close}
    onDelete={() => { close(); confirmSheet({
      title: 'Delete this workout?',
      message: `${fmtDate(w.d, true, true)} · ${w.name}. It is removed from ${u.name}'s history, on their devices too; a snapshot is taken first.`,
      confirmText: 'Delete', danger: true,
      onConfirm: () => write('/api/admin/user/workout/delete', { id, workoutId: w.id }, () => toast('Workout deleted')),
    }) }} />)

  const setAdminFlag = admin => write('/api/admin/user/admin', { id, admin }, () => toast(admin ? 'Now an admin' : 'No longer an admin'))

  const openDelete = () => openSheet(close => <TypeName
    name={u.name} verb="Delete account" close={close} destructive
    onConfirm={() => { close(); write('/api/admin/user/delete', { id }, () => { toast('Account deleted'); nav('/admin') }) }} />, { kind: 'center' })

  const download = async () => {
    setBusy(true)
    try {
      const r = await api('/api/admin/user/state?id=' + encodeURIComponent(id))
      if (!r.state) { toast('This user has never synced — there is nothing to back up.'); return }
      const file = wrapBackup(r.state, u, { app: __APP_VERSION__ })
      const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = backupFilename(u, todayISO())
      document.body.appendChild(a); a.click(); a.remove()
      setTimeout(() => URL.revokeObjectURL(a.href), 1000)
      toast('Backup downloaded')
    } catch (e) { toast(e.message || 'Download failed') } finally { setBusy(false) }
  }

  const setDisabled = disabled => {
    api('/api/admin/user/disable', { method: 'POST', body: JSON.stringify({ id: u.id, disabled }) })
      .then(() => { toast(disabled ? 'User disabled' : 'User enabled'); load() })
      .catch(e => toast(e.message))
  }

  // Password sign-in (#118): the server only sends `password` when the instance offers it. The
  // code comes back once, is shown once, and is never stored anywhere but as a hash.
  const pwInstance = typeof u.password === 'boolean'
  const resetPassword = () => confirmSheet({
    title: 'Reset ' + u.name + '’s password?',
    message: 'You get a one-time code to hand them. Their current password stops working now and they are signed out everywhere; their passkeys keep working. They set a new password with the code under “Sign in with password”. It is shown once and is valid for 24 hours.',
    confirmText: 'Create reset code',
    danger: true,
    onConfirm: () => api('/api/admin/user/password-reset', { method: 'POST', body: JSON.stringify({ id: u.id }) })
      .then(r => { load(); openSheet(done => <ResetCodeSheet name={r.name} email={u.email} code={r.code} expires={r.expires} close={done} />, { locked: true }) })
      .catch(e => toast(e.message)),
  })

  // Weigh-ins as the app charts them everywhere else.
  const bwPoints = (d.bodyweight || []).map(b => ({ t: b.t || new Date(b.d + 'T12:00:00').getTime(), y: b.w, d: b.d }))

  const months = RANGES.find(r => r.k === range)?.months || 0
  const monthly = months ? (d.monthly || []).slice(-months) : (d.monthly || [])
  const volPoints = monthly.map(m => ({ t: new Date(m.m + '-01T12:00:00').getTime(), y: m.vol, d: m.m + '-01' }))
  const rangeTotal = monthly.reduce((a, m) => a + m.workouts, 0)

  return <div className="narrow">
    <div className="hdr">
      <button className="iconbtn" onClick={() => nav('/admin')} aria-label="Back"><Icon name="chevronLeft" /></button>
      <div style={{ flex: 1, marginInlineStart: 8 }}>
        <h1 style={{ margin: 0 }} className="capitalize">{u.name}</h1>
        <div className="sub">{d.first ? 'training since ' + fmtDate(d.first, false, true) : 'no workouts yet'}</div>
      </div>
    </div>

    <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
      {u.admin && <span className="adm-pill acc">admin</span>}
      {u.envAdmin && <span className="adm-pill">via ADMIN_UIDS</span>}
      {u.disabled && <span className="adm-pill bad">disabled</span>}
      {liveNow && <span className="adm-pill acc">training now</span>}
      {u.invitedBy && <span className="adm-pill">invite {u.invitedBy}</span>}
      {u.password && <span className="adm-pill">password</span>}
      {/* The sign-in e-mail (password instances only): shown to admins and nobody else. */}
      {u.email && <span className="adm-pill" title="sign-in e-mail">{u.email}</span>}
      {u.resetUntil && <span className="adm-pill acc">reset code until {new Date(u.resetUntil).toLocaleString()}</span>}
      <span className="adm-pill">joined {u.created ? fmtDate(u.created.slice(0, 10)) : '—'}</span>
    </div>

    <div className="tiles" style={{ textAlign: 'start' }}>
      <div className="tile"><div className="l">Workouts</div><div className="v" style={{ fontSize: '1.1rem' }}>{workouts.length}</div></div>
      <div className="tile"><div className="l">Weigh-ins</div><div className="v" style={{ fontSize: '1.1rem' }}>{counts.bodyweight}</div></div>
      <div className="tile"><div className="l">Routines</div><div className="v" style={{ fontSize: '1.1rem' }}>{counts.routines}</div></div>
      <div className="tile"><div className="l">Last sync</div><div className="v" style={{ fontSize: '.95rem' }}>{rel(d.lastSync)}</div></div>
    </div>

    {bwPoints.length > 1 && <div className="card">
      <h2>Body weight</h2>
      <div className="chart"><LineChart points={bwPoints} h={140} unit={d.unit} /></div>
    </div>}

    {(d.monthly || []).length > 0 && <div className="card">
      <h2>Volume</h2>
      {/* Full width, as Stats lays its range picker out: squeezed beside the title its buttons
          shrank until "12 months" broke over two lines. */}
      <Segmented className="seg-range" value={range} onChange={setRange}
        options={RANGES.map(r => ({ value: r.k, label: r.label }))} />
      <div className="chart"><LineChart points={volPoints} h={140} unit={d.unit} /></div>
      <div className="dim small" style={{ marginTop: 6 }}>
        {rangeTotal} workouts in this range
        {/* Said out loud rather than folded into the line: imported history carries no volume,
            and silently treating that as zero would read as a slump that never happened. */}
        {d.volUnknown > 0 && ' · ' + d.volUnknown + ' without a recorded volume are not in this chart'}
      </div>
    </div>}

    {routines.length > 0 && <div className="card">
      <h2>Routines</h2>
      <div className="rowlist">
        {routines.map(r => <div key={r.id} className="row between">
          <div className="small" style={{ fontWeight: 600 }}>{r.name}</div>
          <span className="dim small">{r.count} exercises</span>
        </div>)}
      </div>
    </div>}

    <div className="card">
      <h2 style={{ margin: 0 }}>Data</h2>
      <div className="adm-lead">
        A backup carries training data and preferences only — no passkeys, no push subscriptions,
        no photos or videos. Every change here takes a snapshot first, so it can be rolled back,
        and reaches {u.name}'s devices at their next sync.
      </div>
      {liveNow && <div className="adm-hint" style={{ color: 'var(--orange)', marginBottom: 10 }}>
        {u.name} is training right now — changes wait until they finish, so the session they are
        logging lands on the history it started from.
      </div>}
      <div className="adm-actions">
        <Button icon="download" disabled={busy} onClick={download}>Download backup</Button>
        <Button icon="upload" disabled={busy || liveNow} onClick={() => pick(onBackupFile)}>Restore from file</Button>
        <Button icon="upload" disabled={busy || liveNow} onClick={() => pick(onCsvFile, '.csv,.xml,text/csv')}>Import from another app</Button>
        <Button icon="history" disabled={busy} onClick={openSnapshots}>Snapshots{snapCount ? ' · ' + snapCount : ''}</Button>
      </div>
    </div>

    <h4 className="sec">Workout history{workouts.length ? ' · ' + workouts.length : ''}</h4>
    {workouts.length ? <div className="list">
      {/* The same row the user sees in their own history (WorkoutRow, sheets.jsx): routine glyph,
          name, one metadata line, PR badge. Rebuilt rather than imported because that one reads
          the signed-in user's own routines to pick the glyph, and this is somebody else's. */}
      {workouts.slice(0, count).map(w => <div key={w.id} className="item wrow" onClick={() => openWorkout(w)}>
        <span className="lrow-i" style={{ width: 34, height: 34, borderRadius: 8, fontSize: 19 }}>
          <Icon name={glyphOf((routines.find(r => r.id === w.routineId) || {}).emoji)} />
        </span>
        <div className="grow"><div className="tt">{w.name}</div>
          <div className="ss">{[fmtDate(w.d, true), ...durPart(w.end - w.start), setsDone(w) + ' sets',
            ...(w.vol ? [fmtVol(w.vol, d.unit)] : [])].join(' · ')}</div></div>
        {w.prs?.length > 0 && <span className="pr"><Icon name="trophy" />{w.prs.length} PR</span>}
        <Icon name="chevronRight" className="chev" />
      </div>)}
    </div> : <div className="adm-empty">No workouts logged.</div>}
    {workouts.length > count && <><div style={{ height: 10 }} />
      <Button onClick={() => setCount(c => c + PAGE)}>Show more</Button></>}

    <div className="card" style={{ marginTop: 18, borderColor: 'color-mix(in srgb, var(--red) 40%, transparent)' }}>
      <h2 style={{ color: 'var(--red)', margin: 0 }}>Account</h2>
      <div className="adm-lead">Who they are on this instance, and whether they can get in.</div>

      {u.envAdmin
        ? <div className="adm-hint" style={{ marginBottom: 12 }}>
            This admin comes from the ADMIN_UIDS environment variable. The dashboard cannot remove
            them — take them out of ADMIN_UIDS and restart the server.
          </div>
        : <><Button icon={u.admin ? 'personCircle' : 'crown'} disabled={busy || (!u.admin && u.disabled)}
            onClick={() => setAdminFlag(!u.admin)}>
            {u.admin ? 'Remove admin' : 'Make admin'}
          </Button>
          <div className="adm-hint" style={{ margin: '4px 0 12px' }}>{u.admin
            ? 'They keep their account and their data; only this dashboard goes.'
            : u.disabled ? 'Enable the account first: an admin cannot be disabled.' : 'They get this dashboard, with everything on it.'}</div></>}

      {pwInstance && <>
        <Button icon="key" onClick={resetPassword}>Reset password</Button>
        <div className="adm-hint" style={{ margin: '4px 0 12px' }}>{u.password
          ? 'For a forgotten password: a one-time code lets them choose a new one. Their current password stops working at once.'
          : 'No password yet. A one-time code lets them set one — the way back in after losing their only passkey.'}</div>
      </>}

      {u.admin
        ? <div className="adm-hint">Admin accounts cannot be disabled or deleted — remove admin first.</div>
        : <>
          <button className={'btn ' + (u.disabled ? 'primary' : 'danger')}
            onClick={() => u.disabled ? setDisabled(false)
              : confirmSheet({
                title: 'Disable ' + u.name + '?',
                message: 'They are signed out everywhere and can no longer sync or log in until re-enabled. Their data stays.',
                confirmText: 'Disable', danger: true, onConfirm: () => setDisabled(true),
              })}>
            {u.disabled ? 'Enable account' : 'Disable account'}</button>
          <div className="adm-hint" style={{ margin: '4px 0 12px' }}>{u.disabled ? 'Enabling lets them sign in and sync again.' : 'Disabling signs them out everywhere and blocks sign-in. Nothing is deleted.'}</div>
          <Button variant="danger" icon="trash" disabled={busy || liveNow} onClick={openDelete}>Delete account</Button>
          <div className="adm-hint" style={{ marginTop: 4 }}>
            Removes the profile, its passkeys, its push subscriptions, its photos and videos, its
            whole history and every snapshot. Download a backup first if they might want it.
          </div>
        </>}
    </div>
  </div>
}
