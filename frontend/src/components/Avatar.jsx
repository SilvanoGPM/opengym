// A face for a profile, without storing one.
//
// The leaderboard is the first screen that puts people side by side, and until now nothing in the
// app had an avatar — only a name typed once at passkey registration. Initials on a coloured disc
// get the same job done as the photo in a commercial app: telling rows apart at a glance. No
// upload route, no image validation, no bytes in ./data.
//
// The colour is derived from the uid, so it is stable across devices and sessions without being
// stored anywhere, and it comes from the app's own accent palette so it always suits the theme.

import { ACCENTS } from '../lib/format.js'

const PALETTE = Object.values(ACCENTS)

// FNV-1a. Not for security — just a spread that doesn't put two neighbouring uids on one colour.
function hash(s) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  return h >>> 0
}

export const colorFor = uid => PALETTE[hash(String(uid || '')) % PALETTE.length]

/**
 * Up to two initials from a display name.
 *
 * Splits on whitespace, so "Ana Paula" reads "AP" and a single name gives one letter. Uses the
 * code point rather than [0] so an emoji or an astral character isn't cut in half, and falls back
 * to a dot when a name is empty or is only punctuation — never an empty disc.
 */
export function initialsOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '·'
  const first = [...parts[0]][0] || ''
  const last = parts.length > 1 ? ([...parts[parts.length - 1]][0] || '') : ''
  return (first + last).toLocaleUpperCase()
}

export default function Avatar({ uid, name, size = 34, className = '' }) {
  const bg = colorFor(uid)
  return (
    <span
      className={'avatar ' + className}
      style={{ '--av-bg': bg, width: size, height: size, fontSize: Math.round(size * 0.4) }}
      aria-hidden="true"
    >
      {initialsOf(name)}
    </span>
  )
}
