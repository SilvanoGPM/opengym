// Leaderboard: turning a period into a date range, and rows into places.
//
// The server never computes either. It filters days between two ISO strings and sums a field the
// workout already carried; the calendar and the ranking live here, next to their tests, because
// week boundaries and ties are exactly the kind of thing that looks right and isn't.

import { isoOf, weekKey, startOfWeek, MONDAY } from './format.js'

const LB_TO_KG = 0.45359237

export const PERIODS = ['week', 'month', 'year', 'all']

/**
 * The [from, to] range a period covers, both ends inclusive.
 *
 * The week starts where the viewer's does (S.weekStart, through startOfWeek) — the same week the
 * Home strip and every "this week" total count, because a ranking that reset on a different day
 * than those would just look broken.
 *
 * 'all' returns bounds rather than null so the caller never needs a second code path; they're
 * outside any date a human logs, and the comparison is on strings anyway.
 */
export function rangeFor(period, todayIso, ws = MONDAY) {
  const [y, m] = todayIso.split('-').map(Number)
  if (period === 'month') return { from: todayIso.slice(0, 7) + '-01', to: isoOf(new Date(y, m, 0)) }
  if (period === 'year') return { from: y + '-01-01', to: y + '-12-31' }
  if (period === 'all') return { from: '0000-01-01', to: '9999-12-31' }

  const first = startOfWeek(todayIso, ws)
  const last = new Date(first)
  last.setDate(first.getDate() + 6)
  return { from: isoOf(first), to: isoOf(last) }
}

/** True when `iso` falls in the same week as today — the same test the range above encodes. */
export const sameWeek = (iso, todayIso, ws = MONDAY) => weekKey(iso, ws) === weekKey(todayIso, ws)

/**
 * Rows in ranked order, each with the place it takes.
 *
 * Equal numbers share a place and the next one skips (1, 1, 3) — the standard everybody already
 * reads off a scoreboard, and the alternative silently invents an order between two people who
 * did exactly the same work. Name breaks the tie for display order only, so the list doesn't
 * shuffle between refreshes; the place stays shared.
 */
export function rankRows(rows, key, meUid) {
  const sorted = [...(rows || [])].sort((a, b) =>
    (b[key] || 0) - (a[key] || 0) || String(a.name || '').localeCompare(String(b.name || '')))

  let place = 0, prev = null
  return sorted.map((r, i) => {
    const v = r[key] || 0
    if (prev === null || v !== prev) { place = i + 1; prev = v }
    return { ...r, place, value: v, isMe: r.uid === meUid }
  })
}

/** kg back into the unit of whoever is looking — the inverse of toKg() on the server. */
export function volInUnit(volKg, unit) {
  const v = unit === 'lb' ? (volKg || 0) / LB_TO_KG : (volKg || 0)
  return Math.round(v * 10) / 10
}

/**
 * How many places away from the top somebody is, or null when they aren't on the board.
 * Used to keep your own row on screen when it falls outside the visible top.
 */
export function findMe(ranked) {
  const i = (ranked || []).findIndex(r => r.isMe)
  return i === -1 ? null : { row: ranked[i], index: i }
}
