// Filling in one empty routine with the model.
//
// The small sibling of AiPlanSheet: same three-step shape (ask, wait, decide) and the same rule
// that nothing is written until the preview has been read. The difference is where it lands —
// this appends into a routine the user already made and already named, so the name IS the brief
// and nothing here renames or reschedules anything.
import { useRef, useState } from 'react'
import { useStore } from '../store/useStore.js'
import { api } from '../lib/api.js'
import { run } from '../lib/ai/run.js'
import { buildOneRoutineRequest, replaceExerciseRequest } from '../lib/ai/actions.js'
import { costOf, priceOf, labelOf, fmtUSD } from '../lib/ai/pricing.js'
import { t } from '../lib/i18n.js'
import Icon from './Icon.jsx'
import AiExerciseRow from './AiExerciseRow.jsx'
import { Button } from './ui.jsx'

/**
 * @param {object} p
 * @param {string} p.routineId  the routine to fill in — it must already exist
 * @param {Function} p.close
 */
export default function AiRoutineSheet({ routineId, close, onInspect }) {
  const S = useStore(s => s.S)
  const update = useStore(s => s.update)
  const routine = (S.routines || []).find(r => r.id === routineId)
  const [phase, setPhase] = useState('ask')
  const [ask, setAsk] = useState('')
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [step, setStep] = useState('')
  const [status, setStatus] = useState(null)
  const [swapping, setSwapping] = useState(-1)
  const [swapError, setSwapError] = useState(null)
  const running = useRef(false)
  const abort = useRef(null)

  if (!routine) return null

  const go = async () => {
    if (running.current) return
    running.current = true
    abort.current = new AbortController()
    setPhase('working')
    try {
      const status = await api('/api/ai/status')
      setStatus(status)
      if (!status.enabled) throw new Error(t('The AI assistant is switched off on this server.'))
      if (!status.configured || !status.readable) throw new Error(t('Add your own API key in Settings to use this.'))

      const { request, capture } = buildOneRoutineRequest(S, { name: routine.name, ask: ask.trim(), lang: S.lang })
      const res = await run({
        ...request,
        provider: status.provider,
        model: status.model,
        signal: abort.current.signal,
        toolbox: Object.fromEntries(Object.entries(request.toolbox).map(([name, fn]) => [name, input => {
          setStep(name === 'submit_exercises' ? t('Writing the routine…') : t('Looking through the exercise library…'))
          return fn(input)
        }]))
      })

      if (!capture.result) {
        throw new Error(res.stopReason === 'max_steps'
          ? t('It kept searching and never settled on a routine. Try asking for something more specific.')
          : t('It did not come back with usable exercises. Try again, or ask for something more specific.'))
      }

      const price = priceOf(status.models, status.provider, status.model)
      setResult({
        ...capture.result,
        cost: costOf(price, res.usage),
        model: labelOf(status.models, status.provider, status.model)
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

  /**
   * Ask for a different exercise in one slot.
   *
   * Nothing is written here either — it swaps the row in the preview, and the whole preview is
   * still discardable. The model is told what is staying so it cannot hand back something that
   * is already in the list.
   */
  const swap = async i => {
    if (swapping >= 0) return
    setSwapping(i)
    setSwapError(null)
    try {
      const { request, capture } = replaceExerciseRequest(S, {
        routineName: routine.name,
        replacing: result.ex[i],
        keeping: result.ex.filter((_, n) => n !== i),
        ask: ask.trim(),
        lang: S.lang
      })
      await run({ ...request, provider: status.provider, model: status.model })
      if (!capture.result) throw new Error(t('It could not find a different exercise for that slot.'))
      setResult(r => ({ ...r, ex: r.ex.map((e, n) => (n === i ? capture.result.ex : e)) }))
    } catch (e) {
      // A failed swap leaves the original in place. Blanking the row would lose a suggestion
      // the user might well have been happy with.
      setSwapError(e.message || t('That did not work'))
    } finally {
      setSwapping(-1)
    }
  }

  const apply = () => {
    update(s => {
      const target = s.routines.find(r => r.id === routineId)
      if (!target) return
      // Appended, not assigned. The button only appears on an empty routine, but the user can
      // add an exercise by hand while this sheet is open, and losing that would be theft.
      target.ex = [...(target.ex || []), ...result.ex]
    })
    close()
  }

  if (phase === 'ask') {
    return <>
      <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Icon name="sparkles" /> {t('Fill in this routine')}</h3>
      <div className="muted small" style={{ marginBottom: 12, lineHeight: 1.5 }}>
        {t('It goes by the name you gave it — “{0}” — plus your recent training and the equipment you have. Nothing is added until you have seen it.', routine.name)}
      </div>
      <textarea className="input" rows={3} maxLength={400} value={ask} onChange={e => setAsk(e.target.value)}
        placeholder={t('Optional: how many exercises, what to include, anything to avoid.')} />
      <div style={{ height: 12 }} />
      <Button variant="primary" onClick={go}>{t('Fill it in')}</Button>
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
      <h3 style={{ marginBottom: 8 }}>{t('Fill in this routine')}</h3>
      <div className="muted" style={{ marginBottom: 18, lineHeight: 1.5 }}>
        {error?.code === 'ai-cap'
          ? t('This month’s spending cap has been reached. Raise it in Settings, or wait for the next month.')
          : error?.message || t('That did not work')}
      </div>
      <Button variant="ghost" className="dim" onClick={close}>{t('Close')}</Button>
    </div>
  }

  return <div>
    <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><Icon name="sparkles" /> {routine.name}</h3>
    {result.summary && <div className="muted small" style={{ margin: '8px 0 14px', lineHeight: 1.5 }}>{result.summary}</div>}

    {result.dropped > 0 && (
      <div className="dim small" style={{ marginBottom: 12 }}>
        <Icon name="warning" style={{ verticalAlign: '-2px', marginRight: 4 }} />
        {t('{0} exercise(s) it named do not exist in this library and were left out.', result.dropped)}
      </div>
    )}

    <div className="card">
      {result.ex.map((e, i) => (
        <AiExerciseRow key={e.id + ':' + i} ex={e} unit={S.unit || 'kg'}
          onInspect={onInspect} onSwap={() => swap(i)} swapping={swapping === i} />
      ))}
    </div>
    {swapError && <div className="dim small" style={{ marginTop: 6, color: 'var(--red)' }}>{swapError}</div>}

    <div className="dim small" style={{ margin: '12px 0', lineHeight: 1.6 }}>
      {t('Written by {0} — check it before you act on it.', result.model)}
      {result.cost != null && <><br />{t('This answer cost about {0}.', fmtUSD(result.cost))}</>}
    </div>

    <Button variant="primary" onClick={apply}>{t('Add {0} exercise(s)', result.ex.length)}</Button>
    <div style={{ height: 8 }} />
    <Button variant="ghost" className="dim" onClick={close}>{t('Discard')}</Button>
  </div>
}
