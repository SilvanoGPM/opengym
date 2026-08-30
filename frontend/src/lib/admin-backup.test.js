import { describe, it, expect } from 'vitest'
import { wrapBackup, backupFilename, parseBackupFile, restorePreview, BACKUP_VERSION } from './admin-backup.js'

const state = (over = {}) => ({
  unit: 'kg', workouts: [{ id: 'w1', d: '2026-01-01' }], routines: [{ id: 'r1', name: 'Push', ex: [] }],
  bodyweight: [{ d: '2026-01-01', w: 80 }], _ts: 5, ...over,
})

describe('wrapBackup', () => {
  it('carries training data and nothing that could impersonate the user', () => {
    // The property this file exists to keep: an operator can hand a backup back to someone
    // without handing over a way into their account.
    const out = wrapBackup(state(), { id: 'u1', name: 'Ana' }, { app: '1.2.11' })
    expect(out.opengym_backup).toBe(BACKUP_VERSION)
    expect(out.user).toEqual({ id: 'u1', name: 'Ana' })
    const json = JSON.stringify(out)
    for (const forbidden of ['creds', 'publicKey', 'subs', 'endpoint', '"sv"', 'secret']) {
      expect(json).not.toContain(forbidden)
    }
  })

  it('survives a user with no name', () => {
    expect(wrapBackup(state(), null).user).toEqual({ id: null, name: null })
  })
})

describe('backupFilename', () => {
  it('slugs the name and keeps the id', () => {
    expect(backupFilename({ id: 'u1', name: 'Ana Silva' }, '2026-08-29')).toBe('opengym-ana-silva-u1-2026-08-29.json')
  })

  it('cannot produce a path from a hostile name', () => {
    const name = backupFilename({ id: 'u1', name: '../../etc/passwd' }, '2026-08-29')
    expect(name).not.toContain('/')
    expect(name).not.toContain('..')
  })

  it('falls back rather than producing a nameless file', () => {
    expect(backupFilename({ id: 'u1', name: '???' }, '2026-08-29')).toBe('opengym-user-u1-2026-08-29.json')
  })
})

describe('parseBackupFile', () => {
  it('reads the admin envelope', () => {
    const text = JSON.stringify(wrapBackup(state(), { id: 'u1', name: 'Ana' }))
    const out = parseBackupFile(text)
    expect(out.ok).toBe(true)
    expect(out.state.workouts).toHaveLength(1)
    expect(out.envelope.user.name).toBe('Ana')
  })

  it('reads the bare backup Settings has always exported', () => {
    // Every file a user ever exported from their own device must restore here.
    const out = parseBackupFile(JSON.stringify(state()))
    expect(out.ok).toBe(true)
    expect(out.envelope).toBe(null)
    expect(out.state.routines).toHaveLength(1)
  })

  it('names the mistake when handed a shared plan', () => {
    const out = parseBackupFile(JSON.stringify({ opengym_plan: 1, routines: [], week: {} }))
    expect(out.ok).toBe(false)
    expect(out.error).toContain('plan file')
  })

  it('refuses anything that is not a backup', () => {
    expect(parseBackupFile('not json').ok).toBe(false)
    expect(parseBackupFile('[]').ok).toBe(false)
    expect(parseBackupFile('{}').ok).toBe(false)
    expect(parseBackupFile(JSON.stringify({ workouts: [] })).ok).toBe(false)      // no routines
    expect(parseBackupFile(JSON.stringify({ opengym_backup: 1 })).ok).toBe(false)  // no state
  })
})

describe('restorePreview', () => {
  const current = state({ workouts: [{ id: 'a', d: '2026-01-01' }, { id: 'b', d: '2026-01-08' }] })

  it('counts what a merge would actually add', () => {
    const incoming = state({ workouts: [{ id: 'x', d: '2026-01-01' }, { id: 'y', d: '2026-02-01' }] })
    const p = restorePreview(current, incoming)
    expect(p.workouts).toEqual({ incoming: 2, overlap: 1, added: 1 })
  })

  it('names the cost of replacing, which is the whole point of showing this', () => {
    const p = restorePreview(current, state({ workouts: [] }))
    expect(p.replaceLoses.workouts).toBe(2)
    expect(p.workouts.added).toBe(0)
  })

  it('counts weigh-ins on the same rule', () => {
    const incoming = state({ bodyweight: [{ d: '2026-01-01', w: 81 }, { d: '2026-05-05', w: 79 }] })
    expect(restorePreview(current, incoming).bodyweight).toEqual({ incoming: 2, overlap: 1, added: 1 })
  })

  it('handles an empty side without throwing', () => {
    expect(restorePreview(null, null).workouts).toEqual({ incoming: 0, overlap: 0, added: 0 })
    expect(restorePreview({}, {}).replaceLoses.workouts).toBe(0)
  })
})
