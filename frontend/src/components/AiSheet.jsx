// The sheet an AI answer arrives in.
//
// It fetches /api/ai/status rather than reading a provider and model out of the store: those
// are saved next to the key on the server, and asking the side that actually makes the call
// means the sheet can never send a request against a key that has since been replaced.
import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api.js'
import { run, emptyAnswer } from '../lib/ai/run.js'
import { parseMarkdown } from '../lib/ai/md.js'
import { costOf, priceOf, labelOf, fmtUSD } from '../lib/ai/pricing.js'
import { t } from '../lib/i18n.js'
import Icon from './Icon.jsx'
import { Button } from './ui.jsx'

/** Renders parseMarkdown's blocks as elements. No HTML string ever exists — see lib/ai/md.js. */
function Spans({ spans }) {
  return spans.map((s, i) =>
    s.bold ? <strong key={i}>{s.text}</strong>
      : s.code ? <code key={i} className="small">{s.text}</code>
        : <span key={i}>{s.text}</span>)
}

export function Markdown({ text }) {
  return parseMarkdown(text).map((b, i) => {
    if (b.type === 'h') {
      const size = b.level <= 2 ? 16 : 14
      return <div key={i} style={{ fontWeight: 700, fontSize: size, margin: i ? '18px 0 6px' : '0 0 6px' }}>
        <Spans spans={b.spans} />
      </div>
    }
    if (b.type === 'ul' || b.type === 'ol') {
      const List = b.type === 'ul' ? 'ul' : 'ol'
      return <List key={i} style={{ margin: '6px 0 10px', paddingLeft: 20, lineHeight: 1.55 }}>
        {b.items.map((item, j) => <li key={j} style={{ marginBottom: 4 }}><Spans spans={item} /></li>)}
      </List>
    }
    return <p key={i} style={{ margin: '0 0 10px', lineHeight: 1.55 }}><Spans spans={b.spans} /></p>
  })
}

/**
 * @param {object} p
 * @param {string} p.title
 * @param {{system: string, messages: Array, maxTokens: number}} p.request
 * @param {Function} p.close
 */
/**
 * One question, start to finish: what to show, as a plain value.
 *
 * Pulled out of the component so it can be started ONCE and awaited by however many mounts
 * React decides to give us.
 */
async function ask(request, signal) {
  try {
    const status = await api('/api/ai/status')
    if (!status.enabled) return { phase: 'off' }
    if (!status.configured || !status.readable) return { phase: 'nokey', status }

    const res = await run({ ...request, provider: status.provider, model: status.model, signal })
    // Succeeding with nothing to show is a real outcome on a reasoning model, and rendering it
    // as a blank sheet reads as a bug rather than as the model running out of room.
    const nothing = emptyAnswer(res)
    if (nothing) {
      return { phase: 'error', error: new Error(nothing === 'max_tokens'
        ? t('It ran out of room before it finished. Try asking something narrower.')
        : t('It came back with nothing to say. Try again, or ask it something narrower.')) }
    }
    const price = priceOf(status.models, status.provider, status.model)
    return {
      phase: 'done',
      text: res.text,
      stopReason: res.stopReason,
      cost: costOf(price, res.usage),
      model: labelOf(status.models, status.provider, status.model),
      spend: res.spend || status.spend
    }
  } catch (e) {
    // Cancelling is not a failure. Without this the person who pressed Cancel would be shown
    // "The operation was aborted", which reads like something went wrong.
    if (signal?.aborted) return { phase: 'cancelled' }
    return { phase: 'error', error: e }
  }
}

export default function AiSheet({ title, request, close }) {
  const [state, setState] = useState({ phase: 'loading' })
  // StrictMode runs every effect twice in development — mount, clean up, mount again — and an
  // answer is not free, so the work has to start exactly once. The ref holds the PROMISE, not a
  // has-started flag: the second mount attaches to the same in-flight request instead of being
  // turned away. Turning it away is what broke this the first time round, and it broke it
  // completely: the first mount's cleanup had already fired, so the answer came back to nobody
  // and the sheet said "asking..." forever. Production has no double mount and hid it entirely.
  const job = useRef(null)
  const abort = useRef(null)

  useEffect(() => {
    let live = true
    if (!job.current) {
      abort.current = new AbortController()
      job.current = ask(request, abort.current.signal)
    }
    // ask() catches everything and resolves to a phase, so this cannot reject today. The
    // catch is here because the failure mode if it ever does is the worst one available:
    // the sheet sits on "asking..." with nothing to say and no way to find out why.
    job.current.then(
      next => { if (live) setState(next) },
      e => { if (live) setState({ phase: 'error', error: e }) }
    )
    return () => { live = false }
  }, [request])

  if (state.phase === 'loading') {
    // Text, not a spinner: nothing else in this app spins, and Admin already says "Loading…".
    return <div style={{ padding: '28px 0', textAlign: 'center' }}>
      <div className="muted">{t('Asking your AI assistant…')}</div>
      <div className="dim small" style={{ marginTop: 6 }}>{t('This usually takes a few seconds.')}</div>
      <div style={{ height: 16 }} />
      {/* Aborting the fetch is what closes the socket, and the server drops the provider call
          when that happens — so this stops the spending, not just the waiting. */}
      <Button variant="ghost" className="dim" onClick={() => { abort.current?.abort(); close() }}>{t('Cancel')}</Button>
    </div>
  }

  if (state.phase === 'cancelled') { close(); return null }

  if (state.phase === 'off' || state.phase === 'nokey') {
    return <div style={{ textAlign: 'center', padding: '8px 0' }}>
      <h3 style={{ marginBottom: 8 }}>{title}</h3>
      <div className="muted" style={{ marginBottom: 18, lineHeight: 1.5 }}>
        {state.phase === 'off'
          ? t('The AI assistant is switched off on this server.')
          : state.status?.configured
            ? t('Your saved API key could not be read. Open Settings and save it again.')
            : t('Add your own API key in Settings to use this.')}
      </div>
      <Button variant="ghost" className="dim" onClick={close}>{t('Close')}</Button>
    </div>
  }

  if (state.phase === 'error') {
    const e = state.error || {}
    // The server hands back a code for the things worth explaining rather than just reporting.
    const msg = e.code === 'ai-cap'
      ? t('This month’s spending cap has been reached. Raise it in Settings, or wait for the next month.')
      : e.code === 'ai-unreadable'
        ? t('Your saved API key could not be read. Open Settings and save it again.')
        : e.message || t('That did not work')
    return <div style={{ textAlign: 'center', padding: '8px 0' }}>
      <h3 style={{ marginBottom: 8 }}>{title}</h3>
      <div className="muted" style={{ marginBottom: 18, lineHeight: 1.5 }}>{msg}</div>
      <Button variant="ghost" className="dim" onClick={close}>{t('Close')}</Button>
    </div>
  }

  return <div>
    <h3 style={{ marginBottom: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
      <Icon name="sparkles" /> {title}
    </h3>
    <div style={{ margin: '14px 0 4px' }}>
      <Markdown text={state.text} />
    </div>
    {state.stopReason === 'max_tokens' && (
      <div className="dim small" style={{ marginTop: 10 }}>{t('The answer was cut short.')}</div>
    )}
    <div className="dim small" style={{ marginTop: 16, lineHeight: 1.6 }}>
      {/* Said every time, not buried in Settings: this went to a third party, and it cost
          something. Both are facts the person should be reminded of at the moment it happened. */}
      {t('Written by {0} — check it before you act on it.', state.model)}
      {state.cost != null && <><br />{t('This answer cost about {0}.', fmtUSD(state.cost))}</>}
      {state.spend && <><br />{t('{0} this month.', fmtUSD(state.spend.usd))}</>}
    </div>
    <div style={{ height: 14 }} />
    <Button variant="ghost" className="dim" onClick={close}>{t('Close')}</Button>
  </div>
}
