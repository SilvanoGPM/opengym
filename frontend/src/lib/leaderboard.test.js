import { describe, it, expect } from 'vitest'
import { findMe, PERIODS, rangeFor, rankRows, sameWeek, volInUnit } from './leaderboard.js'
import { weekKey, SUNDAY } from './format.js'

const R = (uid, name, checkins, volKg = 0) => ({ uid, name, checkins, volKg })

describe('rangeFor', () => {
  it('covers the ISO week the app already counts, Monday through Sunday', () => {
    // 2026-08-30 is a Sunday — the end of its week, not the start of the next one.
    expect(rangeFor('week', '2026-08-30')).toEqual({ from: '2026-08-24', to: '2026-08-30' })
    expect(rangeFor('week', '2026-08-24')).toEqual({ from: '2026-08-24', to: '2026-08-30' })
    expect(rangeFor('week', '2026-08-27')).toEqual({ from: '2026-08-24', to: '2026-08-30' })
  })

  it('agrees with weekKey, which is what the rest of the app ranks by', () => {
    for (const d of ['2026-01-01', '2026-08-30', '2026-12-31', '2024-02-29']) {
      const { from, to } = rangeFor('week', d)
      expect(weekKey(from)).toBe(weekKey(d))
      expect(weekKey(to)).toBe(weekKey(d))
    }
  })

  it('ends the month on the day the month actually ends', () => {
    expect(rangeFor('month', '2026-02-10')).toEqual({ from: '2026-02-01', to: '2026-02-28' })
    expect(rangeFor('month', '2024-02-10')).toEqual({ from: '2024-02-01', to: '2024-02-29' })  // leap
    expect(rangeFor('month', '2026-08-30')).toEqual({ from: '2026-08-01', to: '2026-08-31' })
    expect(rangeFor('month', '2026-04-01')).toEqual({ from: '2026-04-01', to: '2026-04-30' })
  })

  it('covers the calendar year and, for all-time, anything a human could log', () => {
    expect(rangeFor('year', '2026-08-30')).toEqual({ from: '2026-01-01', to: '2026-12-31' })
    const all = rangeFor('all', '2026-08-30')
    expect(all.from < '1900-01-01').toBe(true)
    expect(all.to > '2100-01-01').toBe(true)
  })

  it('gives every period a from that is not after its to', () => {
    for (const p of PERIODS) {
      const { from, to } = rangeFor(p, '2026-01-01')
      expect(from <= to).toBe(true)
    }
  })

  it('crosses a year end without falling into the wrong week', () => {
    // 2026-01-01 is a Thursday: its ISO week starts back in December.
    expect(rangeFor('week', '2026-01-01')).toEqual({ from: '2025-12-29', to: '2026-01-04' })
  })

  it('starts the week on Sunday for a profile whose week does', () => {
    // 2026-08-30 is a Sunday: the first day of a Sunday week, the last of a Monday one.
    expect(rangeFor('week', '2026-08-30', SUNDAY)).toEqual({ from: '2026-08-30', to: '2026-09-05' })
    expect(rangeFor('week', '2026-08-29', SUNDAY)).toEqual({ from: '2026-08-23', to: '2026-08-29' })
    for (const d of ['2026-01-01', '2026-08-30', '2026-12-31']) {
      const { from, to } = rangeFor('week', d, SUNDAY)
      expect(weekKey(from, SUNDAY)).toBe(weekKey(d, SUNDAY))
      expect(weekKey(to, SUNDAY)).toBe(weekKey(d, SUNDAY))
    }
  })
})

describe('sameWeek', () => {
  it('is the week boundary the range uses, not a rolling seven days', () => {
    expect(sameWeek('2026-08-24', '2026-08-30')).toBe(true)
    expect(sameWeek('2026-08-23', '2026-08-30')).toBe(false)   // six days back, previous week
    expect(sameWeek('2026-08-23', '2026-08-29', SUNDAY)).toBe(true)
  })
})

describe('rankRows', () => {
  it('ranks by the chosen key, highest first', () => {
    const out = rankRows([R('a', 'Ana', 2), R('b', 'Bo', 5), R('c', 'Cy', 3)], 'checkins', 'a')
    expect(out.map(r => r.name)).toEqual(['Bo', 'Cy', 'Ana'])
    expect(out.map(r => r.place)).toEqual([1, 2, 3])
  })

  it('shares a place on a tie and skips the next one', () => {
    // Two people did the same work; inventing an order between them would be a lie.
    const out = rankRows([R('a', 'Ana', 5), R('b', 'Bo', 5), R('c', 'Cy', 1)], 'checkins', 'c')
    expect(out.map(r => r.place)).toEqual([1, 1, 3])
  })

  it('keeps a stable display order between refreshes when everything ties', () => {
    const rows = [R('c', 'Cy', 4), R('a', 'Ana', 4), R('b', 'Bo', 4)]
    expect(rankRows(rows, 'checkins', 'a').map(r => r.name)).toEqual(['Ana', 'Bo', 'Cy'])
    expect(rankRows([...rows].reverse(), 'checkins', 'a').map(r => r.name)).toEqual(['Ana', 'Bo', 'Cy'])
    expect(rankRows(rows, 'checkins', 'a').map(r => r.place)).toEqual([1, 1, 1])
  })

  it('marks the viewer, and only the viewer', () => {
    const out = rankRows([R('a', 'Ana', 2), R('b', 'Bo', 5)], 'checkins', 'a')
    expect(out.filter(r => r.isMe).map(r => r.uid)).toEqual(['a'])
  })

  it('handles an empty board and a board of one', () => {
    expect(rankRows([], 'checkins', 'a')).toEqual([])
    expect(rankRows(undefined, 'checkins', 'a')).toEqual([])
    expect(rankRows([R('a', 'Ana', 0)], 'checkins', 'a').map(r => r.place)).toEqual([1])
  })

  it('treats a missing number as zero rather than dropping the person off the board', () => {
    const out = rankRows([{ uid: 'a', name: 'Ana' }, R('b', 'Bo', 1)], 'checkins', 'a')
    expect(out.map(r => r.name)).toEqual(['Bo', 'Ana'])
    expect(out[1].value).toBe(0)
  })

  it('ranks volume off the same rows without re-sorting the caller’s array', () => {
    const rows = [R('a', 'Ana', 5, 100), R('b', 'Bo', 1, 900)]
    expect(rankRows(rows, 'volKg', 'a')[0].name).toBe('Bo')
    expect(rankRows(rows, 'checkins', 'a')[0].name).toBe('Ana')
    expect(rows.map(r => r.uid)).toEqual(['a', 'b'])   // input untouched
  })
})

describe('volInUnit', () => {
  it('is the inverse of the server’s conversion', () => {
    expect(volInUnit(100, 'kg')).toBe(100)
    expect(volInUnit(453.6, 'lb')).toBe(1000)
    expect(volInUnit(0, 'lb')).toBe(0)
    expect(volInUnit(undefined, 'kg')).toBe(0)
  })
})

describe('findMe', () => {
  it('locates the viewer so the screen can keep their row visible', () => {
    const ranked = rankRows([R('a', 'Ana', 1), R('b', 'Bo', 5), R('c', 'Cy', 3)], 'checkins', 'a')
    expect(findMe(ranked).index).toBe(2)
    expect(findMe(ranked).row.name).toBe('Ana')
  })

  it('is null when the viewer is not on the board', () => {
    expect(findMe(rankRows([R('b', 'Bo', 5)], 'checkins', 'zz'))).toBe(null)
    expect(findMe([])).toBe(null)
  })
})
