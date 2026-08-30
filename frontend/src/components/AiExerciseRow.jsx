// One suggested exercise, in a preview you have not accepted yet.
//
// A name alone is not enough to judge a suggestion: "cable kickback" and "lever seated fly" mean
// very little until you see the movement. So the row carries the same thumbnail the rest of the
// app uses and opens the same detail sheet — picture, muscles, equipment, instructions — before
// anything is added to a routine.
//
// `onInspect` arrives as a prop rather than being imported. sheets.jsx already imports the sheets
// this row lives in, so reaching back into it for exerciseDetailSheet would close an import cycle.
import { exOr } from '../lib/exercises.js'
import { exerciseNameFor } from '../lib/i18n.js'
import { exLine } from '../lib/history.js'
import { t } from '../lib/i18n.js'
import { Thumb } from './Media.jsx'
import Icon from './Icon.jsx'

/**
 * @param {object} p
 * @param {object} p.ex          a routine entry: { id, sets, reps, ... }
 * @param {string} p.unit
 * @param {Function} [p.onInspect] called with the catalogue exercise when the row is tapped
 * @param {Function} [p.onSwap]    called to ask for a different exercise in this slot
 * @param {boolean}  [p.swapping]  a swap is in flight for this row
 */
export default function AiExerciseRow({ ex, unit, onInspect, onSwap, swapping }) {
  const item = exOr(ex.id)
  const inspect = () => onInspect && !item.missing && onInspect(item)

  return (
    <div className="row" style={{ gap: 10, alignItems: 'center', padding: '6px 0', opacity: swapping ? 0.5 : 1 }}>
      <button
        className="plain"
        style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0, textAlign: 'left', background: 'none', border: 0, padding: 0, font: 'inherit', color: 'inherit', cursor: onInspect ? 'pointer' : 'default' }}
        onClick={inspect}
        aria-label={t('Details')}
      >
        <Thumb ex={item} />
        <span className="grow" style={{ minWidth: 0 }}>
          <span className="tt capitalize" style={{ display: 'block' }}>{exerciseNameFor(item)}</span>
          <span className="ss">{exLine({ ...ex }, unit)}</span>
        </span>
      </button>

      {onSwap && (
        <button className="iconbtn" disabled={swapping} onClick={onSwap}
          aria-label={t('Suggest a different exercise')} title={t('Suggest a different exercise')}>
          <Icon name="shuffle" />
        </button>
      )}
    </div>
  )
}
