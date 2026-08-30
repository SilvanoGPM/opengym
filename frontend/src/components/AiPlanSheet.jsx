// Building a training week with the model, and showing it before it lands.
//
// The only place in this feature where an LLM's output becomes data the user keeps, so it is the
// only one with a confirmation step. Nothing is written until the preview has been read and the
// button pressed; `mergePlan` then adds the routines with fresh ids and never overwrites theirs.
import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store/useStore.js'
import { api } from '../lib/api.js'
import { run } from '../lib/ai/run.js'
import { buildRoutineRequest, replaceExerciseRequest } from '../lib/ai/actions.js'
import { mergePlan } from '../lib/plan-share.js'
import { costOf, priceOf, labelOf, fmtUSD } from '../lib/ai/pricing.js'
import { t } from '../lib/i18n.js'
import { DAYN } from '../lib/format.js'
import Icon from './Icon.jsx'
import AiExerciseRow from './AiExerciseRow.jsx'
import { Button, Switch } from './ui.jsx'

/** Ask, then wait, then decide. */
export default function AiPlanSheet({ close, onInspect }) {
  const S = useStore(s => s.S)
  const update = useStore(s => s.update)
  const [phase, setPhase] = useState('ask')
  const [ask, setAsk] = useState('')
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [schedule, setSchedule] = useState(true)
  const [step, setStep] = useState('')
  const [status, setStatus] = useState(null)
  const [swapping, setSwapping] = useState('')
  const [swapError, setSwapError] = useState(null)
  const running = useRef(false)
  const abort = useRef(null)

  const go = async () => {
    if (running.current) return
    running.current = true
    abort.current = new AbortController()
    setPhase('working')
    try {
      const status = await api('/api/ai/status')
      setStatus(status)
      if (!status.enabled) throw Object.assign(new Error(t('The AI assistant is switched off on this server.')), { code: 'ai-off' })
      if (!status.configured || !status.readable) throw Object.assign(new Error(t('Add your own API key in Settings to use this.')), { code: 'ai-nokey' })

      const { request, capture } = buildRoutineRequest(S, { ask: ask.trim(), lang: S.lang })
      // The tool calls ARE the progress bar. A model searching the library for legs is doing
      // something a spinner cannot say, and this run takes long enough to be worth saying it.
      const res = await run({
        ...request,
        provider: status.provider,
        model: status.model,
        signal: abort.current.signal,
        toolbox: Object.fromEntries(Object.entries(request.toolbox).map(([name, fn]) => [name, input => {
          setStep(name === 'submit_plan' ? t('Writing the plan…') : t('Looking through the exercise library…'))
          return fn(input)
        }]))
      })

      if (!capture.plan) {
        throw new Error(res.stopReason === 'max_steps'
          ? t('It kept searching and never settled on a plan. Try asking for something more specific.')
          : t('It did not come back with a usable plan. Try again, or ask for something more specific.'))
      }

      const price = priceOf(status.models, status.provider, status.model)
      setResult({
        ...capture.plan,
        cost: costOf(price, res.usage),
        model: labelOf(status.models, status.provider, status.model),
        spend: res.spend
      })
      setPhase('preview')
    } catch (e) {
      // Back to the question rather than closed: they typed something, and after an
      // accidental send the next thing they want is to fix it, not to start over.
      if (abort.current?.signal.aborted) { setPhase('ask'); return }
      setError(e)
      setPhase('error')
    } finally {
      running.current = false
    }
  }

  /** Ask for a different exercise in one slot of one day. Preview only; nothing is written. */
  const swap = async (ri, ei) => {
    const key = ri + ':' + ei
    if (swapping) return
    setSwapping(key)
    setSwapError(null)
    try {
      const routine = result.bundle.routines[ri]
      const { request, capture } = replaceExerciseRequest(S, {
        routineName: routine.name,
        replacing: routine.ex[ei],
        // Everything else in the WEEK, not just this day: a plan that puts the same movement in
        // two days because one of them was swapped is worse than the one it replaced.
        keeping: result.bundle.routines.flatMap((r, n) => r.ex.filter((_, i) => !(n === ri && i === ei))),
        ask: ask.trim(),
        lang: S.lang
      })
      await run({ ...request, provider: status.provider, model: status.model })
      if (!capture.result) throw new Error(t('It could not find a different exercise for that slot.'))
      setResult(r => ({
        ...r,
        bundle: {
          ...r.bundle,
          routines: r.bundle.routines.map((rt, n) => (n !== ri ? rt : {
            ...rt, ex: rt.ex.map((e, i) => (i === ei ? capture.result.ex : e))
          }))
        }
      }))
    } catch (e) {
      // A failed swap leaves the original in place rather than blanking the row.
      setSwapError(e.message || t('That did not work'))
    } finally {
      setSwapping('')
    }
  }

  const apply = () => {
    update(s => { mergePlan(s, result.bundle, { schedule }) })
    close()
  }

  if (phase === 'ask') {
    return <>
      <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Icon name="sparkles" /> {t('Build me a plan')}</h3>
      <div className="muted small" style={{ marginBottom: 12, lineHeight: 1.5 }}>
        {t('It reads what you have trained lately and what equipment you have, then picks exercises from this app’s own library. Nothing is added until you have seen it.')}
      </div>
      <textarea className="input" rows={3} maxLength={400} value={ask} onChange={e => setAsk(e.target.value)}
        placeholder={t('Optional: how many days, what you want to focus on, anything to avoid.')} />
      <div style={{ height: 12 }} />
      <Button variant="primary" onClick={go}>{t('Build it')}</Button>
      <div style={{ height: 8 }} />
      <Button variant="ghost" className="dim" onClick={close}>{t('Cancel')}</Button>
    </>
  }

  if (phase === 'working') {
    return <div style={{ padding: '28px 0', textAlign: 'center' }}>
      <div className="muted">{step || t('Asking your AI assistant…')}</div>
      <div className="dim small" style={{ marginTop: 6 }}>{t('This one takes longer — it searches the library first.')}</div>
      <div style={{ height: 16 }} />
      {/* Aborting closes the socket, and the server drops the provider call when that
          happens — so this stops the spending, not just the waiting. */}
      <Button variant="ghost" className="dim" onClick={() => abort.current?.abort()}>{t('Cancel')}</Button>
    </div>
  }

  if (phase === 'error') {
    return <div style={{ textAlign: 'center', padding: '8px 0' }}>
      <h3 style={{ marginBottom: 8 }}>{t('Build me a plan')}</h3>
      <div className="muted" style={{ marginBottom: 18, lineHeight: 1.5 }}>
        {error?.code === 'ai-cap'
          ? t('This month’s spending cap has been reached. Raise it in Settings, or wait for the next month.')
          : error?.message || t('That did not work')}
      </div>
      <Button variant="ghost" className="dim" onClick={close}>{t('Close')}</Button>
    </div>
  }

  // preview
  const dayOf = id => {
    const d = Object.entries(result.bundle.week || {}).find(([, rid]) => rid === id)
    return d ? t(DAYN[+d[0]]) : null
  }

  return <div>
    <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <Icon name="sparkles" /> {result.bundle.name || t('Suggested plan')}
    </h3>
    {result.summary && <div className="muted small" style={{ margin: '8px 0 14px', lineHeight: 1.5 }}>{result.summary}</div>}

    {result.dropped > 0 && (
      // Said out loud rather than left in the numbers: a plan that lost exercises is not the
      // plan the summary above describes.
      <div className="dim small" style={{ marginBottom: 12 }}>
        <Icon name="warning" style={{ verticalAlign: '-2px', marginRight: 4 }} />
        {t('{0} exercise(s) it named do not exist in this library and were left out.', result.dropped)}
      </div>
    )}

    {result.bundle.routines.map((r, ri) => (
      <div key={r.id} className="card" style={{ marginBottom: 10 }}>
        <div className="row" style={{ alignItems: 'baseline', justifyContent: 'space-between' }}>
          <div style={{ fontWeight: 600 }}>{r.name}</div>
          <div className="dim small">{dayOf(r.id) || t('Not scheduled')}</div>
        </div>
        <div style={{ marginTop: 6 }}>
          {r.ex.map((e, i) => (
            <AiExerciseRow key={e.id + ':' + i} ex={e} unit={S.unit || 'kg'}
              onInspect={onInspect} onSwap={() => swap(ri, i)} swapping={swapping === ri + ':' + i} />
          ))}
        </div>
      </div>
    ))}

    {swapError && <div className="dim small" style={{ marginBottom: 8, color: 'var(--red)' }}>{swapError}</div>}

    <div className="lrow" style={{ marginTop: 4 }}>
      <span className="lrow-m">
        <span className="lrow-t">{t('Use its weekly schedule')}</span>
        <span className="lrow-s">{t('Replaces your current week. Your existing routines are kept either way.')}</span>
      </span>
      <Switch checked={schedule} onChange={setSchedule} />
    </div>

    <div className="dim small" style={{ margin: '12px 0', lineHeight: 1.6 }}>
      {t('Written by {0} — check it before you act on it.', result.model)}
      {result.cost != null && <><br />{t('This answer cost about {0}.', fmtUSD(result.cost))}</>}
    </div>

    <Button variant="primary" onClick={apply}>
      {t('Add {0} routine(s) to my plan', result.routineCount)}
    </Button>
    <div style={{ height: 8 }} />
    <Button variant="ghost" className="dim" onClick={close}>{t('Discard')}</Button>
  </div>
}
