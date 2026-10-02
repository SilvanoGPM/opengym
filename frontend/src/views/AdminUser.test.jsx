// @vitest-environment happy-dom
// The admin user screen renders whatever the server sends about somebody else, including states
// the operator's own account never reaches — a user who has never synced, a history with no
// recorded volume, an admin who cannot be demoted from here. Those are the cases worth pinning.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AdminUser from './AdminUser.jsx'
import { DEF, useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'

const routes = vi.hoisted(() => ({ handlers: {} }))
vi.mock('../lib/api.js', () => ({
  api: vi.fn(path => {
    const key = Object.keys(routes.handlers).find(k => path.startsWith(k))
    if (!key) return Promise.reject(new Error('unmocked ' + path))
    return Promise.resolve(routes.handlers[key](path))
  }),
}))
vi.mock('../lib/sound.js', () => ({ beep: vi.fn(), vibrate: vi.fn() }))

globalThis.IS_REACT_ACT_ENVIRONMENT = true
const clone = v => JSON.parse(JSON.stringify(v))

let root, container

const detail = (over = {}) => ({
  user: { id: 'u2', name: 'Ana', created: '2026-01-02T00:00:00.000Z', disabled: false, admin: false, envAdmin: false, invitedBy: null },
  unit: 'kg', lastSync: Date.now(), live: false,
  routines: [{ id: 'r1', name: 'Push Day', count: 5 }],
  bodyweight: [{ d: '2026-01-01', w: 80 }, { d: '2026-01-08', w: 79.5 }],
  counts: { workouts: 2, bodyweight: 2, routines: 1, customEx: 0 },
  first: '2026-01-01', last: '2026-01-08',
  monthly: [{ m: '2026-01', workouts: 2, vol: 900, ms: 5400000 }],
  volUnknown: 0,
  workouts: history(),
  ...over,
})
const entry = (id = '0025') => ({
  id, target: { sets: 2, reps: 5, weight: 60 },
  sets: [{ w: 60, r: 5, done: true }, { w: 60, r: 5, done: true }], topW: 60,
})
// GET /api/admin/user hands the history over newest first, without photos and videos.
const history = () => [
  { id: 'w2', d: '2026-01-08', name: 'Pull Day', start: 0, end: 45 * 60000, entries: [entry()], prs: [], vol: 500 },
  { id: 'w1', d: '2026-01-01', name: 'Push Day', start: 0, end: 0, entries: [entry()], prs: ['0025'], vol: 400, note: 'felt strong' },
]

async function render(d = detail()) {
  routes.handlers = {
    '/api/admin/user?': () => d,
    '/api/admin/user/snapshots': () => ({ snapshots: [], keep: 10 }),
  }
  useStore.setState({ S: clone(DEF), user: { id: 'u1', name: 'Root', admin: true } })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  // await: the screen fetches on mount, so a synchronous act() only ever sees "Loading…".
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={['/admin/u/u2']}>
        <Routes><Route path="/admin/u/:id" element={<AdminUser />} /></Routes>
      </MemoryRouter>,
    )
  })
}

afterEach(() => { act(() => root.unmount()); container.remove() })

describe('admin user screen', () => {
  it('shows the person and their counts', async () => {
    await render()
    expect(container.textContent).toContain('Ana')
    expect(container.textContent).toContain('Push Day')
    expect(container.textContent).toContain('Pull Day')     // the history rendered
    expect(container.querySelectorAll('.tile').length).toBeGreaterThanOrEqual(4)
  })

  it('says when part of the history has no recorded volume', async () => {
    // Imported sessions carry no `vol`. Treating that as zero would draw a slump that never
    // happened, so the screen has to admit the gap instead.
    await render(detail({ volUnknown: 7 }))
    expect(container.textContent).toContain('7 without a recorded volume')
  })

  it('stays quiet about it when every workout has one', async () => {
    await render()
    expect(container.textContent).not.toContain('without a recorded volume')
  })

  it('offers no disable or delete for an admin, and says why', async () => {
    await render(detail({ user: { ...detail().user, admin: true } }))
    const buttons = [...container.querySelectorAll('button')].map(b => b.textContent)
    expect(buttons.some(t => t.includes('Disable account'))).toBe(false)
    expect(buttons.some(t => t.includes('Delete account'))).toBe(false)
    expect(buttons.some(t => t.includes('Remove admin'))).toBe(true)
    expect(container.textContent).toContain('remove admin first')
  })

  it('offers the write actions for an ordinary user', async () => {
    await render()
    const buttons = [...container.querySelectorAll('button')].map(b => b.textContent)
    for (const label of ['Download backup', 'Restore from file', 'Import from another app', 'Snapshots', 'Delete account', 'Make admin']) {
      expect(buttons.some(t => t.includes(label)), label).toBe(true)
    }
  })

  it('disables every write while the user is training', async () => {
    // The server refuses independently; this is so the refusal is not a surprise.
    await render(detail({ live: true }))
    const byLabel = l => [...container.querySelectorAll('button')].find(b => b.textContent.includes(l))
    expect(byLabel('Restore from file').disabled).toBe(true)
    expect(byLabel('Import from another app').disabled).toBe(true)
    expect(byLabel('Delete account').disabled).toBe(true)
    // Reading is still fine.
    expect(byLabel('Download backup').disabled).toBe(false)
    expect(container.textContent).toContain('changes wait until they finish')
  })

  it('marks an admin that comes from the environment', async () => {
    // The flag cannot remove them — isAdmin ORs the two sources — so the screen must not imply
    // that demoting here would work.
    await render(detail({ user: { ...detail().user, admin: true, envAdmin: true } }))
    expect(container.textContent).toContain('ADMIN_UIDS')
  })

  it('renders a user who has never synced without throwing', async () => {
    await render(detail({
      lastSync: null, bodyweight: [], routines: [], monthly: [],
      counts: { workouts: 0, bodyweight: 0, routines: 0, customEx: 0 }, first: null, last: null,
      workouts: [],
    }))
    expect(container.textContent).toContain('no workouts yet')
    expect(container.textContent).toContain('No workouts logged.')
  })

  it('shows fifty sessions at a time, and a Show more button only when there are more', async () => {
    const more = () => [...container.querySelectorAll('button')].find(b => b.textContent.includes('Show more'))
    await render()
    expect(more()).toBeUndefined()
    act(() => root.unmount()); container.remove()
    const many = Array.from({ length: 51 }, (_, i) => ({ ...history()[0], id: 'w' + i }))
    await render(detail({ workouts: many }))
    expect(container.querySelectorAll('.wrow').length).toBe(50)
    act(() => more().click())
    expect(container.querySelectorAll('.wrow').length).toBe(51)
    expect(more()).toBeUndefined()
  })

  it('opens a profile with malformed workout entries and still offers "Disable account"', async () => {
    // QA C16: what GET /api/admin/user hands over for a document written before PUT /api/data
    // dropped such entries — a null, and a bare object without entries, next to a real session.
    const good = { id: 'w1', name: 'Push day', d: '2026-09-10', start: 1000, end: 61000, entries: [{ sets: [{ done: true }, { done: false }] }] }
    await render(detail({ workouts: [null, good, {}] }))
    const buttons = [...container.querySelectorAll('button')].map(b => b.textContent)
    expect(buttons).toContain('Disable account')
    // The one real session is listed; the two shapeless entries are skipped, not drawn as blanks.
    const rows = [...container.querySelectorAll('.wrow')]
    expect(rows.length).toBe(1)
    expect(rows[0].textContent).toContain('Push day')
    expect(rows[0].textContent).toContain('1 sets')
  })

  it('flags someone who is training right now', async () => {
    await render(detail({ live: true }))
    expect(container.textContent).toContain('training now')
  })

  // <Modals /> lives in App.jsx and is not mounted here, so the sheet's own render prop is
  // rendered directly — that is the content under test either way.
  const openedSheet = async label => {
    // .wrow, not any .item: the users list and the routines card carry the same names.
    const row = [...container.querySelectorAll('.wrow')].find(r => r.textContent.includes(label))
    await act(async () => { row.dispatchEvent(new window.Event('click', { bubbles: true })) })
    const sheet = useUI.getState().sheets.at(-1)
    const host = document.createElement('div')
    document.body.appendChild(host)
    const r2 = createRoot(host)
    await act(async () => { r2.render(sheet.render(() => {})) })
    const text = host.textContent
    act(() => r2.unmount()); host.remove()
    return text
  }

  it('opens a workout to show what was actually lifted', async () => {
    // The list route already returns whole records, so the sheet needs no request of its own.
    useUI.setState({ sheets: [] })
    await render()
    const text = await openedSheet('Pull Day')
    expect(text).toContain('60×5')          // setLabel, the same rendering the user sees
    expect(text).toContain('Delete this workout')
  })

  it('shows the session note and the PR badge', async () => {
    useUI.setState({ sheets: [] })
    await render()
    const text = await openedSheet('Push Day')
    expect(text).toContain('felt strong')
    expect(text).toContain('PR')
  })

  it('does not offer to delete a workout while the user is training', async () => {
    useUI.setState({ sheets: [] })
    await render(detail({ live: true }))
    const text = await openedSheet('Pull Day')
    expect(text).toContain('60×5')                       // reading is still fine
    expect(text).not.toContain('Delete this workout')    // writing is not
  })
})
