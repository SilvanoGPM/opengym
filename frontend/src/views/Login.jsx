import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { webauthnOK, passkeyLogin, passkeyRegister, bio } from '../lib/api.js'
import { hasData } from '../store/useStore.js'
import { t } from '../lib/i18n.js'
import { DEMO, REPO } from '../lib/demo.js'
import { guestAllowed } from '../lib/guest.js'
import { useState, useRef, useEffect } from 'react'
import Icon from '../components/Icon.jsx'
import { Button, Segmented } from '../components/ui.jsx'
import { askAddDeviceData } from '../sheets.jsx'
import { passwordOn, PasswordRegisterForm, openPasswordSignIn } from '../components/PasswordAuth.jsx'
import { openDeviceLinkRedeem } from '../components/Passkeys.jsx'

const GRID_COLS = 40
const GRID_ROWS = 7

/**
 * The mark: a grid of trained days, drawn with the same cells as the Stats heatmap.
 *
 * Fixed rather than random — the screen looks the same on every visit — and the density climbs
 * from left to right, which is the one thing this app claims: weeks fill in as the habit takes.
 * It is a texture, not a chart. There are no numbers behind it and it never reads anyone's data,
 * which is the whole reason it can be here before you have signed in.
 */
function ConsistencyGrid() {
  const noise = (c, r) => { const n = Math.sin(c * 12.9898 + r * 78.233) * 43758.5453; return n - Math.floor(n) }
  const cells = []
  for (let c = 0; c < GRID_COLS; c++) {
    for (let r = 0; r < GRID_ROWS; r++) {
      const trained = noise(c, r) < 0.16 + (c / (GRID_COLS - 1)) * 0.46
      const level = trained ? 1 + Math.floor(noise(c + 41, r + 7) * 4) : 0
      cells.push(<i key={c + '-' + r} className={'hm-c l' + level}
        style={{ animationDelay: c * 13 + 'ms' }} />)
    }
  }
  // Decorative: it carries no information a screen reader can use, and announcing 280 cells
  // before the sign-in button would be the opposite of helpful.
  return <div className="si-gridwrap" aria-hidden="true"><div className="si-grid">{cells}</div></div>
}

function RegisterSheet({ close }) {
  const { setUser, pushState, pullState, loadConfig } = useStore()
  const config = useStore(s => s.config)
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const inviteOnly = !!config?.invite_only
  // A password is offered only where the instance allows it (#118), and is the only choice in a
  // browser that cannot make a passkey. Where both work, the passkey stays the first one.
  const pwOn = passwordOn(config)
  const [how, setHow] = useState(webauthnOK() ? 'passkey' : 'password')
  const ref = useRef(null)
  useEffect(() => { setTimeout(() => ref.current?.focus(), 250) }, [])
  // Boot already fetched this; retry here only if that attempt failed, so the invite field still
  // appears on an instance whose config arrived late rather than never.
  useEffect(() => { loadConfig() }, [loadConfig])
  const go = async () => {
    const n = name.trim()
    if (!n) { useUI.getState().toast(t('Enter a name')); return }
    if (inviteOnly && !code.trim()) { useUI.getState().toast(t('An invite code is required')); return }
    try {
      const u = await passkeyRegister(n, code.trim())
      setUser(u); close()
      if (hasData(useStore.getState().S)) { await pushState(); useUI.getState().toast(t('Profile created — data from this device moved into it')) }
      else { await pullState(); useUI.getState().toast(t('Welcome, {0}', u.name)) }
    } catch (e) { if (e.name !== 'NotAllowedError' && e.name !== 'AbortError') useUI.getState().toast(e.message || t('Registration failed')) }
  }
  const choose = pwOn && webauthnOK() && <>
    <Segmented options={[{ value: 'passkey', label: t('Passkey'), icon: 'person' }, { value: 'password', label: t('Password'), icon: 'key' }]}
      value={how} onChange={setHow} />
    <div style={{ height: 12 }} />
  </>
  if (pwOn && how === 'password') return <>
    <h3>{t('Create your profile')}</h3>
    {choose}
    <div className="muted small" style={{ marginBottom: 14 }}>{t('Pick a name and a password. You sign in with both.')}</div>
    <PasswordRegisterForm close={close} inviteOnly={inviteOnly} name={name} setName={setName} code={code} setCode={setCode} />
  </>
  return <>
    <h3>{t('Create your profile')}</h3>
    {choose}
    <div className="muted small" style={{ marginBottom: 14 }}>{t('Pick a name, then confirm with {0}. The passkey is saved in your device — no password needed.', bio())}</div>
    <input ref={ref} className="input" placeholder={t('Your name')} maxLength={40} value={name} onChange={e => setName(e.target.value)} />
    {inviteOnly && <>
      <div style={{ height: 10 }} />
      <input className="input" placeholder={t('Invite code')} maxLength={40} value={code}
        onChange={e => setCode(e.target.value.toUpperCase())} style={{ letterSpacing: '.14em', fontWeight: 600, textAlign: 'center' }} />
      <div className="dim small" style={{ marginTop: 6 }}>{t('This app is invite-only — enter the code you were given.')}</div>
    </>}
    <div style={{ height: 12 }} />
    <Button variant="primary" onClick={go}>{t('Create passkey')}</Button>
  </>
}

export default function Login() {
  const { setUser, adoptProfile, setGuest } = useStore()
  const config = useStore(s => s.config)
  const canGuest = guestAllowed(config)
  const pwOn = passwordOn(config)
  const register = () => useUI.getState().openSheet(close => <RegisterSheet close={close} />)
  const signIn = async () => {
    try { const u = await passkeyLogin(); setUser(u, { adopt: true }); await adoptProfile(askAddDeviceData); useUI.getState().toast(t('Welcome back, {0}', u.name)) }
    catch (e) { if (e.name !== 'NotAllowedError' && e.name !== 'AbortError') useUI.getState().toast(e.message || t('Sign-in failed')) }
  }
  const head = <>
    <ConsistencyGrid />
    <h1 className="si-mark">openGym</h1>
  </>

  // Demo build: no backend to sign in against — the only way in is the local guest profile.
  if (DEMO) return (
    <div className="narrow si">
      {head}
      <p className="si-lead">{t('Live demo — everything stays in this browser.')}</p>
      <div className="si-actions">
        <Button variant="primary" icon="sparkles" onClick={() => setGuest(true)}>{t('Start the demo')}</Button>
      </div>
      <div className="card small muted" style={{ textAlign: 'start', marginTop: 16 }}>
        {t('This demo runs entirely in your browser on example data — nothing is sent anywhere. Passkey sign-in and sync across your devices come with the openGym server, which you get by self-hosting it.')}
      </div>
      <div className="dim small" style={{ marginTop: 22, lineHeight: 1.6 }}>
        <a href={REPO} target="_blank" rel="noopener">{t('Self-host it in a minute →')}</a>
      </div>
    </div>
  )

  return (
    <div className="narrow si">
      {head}
      <p className="si-lead">{t('Your workouts. Your weights. Your profile.')}</p>
      {/* One way in for the people who already have an account, and quieter ones for everybody
          else — they used to carry the same weight and ask you to read all of them. */}
      <div className="si-actions">
        {webauthnOK() ? <>
          <Button variant="primary" icon="person" onClick={signIn}>{t('Sign in with passkey')}</Button>
          {pwOn && <Button variant="tinted" icon="key" onClick={() => openPasswordSignIn()}>{t('Sign in with password')}</Button>}
          <Button variant="tinted" icon="sparkles" onClick={register}>{t('Create new profile')}</Button>
          {/* Already signed in on another device: a code from there gives this one a passkey of
              its own (#95), instead of a new, empty profile. */}
          <Button variant="ghost" className="dim" icon="qr" onClick={openDeviceLinkRedeem}>{t('Use a code from your other device')}</Button>
        </> : pwOn ? <>
          {/* Plain http on a LAN address, or a browser without passkey support: the password is
              the way in, and the only way to create a profile from here. */}
          <div className="card small muted" style={{ textAlign: 'start', marginBottom: 4 }}>{t("This browser doesn't support passkeys — sign in with your name and password instead.")}</div>
          <Button variant="primary" icon="key" onClick={() => openPasswordSignIn()}>{t('Sign in with password')}</Button>
          <Button variant="tinted" icon="sparkles" onClick={register}>{t('Create new profile')}</Button>
        </> : <div className="card small muted" style={{ textAlign: 'start' }}>{canGuest
          ? t("This browser doesn't support passkeys — you can still use openGym locally on this device.")
          // Without passkeys and without the guest entrance there is no way in from this browser,
          // so say that plainly instead of offering a local profile that cannot be created.
          : t("This browser doesn't support passkeys, and this instance requires an account. Try a browser or device with passkey support.")}</div>}
        {canGuest && <Button variant="ghost" className="dim" onClick={() => setGuest(true)}>{t('Continue without account')}</Button>}
      </div>
      {/* "No passwords" is only true where the instance has not switched password sign-in on. */}
      <ul className="si-facts">
        {!pwOn && <li><Icon name="key" />{t('No passwords')}</li>}
        <li><Icon name="lock" />{t('Your data stays yours')}</li>
        <li><Icon name="bolt" />{t('Works offline')}</li>
      </ul>
    </div>
  )
}
