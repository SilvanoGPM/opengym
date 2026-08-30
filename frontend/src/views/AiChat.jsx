// Asking your own model about your own training.
//
// The conversation is deliberately ephemeral: it lives in this component and dies with it. It is
// not training data, so it has no business in the synced state, the backup export or the admin
// dashboard — and a chat log is the one thing here that would carry a person's questions rather
// than their sets.
//
// There is no streaming. The model calls read-only tools before it answers, and those calls are
// what the status line shows — which is more than a cursor blinking would say. See the note in
// lib/ai/run.js about why the loop is the progress indicator.
import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { api } from '../lib/api.js'
import { run, emptyAnswer } from '../lib/ai/run.js'
import { chatRequest, evaluateWorkoutRequest } from '../lib/ai/actions.js'
import { userTurn, textOf } from '../lib/ai/message.js'
import { trimHistory, isQuestion } from '../lib/ai/chat-history.js'
import { costOf, priceOf, labelOf, fmtUSD } from '../lib/ai/pricing.js'
import { t } from '../lib/i18n.js'
import { Markdown } from '../components/AiSheet.jsx'
import Icon from '../components/Icon.jsx'
import { Button } from '../components/ui.jsx'

/** What each tool is doing, said the way a person would say it rather than by its function name. */
const DOING = {
  search_exercises: 'Looking through the exercise library…',
  get_exercises: 'Looking through the exercise library…',
  list_routines: 'Reading your routines…',
  get_routine: 'Reading your routines…',
  get_week_plan: 'Reading your week…',
  list_workouts: 'Reading your sessions…',
  get_workout: 'Reading your sessions…',
  get_bodyweight: 'Reading your weigh-ins…',
  estimate_1rm: 'Working out your 1RMs…',
  muscle_balance: 'Checking your muscle balance…'
}

export default function AiChat() {
  const nav = useNavigate()
  // A conversation can arrive already knowing what it is about — see openAboutWorkout in
  // sheets.jsx. The seed names a workout rather than carrying its context, so the view builds
  // that itself and the router only holds an id.
  const seed = useLocation().state?.seed
  const S = useStore(s => s.S)
  const [status, setStatus] = useState(null)
  const [turns, setTurns] = useState([])
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [step, setStep] = useState('')
  const [error, setError] = useState(null)
  const [spent, setSpent] = useState(null)
  const endRef = useRef(null)
  const boxRef = useRef(null)
  const abort = useRef(null)
  const seeded = useRef(false)

  useEffect(() => { api('/api/ai/status').then(setStatus).catch(() => setStatus({ enabled: false })) }, [])
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' }) }, [turns, busy])

  // The composer is fixed, so the page needs room underneath it for the last message to clear.
  // Scoped to this screen, and taken off again on the way out.
  useEffect(() => {
    const app = document.getElementById('app')
    app?.classList.add('chat')
    return () => app?.classList.remove('chat')
  }, [])

  // Grow with the text, up to the ceiling the stylesheet sets.
  //
  // Driven off `draft` rather than called from the change handler, because the handler runs
  // BEFORE React re-renders: measuring there reads the textarea's previous contents, so clearing
  // the box after sending left the composer as tall as the message that had just gone.
  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 132) + 'px'
  }, [draft])

  /**
   * One exchange: show the turns, send them, show what came back.
   *
   * `asked` is what the screen displays and what run() is given; a turn may carry a `label` for
   * the first, which is how a seeded conversation shows "How did this session go?" while actually
   * sending the whole session as context. Providers only read role and content, so the extra key
   * rides along harmlessly.
   */
  const ask = async (asked, request) => {
    setError(null)
    setBusy(true)
    abort.current = new AbortController()
    setTurns(asked)
    try {
      const sent = request.messages
      const res = await run({
        ...request,
        provider: status.provider,
        model: status.model,
        signal: abort.current.signal,
        toolbox: Object.fromEntries(Object.entries(request.toolbox || {}).map(([name, fn]) => [name, input => {
          setStep(name)
          return fn(input)
        }]))
      })
      // The turns run() produced, not the copy it was given — the screen keeps the whole
      // conversation even though only the tail is ever sent.
      setTurns([...asked, ...res.turns.slice(sent.length)])
      const price = priceOf(status.models, status.provider, status.model)
      setSpent({ cost: costOf(price, res.usage), spend: res.spend })
      // A run can succeed and still say nothing. Silence would read as the app being broken.
      const nothing = emptyAnswer(res)
      if (nothing) setError(new Error(nothing === 'max_tokens'
        ? t('It ran out of room before it finished. Try asking something narrower.')
        : t('It came back with nothing to say. Try again, or ask it something narrower.')))
    } catch (e) {
      // Cancelling leaves the question on screen with no answer under it, which is exactly what
      // happened. An error message would claim something went wrong.
      if (!abort.current?.signal.aborted) setError(e)
    } finally {
      setBusy(false)
      setStep('')
    }
  }

  const send = () => {
    const text = draft.trim()
    if (!text || busy) return
    setDraft('')
    const asked = [...turns, userTurn(text)]
    // Follow-ups are ordinary chat: the tools come back, so "and how does that compare to last
    // month?" can be answered without the session having to have been in the first prompt.
    ask(asked, chatRequest(S, trimHistory(asked), { lang: S.lang }))
  }

  // A seeded conversation opens with the analysis already running, so the screen the person
  // arrives at is the answer they asked for rather than an empty box.
  useEffect(() => {
    if (seeded.current || !seed || !status?.enabled || !status?.configured || !status?.readable) return
    seeded.current = true
    const request = evaluateWorkoutRequest(S, seed.id, { lang: S.lang })
    if (!request) return
    ask([{ ...request.messages[0], label: t('How did this session go?') }], request)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed, status])
  const model = labelOf(status?.models, status?.provider, status?.model)

  const header = <div className="hdr">
    <button className="iconbtn" aria-label={t('Home')} onClick={() => nav('/home')}><Icon name="chevronLeft" /></button>
    <div style={{ textAlign: 'center' }}>
      <div style={{ fontWeight: 600 }}>{t('Ask about your training')}</div>
      {model && <div className="sub">{model}</div>}
    </div>
    <span style={{ width: 34 }} />
  </div>

  if (status && !status.enabled) {
    return <div>{header}<div className="empty">{t('The AI assistant is switched off on this server.')}</div></div>
  }
  if (status && (!status.configured || !status.readable)) {
    return <div>{header}
      <div className="empty">
        <div className="ico"><Icon name="key" /></div>
        {t('Add your own API key in Settings to use this.')}
      </div>
      <Button icon="gear" onClick={() => nav('/settings')}>{t('Settings')}</Button>
    </div>
  }

  const visible = turns.filter(turn => isQuestion(turn) || (turn.role === 'assistant' && textOf(turn)))
  const lastIsAnswer = visible.length > 0 && visible[visible.length - 1].role === 'assistant'

  return <>
    {header}

    {!visible.length && !busy && (
      <div className="empty">
        <div className="ico"><Icon name="sparkles" /></div>
        {t('It can read your routines, sessions, body weight and muscle balance — and nothing else. It cannot change anything.')}
      </div>
    )}

    <div className="chat-log">
      {visible.map((turn, i) => turn.role === 'user'
        ? <div key={i} className="msg-mine">{turn.label || textOf(turn)}</div>
        : <div key={i} className="msg-theirs"><Markdown text={textOf(turn)} /></div>)}

      {busy && <div className="chat-status">
        <span className="dot" />
        {t(DOING[step] || 'Asking your AI assistant…')}
        <Button size="sm" variant="ghost" className="dim" style={{ marginLeft: 2 }}
          onClick={() => abort.current?.abort()}>{t('Cancel')}</Button>
      </div>}

      {error && <div className="chat-status" style={{ color: 'var(--red)' }}>
        {error.code === 'ai-cap'
          ? t('This month’s spending cap has been reached. Raise it in Settings, or wait for the next month.')
          : error.message || t('That did not work')}
      </div>}

      {/* Under the answer it belongs to, rather than pinned somewhere as a permanent disclaimer:
          it went to a third party, and it cost something. Both are worth saying each time. */}
      {lastIsAnswer && !busy && (
        <div className="msg-meta">
          {t('Written by {0} — check it before you act on it.', model)}
          {spent?.cost != null && ' · ' + t('This answer cost about {0}.', fmtUSD(spent.cost))}
        </div>
      )}
    </div>

    <div ref={endRef} />

    <div className="composer">
      <textarea
        ref={boxRef}
        rows={1}
        maxLength={800}
        value={draft}
        disabled={busy}
        placeholder={t('What did I bench last week?')}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
      />
      <button className="send" disabled={busy || !draft.trim()} onClick={send} aria-label={t('Send')}>
        <Icon name="arrowUp" />
      </button>
    </div>
  </>
}
