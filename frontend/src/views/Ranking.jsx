import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { api } from '../lib/api.js'
import { t } from '../lib/i18n.js'
import { fmtDate, fmtVol, todayISO, weekStartOf } from '../lib/format.js'
import { findMe, rangeFor, rankRows, volInUnit } from '../lib/leaderboard.js'
import Avatar from '../components/Avatar.jsx'
import Icon from '../components/Icon.jsx'
import { Button, Section, Segmented } from '../components/ui.jsx'

// How the profiles on this instance compare — who showed up, and who moved the most weight.
//
// Two things this screen deliberately does not do. It doesn't show anybody who hasn't opted in
// (the server won't send them either), and it doesn't show what anyone lifted — a name, a count of
// days and a total are the whole of what crosses between profiles.

const TOP = 5

// English has no single ordinal suffix, so the key is the neutral form and each language
// pack renders the place its own way ("1º", "1st", "1.").
const ordinal = place => t('#{0}', place)

function Board({ title, rows, rankKey, meUid, format, footer }) {
  const ranked = rankRows(rows, rankKey, meUid)
  const shown = ranked.slice(0, TOP)
  const me = findMe(ranked)
  // A ranking you can't find yourself in is a ranking you stop opening. When your row falls past
  // the visible top it comes back pinned under a hairline rather than being cut off.
  const pinned = me && me.index >= TOP ? me.row : null

  const line = r => (
    <div key={r.uid} className={'lb-row' + (r.isMe ? ' me' : '')}>
      <Avatar uid={r.uid} name={r.name} />
      <span className="lb-m">
        <span className="lb-n">{r.name}{r.isMe && <em>{t('you')}</em>}</span>
        <span className="lb-s">{format(r.value)}</span>
      </span>
      <span className="lb-p">{ordinal(r.place)}</span>
    </div>
  )

  return (
    <Section title={title} footer={footer}>
      <div className="lb-list">
        {shown.map(line)}
        {pinned && <div className="lb-gap" aria-hidden="true">···</div>}
        {pinned && line(pinned)}
      </div>
    </Section>
  )
}

export default function Ranking() {
  const nav = useNavigate()
  const user = useStore(s => s.user)
  const unit = useStore(s => s.S.unit)
  const ws = useStore(s => weekStartOf(s.S))
  const toast = useUI(s => s.toast)

  const [period, setPeriod] = useState('week')
  const [data, setData] = useState(null)     // null = still loading

  const range = rangeFor(period, todayISO(), ws)

  const load = () => {
    setData(null)
    return api('/api/leaderboard?from=' + range.from + '&to=' + range.to)
      .then(setData)
      .catch(e => { setData({ rows: [], participants: 0, failed: true }); toast(e.message || t('Failed to load')) })
  }
  // Re-runs on the period and the week start, because the range is what the request is.
  useEffect(() => { load() }, [period, ws])

  const joined = user?.lb === true
  const rows = data?.rows || []
  const volUnknown = rows.reduce((n, r) => n + (r.volUnknown || 0), 0)

  const subtitle = period === 'all'
    ? t('All time')
    : fmtDate(range.from, false, period === 'year') + ' – ' + fmtDate(range.to, false, period === 'year')

  return <div className="narrow">
    <div className="hdr">
      <button className="iconbtn" onClick={() => nav('/home')} aria-label={t('Home')}><Icon name="chevronLeft" /></button>
      <div style={{ flex: 1, marginInlineStart: 8 }}>
        <h1 style={{ margin: 0 }}>{t('Ranking')}</h1>
        <div className="sub">{subtitle}</div>
      </div>
      <button className="iconbtn" onClick={load} aria-label={t('Refresh')}>↻</button>
    </div>

    <Segmented
      className="seg-range"
      options={[
        { value: 'week', label: t('Week') },
        { value: 'month', label: t('Month') },
        { value: 'year', label: t('Year') },
        { value: 'all', label: t('All') },
      ]}
      value={period} onChange={setPeriod}
    />

    {!joined ? (
      // Opting out is opting out of both directions — the server sends no rows either.
      <div className="card">
        <h2>{t('You’re not in the ranking')}</h2>
        <p className="muted small">{t('Join it in Settings to compare check-ins and volume with the other profiles on this server. You can leave again at any time.')}</p>
        <Button onClick={() => nav('/settings')}>{t('Open Settings')}</Button>
      </div>
    ) : data === null ? (
      <div className="muted small">{t('Loading…')}</div>
    ) : data.participants < 2 ? (
      // The likeliest state on a self-hosted instance, so it gets a real answer instead of a
      // podium of one.
      <div className="card">
        <h2>{t('Nobody to compare with yet')}</h2>
        <p className="muted small">{t('You’re the only profile in the ranking so far. Anyone else with a profile on this server can join it from their own Settings.')}</p>
      </div>
    ) : <>
      <Board
        title={t('Check-ins')} rows={rows} rankKey="checkins" meUid={data.me}
        format={n => t(n === 1 ? '{0} check-in' : '{0} check-ins', n)}
        footer={t('One per day you trained — going twice in a day still counts once.')}
      />
      <Board
        title={t('Volume')} rows={rows} rankKey="volKg" meUid={data.me}
        format={v => fmtVol(volInUnit(v, unit), unit)}
        footer={volUnknown
          // Plural forms are not automatic when the English string is the key (see exCount).
          ? t(volUnknown === 1
            ? 'Weight × reps, warm-ups excluded. {0} imported session carries no volume and is not counted.'
            : 'Weight × reps, warm-ups excluded. {0} imported sessions carry no volume and are not counted.', volUnknown)
          : t('Weight × reps, warm-ups excluded.')}
      />
    </>}
  </div>
}
