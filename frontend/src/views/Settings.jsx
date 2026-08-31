import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore, DEF, hasData } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { ACCENTS, todayISO, localTZ } from '../lib/format.js'
import { effortOf } from '../lib/history.js'
import { api, webauthnOK, passkeyLogin, passkeyRegister, IS_ANDROID } from '../lib/api.js'
import { pushSupported, enablePush, disablePush, sendTestPush } from '../lib/push.js'
import { wakeLockSupported } from '../lib/wakelock.js'
import { t, LANGS, INSTR_LANGS } from '../lib/i18n.js'
import { fmtUSD } from '../lib/ai/pricing.js'
import { DEMO, REPO } from '../lib/demo.js'
import { MOBILE, shareExport, syncReminder } from '../lib/mobile.js'
import { ConnectSheet } from './MobileOnboarding.jsx'
import { loadStarterPlan, confirmSheet, importFromApp, equipmentProfileSheet } from '../sheets.jsx'
import Icon from '../components/Icon.jsx'
import { Section, Row, SelectRow, Switch, Segmented, Button, TextField } from '../components/ui.jsx'

export default function Settings() {
  const nav = useNavigate()
  const S = useStore(s => s.S)
  const user = useStore(s => s.user)
  const { update, replaceState, setUser, pullState, pushState, signOut, signOutAll, resetDemo, disconnectServer } = useStore()
  const toast = useUI(s => s.toast)
  const fileRef = useRef(null)
  const importRef = useRef(null)
  const wakeOK = wakeLockSupported()
  const config = useStore(s => s.config)
  const loadConfig = useStore(s => s.loadConfig)
  const [lbBusy, setLbBusy] = useState(false)
  useEffect(() => { loadConfig() }, [])

  // Joining is a decision about what other people can see, so it asks first; leaving is
  // immediate, because nobody should have to confirm their way out of being listed.
  const optLeaderboard = async on => {
    setLbBusy(true)
    try { const r = await api('/api/leaderboard/opt', { method: 'POST', body: JSON.stringify({ on }) }); setUser({ ...user, lb: r.lb }); toast(on ? t('You’re in the ranking') : t('You left the ranking')) }
    catch (e) { toast(e.message || t('Could not save that')) }
    finally { setLbBusy(false) }
  }
  const setLb = on => on
    ? confirmSheet({
        title: t('Join the ranking?'),
        message: t('Other profiles on this server will see your name, how many days you trained and your total volume. Nothing else is shared, and you can leave at any time.'),
        confirmText: t('Join'),
        onConfirm: () => optLeaderboard(true),
      })
    : optLeaderboard(false)


  const doExport = async () => {
    const json = JSON.stringify(S, null, 2)
    const name = 'opengym-backup-' + todayISO() + '.json'
    // WKWebView can't download blob URLs — the native build hands the file to the share sheet.
    if (MOBILE) {
      try { await shareExport(json, name); toast(t('Backup exported')) } catch (e) { /* share sheet dismissed */ }
      return
    }
    const blob = new Blob([json], { type: 'application/json' })
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); URL.revokeObjectURL(a.href)
    toast(t('Backup exported'))
  }
  const doImport = ev => {
    const f = ev.target.files[0]; if (!f) return
    const rd = new FileReader()
    rd.onload = () => {
      try {
        const raw = JSON.parse(rd.result)
        // An admin-issued backup wraps the same state in an envelope (lib/admin-backup.js). Both
        // are read here so a file handed back by whoever runs the server restores like your own.
        const data = raw && raw.opengym_backup ? raw.state : raw
        if (!data || !data.workouts || !data.routines) throw new Error('not an openGym backup')
        confirmSheet({ title: t('Import backup?'), message: t('This replaces all current data with the backup file.'), confirmText: t('Import'), danger: true, onConfirm: () => { replaceState(Object.assign(JSON.parse(JSON.stringify(DEF)), data), true); toast(t('Backup imported')) } })
      } catch (e) { toast(t('Import failed: {0}', e.message)) }
    }
    rd.readAsText(f)
  }
  const signInHere = async () => {
    try { const u = await passkeyLogin(); setUser(u); await pullState(); toast(t('Welcome back, {0}', u.name)) }
    catch (e) { if (e.name !== 'NotAllowedError' && e.name !== 'AbortError') toast(e.message || t('Sign-in failed')) }
  }
  const registerHere = () => useUI.getState().openSheet(close => <RegisterInline close={close} setUser={setUser} pushState={pushState} pullState={pullState} toast={toast} />)
  // Ends the profile's sessions on every device — this one included, so on success it lands in
  // the same place as the plain sign-out above (home, local data cleared). On failure nothing
  // local is touched: still signed in here, and say so rather than leaving a half-signed-out app.
  const signOutEverywhere = () => confirmSheet({
    title: t('Sign out everywhere?'),
    message: t('Signs this profile out on every device, including this one. Your passkeys keep working — sign in with them again anytime.'),
    confirmText: t('Sign out everywhere'), danger: true,
    onConfirm: async () => {
      try { await signOutAll(); nav('/home'); toast(t('Signed out on all devices')) }
      catch (e) { toast(t('Could not sign out everywhere — you are still signed in.')) }
    },
  })

  return <div className="narrow">
    <div className="hdr">
      <button className="iconbtn" onClick={() => nav('/home')} aria-label={t('Home')}><Icon name="chevronLeft" /></button>
      <div style={{ flex: 1, marginLeft: 10 }}><h1>{t('Settings')}</h1></div>
    </div>

    {/* ---------- account (demo and mobile builds have nothing to sign in to) ---------- */}
    <Section title={MOBILE ? (user ? t('Your server') : t('Your data')) : DEMO ? t('Demo') : t('Account')}>
      {MOBILE ? (user ? <>
        <Row icon="personCircle" iconTint="var(--grey)" title={user.name} subtitle={t('Synced with your openGym server.')} />
        {user.admin && <Row icon="wrench" iconTint="var(--indigo)" title={t('Admin dashboard')} accessory="chevron" onClick={() => nav('/admin')} />}
        <Row icon="signOut" iconTint="var(--red)" title={t('Disconnect')} danger onClick={() => confirmSheet({
          title: t('Disconnect from your server?'),
          message: t('Your data is synced to your server first, then this device switches back to local-only.'),
          confirmText: t('Disconnect'), danger: true,
          onConfirm: async () => { await disconnectServer(); nav('/home'); toast(t('Disconnected — back to local-only')) },
        })} />
      </> : <>
        <Row icon="lock" iconTint="var(--acc)" title={t('All data stays on this phone')} subtitle={t('No account, no cloud — back it up anytime with Export below.')} />
        <Row icon="link" iconTint="var(--indigo)" title={t('Connect to my server')} subtitle={t('Sync this device to your own self-hosted openGym instead.')} accessory="chevron"
          onClick={() => useUI.getState().openSheet(close => <ConnectSheet close={close} />)} />
      </>) : DEMO ? <>
        <Row icon="sparkles" iconTint="var(--acc)" title={t('You’re in the demo')} subtitle={t('Example data, stored only in this browser — change anything you like.')} />
        <Row icon="reset" iconTint="var(--blue)" title={t('Reset demo data')} accessory="chevron"
          onClick={() => confirmSheet({ title: t('Reset demo data?'), message: t('Puts the example plan, workouts and weigh-ins back the way they started.'), confirmText: t('Reset'), onConfirm: () => { resetDemo(); nav('/home'); toast(t('Demo data reset')) } })} />
        <Row icon="rocket" iconTint="var(--indigo)" title={t('Self-host openGym')} subtitle={t('Passkey sign-in, sync across your devices, your own data.')} accessory="chevron"
          onClick={() => window.open(REPO, '_blank', 'noopener')} />
      </> : user ? <>
        <Row icon="personCircle" iconTint="var(--grey)" title={user.name} subtitle={t('Signed in with passkey — data syncs to this profile.')} />
        {user.admin && <Row icon="wrench" iconTint="var(--indigo)" title={t('Admin dashboard')} accessory="chevron" onClick={() => nav('/admin')} />}
        <Row icon="link" iconTint="var(--blue)" title={t('Pair the mobile app')} subtitle={t('Connect the openGym app on your phone to this account.')} accessory="chevron"
          onClick={() => useUI.getState().openSheet(close => <PairSheet close={close} />)} />
        <Row icon="signOut" iconTint="var(--red)" title={t('Sign out')} danger onClick={() => confirmSheet({ title: t('Sign out?'), message: t('Your data is synced to your profile first, then cleared from this device.'), confirmText: t('Sign out'), danger: true, onConfirm: () => { signOut(); nav('/home') } })} />
        <Row icon="shield" iconTint="var(--red)" title={t('Sign out everywhere')} subtitle={t('Ends this profile’s sessions on all your devices.')} danger onClick={signOutEverywhere} />
      </> : webauthnOK() ? <>
        <Row icon="sparkles" iconTint="var(--acc)" title={t('Create passkey profile')} subtitle={t('Keeps your data safe and separate per person.')} accessory="chevron" onClick={registerHere} />
        <Row icon="person" iconTint="var(--blue)" title={t('Sign in with passkey')} accessory="chevron" onClick={signInHere} />
      </> : (
        <Row icon="lock" iconTint="var(--grey)" title={t('Passkeys not supported in this browser.')} />
      )}
    </Section>
    {!user && !DEMO && !MOBILE && <p className="sect-f" style={{ marginTop: -18, marginBottom: 22 }}>{t('Guest mode — data lives only in this browser.')}</p>}

    {/* ---------- ranking (server profiles only; the instance can switch it off entirely) ---------- */}
    {user && !DEMO && config?.leaderboard !== false && (
      <Section title={t('Ranking')} footer={t('Only your name, how many days you trained and your total volume are shared — never your exercises, your loads, your weight or your notes.')}>
        <Row icon="trophy" iconTint="var(--orange)" title={t('Join the ranking')} subtitle={t('Compare check-ins and volume with the other profiles on this server.')}>
          <Switch checked={user.lb === true} disabled={lbBusy} onChange={setLb} />
        </Row>
        {user.lb === true && <Row icon="chart" iconTint="var(--acc)" title={t('Ranking')} accessory="chevron" onClick={() => nav('/ranking')} />}
        <Row icon="person" iconTint="var(--blue)" title={t('Display name')} value={user.name} accessory="chevron"
          onClick={() => useUI.getState().openSheet(close => <RenameSheet close={close} name={user.name} onSaved={n => setUser({ ...user, name: n })} />)} />
      </Section>
    )}

    {/* ---------- general ---------- */}
    <Section title={t('General')} footer={t('Note: switching units only changes the label — logged numbers are not converted.')}>
      <SelectRow
        icon="globe" iconTint="var(--blue)" title={t('Language')}
        value={S.lang || 'en'} onChange={v => update(s => { s.lang = v })}
        options={Object.entries(LANGS).map(([k, name]) => ({
          value: k, label: name,
          subtitle: INSTR_LANGS.includes(k) ? null : t("Exercise instructions aren't available in this language yet — they stay in English."),
        }))}
      />
      <Row icon="scale" iconTint="var(--teal)" title={t('Weight unit')}>
        <Segmented className="seg-inline"
          options={[{ value: 'kg', label: 'kg' }, { value: 'lb', label: 'lb' }]}
          value={S.unit} onChange={v => update(s => { s.unit = v })} />
      </Row>
    </Section>

    {/* ---------- during a workout ---------- */}
    <Section title={t('During a workout')} footer={wakeOK ? t('The screen stays on while a workout is running, so you don’t have to unlock your phone between sets.') : null}>
      <SelectRow icon="timer" iconTint="var(--orange)" title={t('Rest timer')}
        value={S.restSec} onChange={v => update(s => { s.restSec = v })}
        options={[{ value: 0, label: t('Off') }, ...[60, 90, 120, 150, 180].map(v => ({ value: v, label: v + 's' }))]} />
      {/* Default for a rest-pause burst added live on a plain set — a planned exercise's own
          "Rest (s)" (in its Intensifier config) overrides this, same as the main rest timer
          is the fallback whenever an exercise has no progression rule of its own. */}
      <SelectRow icon="bolt" iconTint="var(--acc)" title={t('Rest-pause rest')}
        value={S.restPauseSec} onChange={v => update(s => { s.restPauseSec = v })}
        options={[10, 15, 20, 30].map(v => ({ value: v, label: v + 's' }))} />
      {(wakeOK || !MOBILE) && (
        <Row icon="sun" iconTint="var(--yellow)" title={t('Keep screen awake')}
          subtitle={wakeOK ? null : t('Not supported in this browser.')}>
          <Switch checked={wakeOK && S.keepAwake !== false} disabled={!wakeOK}
            onChange={v => update(s => { s.keepAwake = v })} />
        </Row>
      )}
      <Row icon="bell" iconTint="var(--pink)" title={t('Sounds')}>
        <Switch checked={!!S.sound} onChange={v => update(s => { s.sound = v })} />
      </Row>
      {/* Two names for the same judgement, so the column asks in the scale you already think in.
          The (i) sits before the control — you read it on the way to the choice, not after it. */}
      <Row icon="target" iconTint="var(--purple)" title={t('Effort per set')}>
        <button className="helpbtn" aria-label={t('What are RIR and RPE?')} onClick={effortHelpSheet}><Icon name="info" /></button>
        <Segmented className="seg-inline"
          options={[{ value: 'none', label: t('Off') }, { value: 'rir', label: t('RIR') }, { value: 'rpe', label: t('RPE') }]}
          value={effortOf(S)} onChange={v => update(s => { s.effort = v; delete s.showRir })} />
      </Row>
    </Section>

    {(user || MOBILE) && <NotificationsCard S={S} update={update} toast={toast} />}

    {/* ---------- equipment ---------- */}
    <EquipmentCard S={S} update={update} />

    {/* ---------- AI assistant (hidden unless the operator switched it on) ---------- */}
    {user && <AiCard toast={toast} />}

    {/* ---------- appearance ---------- */}
    <Section title={t('Appearance')} footer={DEMO || MOBILE ? undefined : t('synced with your profile')}>
      <Row icon="moon" iconTint="var(--indigo)" title={t('Theme')}>
        <Segmented
          className="seg-inline"
          options={[
            { value: 'dark', icon: 'moon', label: t('Dark') },
            { value: 'light', icon: 'sun', label: t('Light') },
            { value: 'system', icon: 'gear', label: t('System') },
          ]}
          value={S.theme || 'dark'}
          onChange={v => update(s => { s.theme = v })}
        />
      </Row>
      {/* Purely how the muscle map is drawn — nothing else in the app reads this. */}
      <Row icon="figureStrength" iconTint="var(--teal)" title={t('Body diagram')}>
        <Segmented
          className="seg-inline"
          options={[{ value: 'male', label: t('Male') }, { value: 'female', label: t('Female') }]}
          value={S.body === 'female' ? 'female' : 'male'}
          onChange={v => update(s => { s.body = v })}
        />
      </Row>
      <div className="lrow" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 12, paddingTop: 13, paddingBottom: 14 }}>
        <span className="lrow-t">{t('Accent color')}</span>
        <div className="swatches">
          {Object.entries(ACCENTS).map(([k, c]) => (
            <button key={k} className={'swatch' + ((S.accent || 'lime') === k ? ' on' : '')}
              style={{ background: c }} onClick={() => update(s => { s.accent = k })} aria-label={k} />
          ))}
        </div>
      </div>
    </Section>

    {/* ---------- data: fill it, bring things over, back it up, wipe it ---------- */}
    <Section title={t('Data')}>
      <Row icon="sparkles" iconTint="var(--acc)" title={t('Load starter plan (PPL)')} accessory="chevron" onClick={loadStarterPlan} />
      <Row icon="shuffle" iconTint="var(--teal)" title={t('Import from another app')}
        subtitle={t('FitNotes, Strong, Hevy — or body weight from Apple Health')}
        accessory="chevron" onClick={() => importRef.current.click()} />
      <Row icon="upload" iconTint="var(--blue)" title={t('Import backup')} accessory="chevron" onClick={() => fileRef.current.click()} />
      <Row icon="download" iconTint="var(--blue)" title={t('Export backup (JSON)')} accessory="chevron" onClick={doExport} />
      {MOBILE && <Row icon="history" iconTint="var(--blue)" title={t('Auto-backup on changes')}
        subtitle={t('Saves a dated copy to the Documents folder after finishing a workout or editing a routine — point a sync app at it, or copy it out by hand.')}>
        <Switch checked={!!S.autoBackup} onChange={v => update(s => { s.autoBackup = v })} />
      </Row>}
      <Row icon="trash" iconTint="var(--red)" title={t('Reset everything')} danger onClick={() => confirmSheet({ title: t('Reset everything?'), message: t('Deletes your plan, workouts and body weight on this device. This cannot be undone.'), confirmText: t('Delete everything'), danger: true, onConfirm: () => { replaceState(JSON.parse(JSON.stringify(DEF)), true); nav('/home'); toast(t('All data reset')) } })} />
    </Section>
    <input ref={fileRef} type="file" accept=".json,application/json" style={{ display: 'none' }} onChange={doImport} />
    {/* Reset after reading so picking the same file twice still fires onChange. */}
    <input ref={importRef} type="file" accept=".csv,.xml,text/csv,text/xml" style={{ display: 'none' }}
      onChange={ev => { const f = ev.target.files[0]; if (f) importFromApp(f); ev.target.value = '' }} />

    {/* "Add to Home screen" makes no sense inside the native app */}
    {!MOBILE && <Section title={t('Tip')}>
      <Row icon="lightbulb" iconTint="var(--yellow)"
        title={IS_ANDROID ? t('In Chrome: ⋮ menu → Add to Home screen') : t('In Safari: Share → Add to Home Screen')}
        subtitle={t('to install openGym as a full-screen app.') + ' ' + (user ? t('Your data syncs with your profile — sign in anywhere to see it.') : t('Guest data stays on this device — export a backup now and then!'))} />
    </Section>}

    {/* The version, at the bottom of Settings — which is where the support template has been
        telling people to look for it, and where it was not. On the phone build there is no
        address bar and no about box, so without this there is no way to tell which build you
        are running, or whether an update actually installed. */}
    <div className="dim small" style={{ textAlign: 'center', marginTop: 4, lineHeight: 1.6 }}>
      openGym v{__APP_VERSION__} · {t('free & open source (AGPL v3)')}<br />
      <a href="https://gitlab.com/DuarteSantos8/opengym" target="_blank" rel="noopener">source code</a> · exercise data: hasaneyldrm/exercises-dataset (MIT)<br />
      exercise images and animations © <a href="https://gymvisual.com/" target="_blank" rel="noopener">Gym visual</a>
    </div>
  </div>
}

// The whole point is that the two scales are one judgement counted from opposite ends, and a
// paragraph is a bad way to say that — the conversion table shows it in one look. Reading down
// a column is the answer to "what do I put here", so the numbers get their own aligned columns.
const EFFORT_ROWS = [
  ['0', '10', 'Nothing left — went to failure'],
  ['1', '9', 'One more rep in the tank'],
  ['2', '8', 'Two more reps'],
  ['3', '7', 'Three more reps'],
  ['4+', '≤6', 'Easy — warm-up territory'],
]
// RIR 2 / RPE 8: the row a working set usually lands on — the anchor the others are read
// against. Not where the stepper starts; + walks up from the bottom of the scale.
const EFFORT_TYPICAL = 2

function effortHelpSheet() {
  useUI.getState().openSheet(close => <>
    <h3>{t('Effort per set')}</h3>
    <div className="muted small" style={{ lineHeight: 1.5 }}>
      {t('How hard a set was, logged next to weight and reps. Two scales for the same judgement, counted from opposite ends.')}
    </div>
    <div className="efftbl">
      <div className="r hd"><span className="n">{t('RIR')}</span><span className="n">{t('RPE')}</span><span className="f">{t('How it felt')}</span></div>
      {EFFORT_ROWS.map(([rir, rpe, feel], i) => (
        <div key={rir} className={'r' + (i === EFFORT_TYPICAL ? ' on' : '')}>
          <span className="n">{rir}</span><span className="n">{rpe}</span><span className="f">{t(feel)}</span>
        </div>
      ))}
    </div>
    <div className="dim small" style={{ lineHeight: 1.5, display: 'grid', gap: 8 }}>
      <div>{t('RIR counts the reps you left; RPE reads the same effort off a 10-point scale — so RPE ≈ 10 − RIR. Pick the one you already think in.')}</div>
      <div>{t('The highlighted row is where most working sets land. Sets you have already logged keep their own scale, and nothing else reads the value — progression and estimated 1RM are unaffected.')}</div>
    </div>
    <div style={{ height: 8 }} />
  </>)
}

function NotificationsCard({ S, update, toast }) {
  if (MOBILE) return <MobileReminderCard S={S} update={update} toast={toast} />
  return <PushCard S={S} update={update} toast={toast} />
}

// Mobile build: the reminder is a native local notification scheduled on planned weekdays —
// no push server involved. The schedule itself is (re)synced by the store on every persist;
// this card only owns the OS permission prompt when the switch turns on.
function MobileReminderCard({ S, update, toast }) {
  const setReminder = patch => update(s => { s.reminder = { ...(s.reminder || DEF.reminder), ...patch, tz: localTZ() } })
  const toggle = async () => {
    const on = !S.reminder?.on
    if (on) {
      const ok = await syncReminder({ ...S, reminder: { ...(S.reminder || DEF.reminder), on: true } }, true)
      if (!ok) { toast(t('Could not change notification settings')); return }
    }
    setReminder({ on })
  }
  return (
    <Section title={t('Notifications')}
      footer={S.reminder?.on ? t('Reminds you at this time on days that have a routine planned.') : null}>
      <Row icon="calendar" iconTint="var(--orange)" title={t('Workout day reminder')}>
        <Switch checked={!!S.reminder?.on} onChange={toggle} />
      </Row>
      {S.reminder?.on && (
        <Row icon="clock" iconTint="var(--purple)" title={t('Reminder time')}>
          <input type="time" className="timef" value={S.reminder?.time || DEF.reminder.time}
            onChange={e => setReminder({ time: e.target.value })} />
        </Row>
      )}
    </Section>
  )
}

// The AI assistant: the user brings their own API key, and it never touches this device's
// storage or the synced state. Everything here reflects GET /api/ai/status, which is the side
// that holds the key and enforces the cap — there is no local copy to disagree with it.
//
// The whole card disappears when the operator has not switched the feature on (AI_ENABLED),
// and it only renders for a signed-in profile: guest mode never talks to a server, so there
// would be nowhere to keep a key.
const AI_PROVIDER_NAME = { anthropic: 'Anthropic', openai: 'OpenAI', gemini: 'Google Gemini' }
// Dollars per month. A short list rather than a free number field: this is a guard rail, not a
// budget, and the numbers people actually want are an order of magnitude apart, not a cent apart.
const AI_CAPS = [0, 1, 5, 10, 25, 50]

function AiCard({ toast }) {
  const [st, setSt] = useState(null)

  useEffect(() => { api('/api/ai/status').then(setSt).catch(() => { }) }, [])

  if (!st || !st.enabled) return null

  const provider = st.provider || st.providers[0]
  const models = (st.models || {})[provider] || []
  const spend = st.spend || {}

  const openKeySheet = () => useUI.getState().openSheet(close =>
    <AiKeySheet st={st} close={close} onSaved={next => { setSt(next); toast(t('API key saved')) }} toast={toast} />)

  // Every setting goes through the same POST, which requires the key — so these re-send only the
  // fields that changed and let the server keep the stored key. See POST /api/ai/key.
  const patch = async body => {
    try { setSt(await api('/api/ai/settings', { method: 'POST', body: JSON.stringify(body) })) }
    catch (e) { toast(e.message || t('Could not save that')) }
  }

  const forget = () => confirmSheet({
    title: t('Forget your API key?'),
    message: t('openGym stops being able to reach your AI provider. Your key itself stays valid — revoke it with the provider if you want it dead.'),
    confirmText: t('Forget it'),
    danger: true,
    onConfirm: async () => {
      try { setSt(await api('/api/ai/key', { method: 'DELETE' })); toast(t('API key forgotten')) }
      catch (e) { toast(e.message || t('Could not remove it')) }
    }
  })

  return <Section
    title={t('AI assistant')}
    footer={st.configured
      ? t('Your key is stored on this server, encrypted, and is never sent back to the browser. Spending is counted per UTC month and checked before each request — so the request that crosses the cap still goes through.')
      : t('Bring a key from Anthropic, OpenAI or Google and openGym can read your training back to you. Your workouts are sent to whichever provider you pick, and you pay them directly — nothing goes anywhere else.')}
  >
    {!st.configured && (
      <Row icon="key" iconTint="var(--acc)" title={t('Add your API key')}
        subtitle={t('Nothing is sent anywhere until you do.')}
        accessory="chevron" onClick={openKeySheet} />
    )}

    {/* A regenerated or restored-without data/secret. Every session died with it too, so this is
        a known state — it just needs saying, because "not configured" would be a lie. */}
    {st.configured && !st.readable && (
      <Row icon="warning" iconTint="var(--red)" title={t('Your key could not be read')}
        subtitle={t('This happens when the server’s secret was regenerated. Save the key again.')}
        accessory="chevron" onClick={openKeySheet} />
    )}

    {st.configured && <>
      <Row icon="key" iconTint="var(--acc)" title={AI_PROVIDER_NAME[provider] || provider}
        subtitle={st.hint ? '····' + st.hint : null}
        value={t('Replace')} accessory="chevron" onClick={openKeySheet} />

      <SelectRow icon="sparkles" iconTint="var(--indigo)" title={t('Model')}
        value={st.model}
        options={models.map(m => ({ value: m.id, label: m.label }))}
        onChange={v => patch({ model: v })}
        sheetTitle={t('Model')} stackedValue />

      <SelectRow icon="scale" iconTint="var(--teal)" title={t('Spending cap')}
        value={st.capUSD || 0}
        options={AI_CAPS.map(v => ({ value: v, label: v ? '$' + v + '/' + t('month') : t('No cap') }))}
        onChange={v => patch({ capUSD: v })}
        sheetTitle={t('Spending cap')} />

      <Row icon="chart" iconTint="var(--blue)" title={t('Spent this month')}
        subtitle={t('{0} requests', spend.calls || 0) +
          (spend.unpriced ? ' · ' + t('{0} on a model with no price here', spend.unpriced) : '')}
        value={fmtUSD(spend.usd || 0)} />

      <Row icon="trash" iconTint="var(--red)" title={t('Forget my API key')} danger onClick={forget} />
    </>}
  </Section>
}

// Write-only by design: no route returns a saved key, so replacing it is the only thing this
// sheet can do. The model and the cap are set on the card afterwards, which keeps this to the
// two decisions that have to be made before anything can be saved at all.
function AiKeySheet({ st, close, onSaved, toast }) {
  const [provider, setProvider] = useState(st.provider || st.providers[0])
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)

  const placeholder = { anthropic: 'sk-ant-…', openai: 'sk-…', gemini: 'AIza…' }[provider]

  const save = async () => {
    if (!key.trim()) { toast(t('Paste your API key first')); return }
    setBusy(true)
    try {
      const next = await api('/api/ai/key', {
        method: 'POST',
        body: JSON.stringify({
          provider,
          // Keep the chosen model when replacing a key for the same provider; otherwise the
          // provider's own default, since last time's model id means nothing to a new one.
          model: provider === st.provider ? st.model : st.defaults[provider],
          capUSD: st.capUSD || 5,
          key: key.trim()
        })
      })
      close()
      onSaved(next)
    } catch (e) { toast(e.message || t('That key was not accepted')) }
    setBusy(false)
  }

  return <>
    <h3>{t('Your API key')}</h3>
    <div className="muted small" style={{ marginBottom: 14 }}>
      {t('Create the key with a spending limit on the provider’s own dashboard. openGym can cap what it spends here — it cannot cap what the key does anywhere else.')}
    </div>

    <Segmented
      options={st.providers.map(p => ({ value: p, label: { anthropic: 'Anthropic', openai: 'OpenAI', gemini: 'Gemini' }[p] || p }))}
      value={provider} onChange={setProvider} />

    <div style={{ height: 12 }} />
    <input className="input" type="password" autoComplete="off" spellCheck="false"
      placeholder={placeholder} value={key} onChange={e => setKey(e.target.value)} />

    <div className="dim small" style={{ marginTop: 8 }}>
      {t('It is stored on this server, encrypted, and never sent back to your browser.')}
    </div>

    <div style={{ height: 12 }} />
    <Button variant="primary" disabled={busy} onClick={save}>{t('Save key')}</Button>
  </>
}

function PushCard({ S, update, toast }) {
  const [on, setOn] = useState(false)
  const [busy, setBusy] = useState(false)
  const supported = pushSupported()

  useEffect(() => {
    if (!supported) return
    navigator.serviceWorker.ready.then(reg => reg.pushManager.getSubscription()).then(sub => setOn(!!sub)).catch(() => {})
  }, [supported])

  const toggle = async v => {
    setBusy(true)
    try {
      if (!v) { await disablePush(); setOn(false); toast(t('Notifications off')) }
      else { await enablePush(); setOn(true); toast(t('Notifications on')) }
    } catch (e) { toast(e.message || t('Could not change notification settings')) }
    setBusy(false)
  }
  const test = async () => {
    try { await sendTestPush(); toast(t('Test sent — should arrive any second')) }
    catch (e) { toast(e.message || t('Test failed')) }
  }

  if (!supported) return (
    <Section title={t('Notifications')}>
      <Row icon="bellSlash" iconTint="var(--grey)" title={t('Not supported in this browser.')} />
    </Section>
  )

  return <>
    <Section
      title={t('Notifications')}
      footer={on && S.reminder?.on
        ? t("Only sent on days you have a routine planned and haven't logged a workout yet.") +
          (S.reminder?.tz ? ' ' + t('Timezone: {0} (auto-detected, updates if you travel).', S.reminder.tz) : '')
        : null}
    >
      <Row icon="bell" iconTint="var(--red)" title={t('Push notifications')} subtitle={t('Rest-timer alerts, even if openGym is closed.')}>
        <Switch checked={on} disabled={busy} onChange={toggle} />
      </Row>
      {on && (
        <Row icon="calendar" iconTint="var(--orange)" title={t('Workout day reminder')}>
          <Switch checked={!!S.reminder?.on} onChange={() => update(s => { s.reminder = { ...(s.reminder || DEF.reminder), on: !s.reminder?.on, tz: localTZ() } })} />
        </Row>
      )}
      {on && S.reminder?.on && (
        <Row icon="clock" iconTint="var(--purple)" title={t('Reminder time')}>
          <input type="time" className="timef" value={S.reminder?.time || DEF.reminder.time}
            onChange={e => update(s => { s.reminder = { ...(s.reminder || DEF.reminder), time: e.target.value, tz: localTZ() } })} />
        </Row>
      )}
    </Section>
    {on && <div style={{ marginTop: -12, marginBottom: 22 }}><Button size="sm" icon="bell" onClick={test}>{t('Send test notification')}</Button></div>}
  </>
}

// Equipment profiles ("Home", "Gym", ...) — each an id/name/eq-list; the active one filters
// the Library, exercise picker, and flags routine entries that need something outside it
// (see lib/equipment.js). Purely local/synced state — no server changes needed.
function EquipmentCard({ S, update }) {
  const profiles = S.equipProfiles || []
  const remove = p => confirmSheet({
    title: t('Delete profile?'), message: t('"{0}" and its equipment list will be removed.', p.name),
    confirmText: t('Delete'), danger: true,
    onConfirm: () => update(s => {
      s.equipProfiles = (s.equipProfiles || []).filter(x => x.id !== p.id)
      if (s.activeEquipId === p.id) s.activeEquipId = (s.equipProfiles[0] && s.equipProfiles[0].id) || null
    }),
  })
  return <Section title={t('Equipment')} footer={t('Filters the exercise library and picker, and flags routine exercises that need something you don’t have in the active profile.')}>
    {profiles.length > 0 && <Row icon="dumbbell" iconTint="var(--acc)" title={t('Filter by equipment')}>
      <Switch checked={!!S.equipFilterOn} onChange={v => update(s => { s.equipFilterOn = v })} />
    </Row>}
    {profiles.length > 0 && <SelectRow icon="list" iconTint="var(--blue)" title={t('Active profile')}
      value={S.activeEquipId || ''} onChange={v => update(s => { s.activeEquipId = v })}
      options={profiles.map(p => ({ value: p.id, label: p.name }))} />}
    {profiles.map(p => (
      <Row key={p.id} icon="dumbbell" iconTint="var(--teal)" title={p.name}
        subtitle={t('{0} equipment types', p.equipment.length)} accessory="chevron"
        onClick={() => equipmentProfileSheet(p)}>
        <button className="iconbtn" aria-label={t('Delete')} onClick={ev => { ev.stopPropagation(); remove(p) }}><Icon name="trash" /></button>
      </Row>
    ))}
    <Row icon="plus" iconTint="var(--acc)" title={t('Add equipment profile')} accessory="chevron" onClick={() => equipmentProfileSheet(null)} />
  </Section>
}

// Lets the mobile app's "connect to my server" mode (lib/remote.js) authenticate without a
// WebAuthn ceremony of its own — the code is minted here, from an already signed-in session,
// and redeemed by the app for a bearer token. See /api/pair/create in api/server.js.
// Renaming was impossible until now: the display name was typed once, during passkey
// registration, and never surfaced again. That only became a problem when a screen started
// putting names side by side.
function RenameSheet({ close, name, onSaved }) {
  const [v, setV] = useState(name || '')
  const [busy, setBusy] = useState(false)
  const toast = useUI(s => s.toast)
  const save = async () => {
    const n = v.trim()
    if (!n) { toast(t('Enter a name')); return }
    setBusy(true)
    try { const r = await api('/api/me/name', { method: 'POST', body: JSON.stringify({ name: n }) }); onSaved(r.name); close(); toast(t('Name updated')) }
    catch (e) { toast(e.message || t('Could not save the name')) }
    finally { setBusy(false) }
  }
  return <>
    <h3>{t('Display name')}</h3>
    <div className="muted small" style={{ marginBottom: 14 }}>{t('This is the name other profiles on this server see in the ranking.')}</div>
    <TextField value={v} onChange={e => setV(e.target.value)} maxLength={40} placeholder={t('Your name')} />
    <div style={{ height: 12 }} />
    <Button onClick={save} disabled={busy}>{busy ? t('Saving…') : t('Save')}</Button>
  </>
}

function PairSheet({ close }) {
  const [code, setCode] = useState(null)
  const [err, setErr] = useState(null)
  useEffect(() => { api('/api/pair/create', { method: 'POST', body: '{}' }).then(r => setCode(r.code)).catch(e => setErr(e.message || t('Could not generate a code'))) }, [])
  return <>
    <h3>{t('Pair the mobile app')}</h3>
    <div className="muted small" style={{ marginBottom: 14 }}>
      {t('On the openGym app, choose “Connect to my server”, then enter this address and the code below. It expires in 5 minutes.')}
    </div>
    {err ? <div className="dim small">{err}</div> : (
      <div className="card" style={{ textAlign: 'center', fontSize: 30, fontWeight: 700, letterSpacing: '.16em', padding: '18px 0' }}>
        {code || '········'}
      </div>
    )}
    <div style={{ height: 12 }} />
    <Button onClick={close}>{t('Done')}</Button>
  </>
}

// The same registration as the sign-in screen's, reached from Settings instead. It asks for
// the invite code on the same terms: an invite-only instance rejects a registration without
// one, so a form that cannot collect it is a form that cannot succeed.
function RegisterInline({ close, setUser, pushState, pullState, toast }) {
  const nameRef = useRef(null)
  const [code, setCode] = useState('')
  const [inviteOnly, setInviteOnly] = useState(false)
  useEffect(() => { api('/api/config').then(c => setInviteOnly(!!c.invite_only)).catch(() => {}) }, [])
  const go = async () => {
    const n = (nameRef.current.value || '').trim()
    if (!n) { toast(t('Enter a name')); return }
    if (inviteOnly && !code.trim()) { toast(t('An invite code is required')); return }
    try {
      const u = await passkeyRegister(n, code.trim()); setUser(u); close()
      if (hasData(useStore.getState().S)) { await pushState(); toast(t('Profile created — data moved into it')) }
      else { await pullState(); toast(t('Welcome, {0}', u.name)) }
    } catch (e) { if (e.name !== 'NotAllowedError' && e.name !== 'AbortError') toast(e.message || t('Registration failed')) }
  }
  return <>
    <h3>{t('Create your profile')}</h3>
    <div className="muted small" style={{ marginBottom: 14 }}>{t('Pick a name, then confirm with your device.')}</div>
    <TextField ref={nameRef} placeholder={t('Your name')} maxLength={40} />
    {inviteOnly && <>
      <div style={{ height: 10 }} />
      <input className="input" placeholder={t('Invite code')} maxLength={40} value={code}
        onChange={e => setCode(e.target.value.toUpperCase())} style={{ letterSpacing: '.14em', fontWeight: 600, textAlign: 'center' }} />
      <div className="dim small" style={{ marginTop: 6 }}>{t('This app is invite-only — enter the code you were given.')}</div>
    </>}
    <div style={{ height: 12 }} /><Button variant="primary" onClick={go}>{t('Create passkey')}</Button>
  </>
}
