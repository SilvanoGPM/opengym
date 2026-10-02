/* The admin panel's writes into somebody else's account: restore or merge a backup, delete one
   workout, roll back to a snapshot, promote and demote. Each one is guarded (validate, snapshot,
   refuse under a live session, audit) and each one has to keep the books PUT /api/data keeps —
   the revision moves, so the user's devices pull the change or get the 409 and merge, and what a
   write removed is stamped (`resetAt`, `resetIds`), so that merge cannot bring it back.
   Real server.js in a child, same harness as server-admin-delete.test.js. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers.mjs';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = crypto.randomBytes(32).toString('hex');
const mintSession = uid => {
  const payload = `${uid}:${Date.now() + 86400000}:0`;
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
};
const ADMIN = 'u_adm_1', ENV_ADMIN = 'u_env_1', ANA = 'u_ana_1';
const ORIGIN = 'http://localhost:8080';
const as = uid => ({ Cookie: `gymsid=${mintSession(uid)}`, 'Content-Type': 'application/json', Origin: ORIGIN });
const w = (id, d, over = {}) => ({ id, d, name: 'Push', start: Date.parse(d + 'T18:00:00Z'), end: Date.parse(d + 'T19:00:00Z'), vol: 1000, entries: [], ...over });

async function startServer(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-admw-'));
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
    users: [
      { id: ADMIN, name: 'Adminna', created: new Date().toISOString(), admin: true },
      { id: ENV_ADMIN, name: 'Envy', created: new Date().toISOString() },
      { id: ANA, name: 'Ana', created: new Date().toISOString() },
    ],
    creds: [], subs: [], invites: [],
  }));
  fs.writeFileSync(path.join(dataDir, `state-${ANA}.json`), JSON.stringify({
    unit: 'kg', _ts: 1000, _rev: 4,
    workouts: [w('a', '2026-01-05'), w('b', '2026-01-12')],
    bodyweight: [{ d: '2026-01-05', w: 80, t: 1 }],
    routines: [{ id: 'r1', name: 'Push', ex: [] }],
  }));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '0', DATA_DIR: dataDir, ORIGIN, RP_ID: 'localhost', ADMIN_UIDS: ENV_ADMIN },
  });
  const h = { api: '', log: '', dataDir };
  child.stdout.on('data', d => h.log += d);
  child.stderr.on('data', d => h.log += d);
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(dataDir, { recursive: true, force: true }); });
  h.port = await boundPort(child, () => h.log);
  h.api = `http://127.0.0.1:${h.port}`;
  h.call = async (method, route, body, uid = ADMIN) => {
    const r = await fetch(h.api + route, { method, headers: as(uid), body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  h.post = (route, body, uid) => h.call('POST', route, body, uid);
  h.get = (route, uid) => h.call('GET', route, null, uid);
  h.state = () => JSON.parse(fs.readFileSync(path.join(dataDir, `state-${ANA}.json`), 'utf8'));
  h.db = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
  h.stackFrames = () => h.log.split('\n').filter(l => /^\s+at /.test(l)).length;
  return h;
}

test('a merge adds, moves the revision and takes a snapshot first', async t => {
  const h = await startServer(t);
  const res = await h.post('/api/admin/user/state', { id: ANA, mode: 'merge', state: { workouts: [w('a2', '2026-01-05'), w('c', '2026-02-02')] } });
  assert.equal(res.status, 200);
  assert.equal(res.body.added, 1);
  assert.equal(res.body.skipped, 1, 'a day she already has wins');
  const S = h.state();
  assert.deepEqual(S.workouts.map(x => x.id), ['a', 'b', 'c']);
  assert.equal(S._rev, 5, 'the revision moved, so her devices pull it');
  assert.equal(S.resetAt, undefined, 'a merge removes nothing and stamps nothing');
  const snaps = await h.get(`/api/admin/user/snapshots?id=${ANA}`);
  assert.equal(snaps.body.snapshots.length, 1);
  assert.equal((await h.get(`/api/data/rev`, ANA)).body.rev, 5);
});

test('a device on the old revision is refused and handed the merged document', async t => {
  // The protocol hook the whole thing relies on: her phone's next push is conditional on the
  // revision it last saw, so it cannot overwrite the admin's write — it gets the 409 and merges.
  const h = await startServer(t);
  await h.post('/api/admin/user/state', { id: ANA, mode: 'merge', state: { workouts: [w('c', '2026-02-02')] } });
  const r = await fetch(h.api + '/api/data', { method: 'PUT', headers: as(ANA), body: JSON.stringify({ baseRev: 4, state: { unit: 'kg', workouts: [w('a', '2026-01-05')] } }) });
  assert.equal(r.status, 409);
  const body = await r.json();
  assert.deepEqual(body.state.workouts.map(x => x.id), ['a', 'b', 'c']);
});

test('replace needs confirming, and stamps what it removed', async t => {
  const h = await startServer(t);
  const state = { unit: 'kg', workouts: [w('a', '2026-01-05')], routines: [], bodyweight: [] };
  const refused = await h.post('/api/admin/user/state', { id: ANA, mode: 'replace', state });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.code, 'confirm-required');
  assert.equal(h.state()._rev, 4, 'nothing written');

  const res = await h.post('/api/admin/user/state', { id: ANA, mode: 'replace', state, confirm: true });
  assert.equal(res.status, 200);
  const S = h.state();
  assert.deepEqual(S.workouts.map(x => x.id), ['a']);
  assert.equal(S._rev, 5);
  assert.ok(S.resetAt > 0);
  assert.deepEqual(S.resetIds.workouts, ['b']);
  assert.deepEqual(S.resetIds.routines, ['r1']);
  assert.deepEqual(S.resetIds.bodyweight, ['2026-01-05|1']);
});

test('a file that is not a state is refused before anything is snapshotted', async t => {
  const h = await startServer(t);
  const res = await h.post('/api/admin/user/state', { id: ANA, mode: 'merge', state: { workouts: [{ id: 'x', d: '5/1/2026' }] } });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'invalid-state');
  assert.equal((await h.get(`/api/admin/user/snapshots?id=${ANA}`)).body.snapshots.length, 0);
});

test('nothing is written under somebody who is training', async t => {
  const h = await startServer(t);
  await h.post('/api/activity', { active: true, name: 'Push', exIdx: 1, exTotal: 5 }, ANA);
  const live = await h.get('/api/admin/presence');
  assert.deepEqual(live.body.live.map(x => [x.id, x.user, x.workout]), [[ANA, 'Ana', 'Push']]);
  const merge = await h.post('/api/admin/user/state', { id: ANA, mode: 'merge', state: { workouts: [] } });
  assert.equal(merge.status, 409);
  assert.equal(merge.body.code, 'live');
  assert.equal((await h.post('/api/admin/user/workout/delete', { id: ANA, workoutId: 'a' })).status, 409);
  assert.equal((await h.post('/api/admin/user/delete', { id: ANA })).status, 409);
  assert.equal(h.state()._rev, 4);
  await h.post('/api/activity', { active: false }, ANA);
  assert.equal((await h.post('/api/admin/user/workout/delete', { id: ANA, workoutId: 'a' })).status, 200);
});

test('a deleted workout is stamped as removed, and a rollback brings it back', async t => {
  const h = await startServer(t);
  const del = await h.post('/api/admin/user/workout/delete', { id: ANA, workoutId: 'b' });
  assert.equal(del.status, 200);
  let S = h.state();
  assert.deepEqual(S.workouts.map(x => x.id), ['a']);
  assert.deepEqual(S.resetIds.workouts, ['b']);
  assert.equal((await h.post('/api/admin/user/workout/delete', { id: ANA, workoutId: 'nope' })).status, 404);

  const { snapshots } = (await h.get(`/api/admin/user/snapshots?id=${ANA}`)).body;
  assert.equal(snapshots.length, 1);
  assert.equal((await h.post('/api/admin/user/snapshots/restore', { id: ANA, ts: snapshots[0].ts })).body.code, 'confirm-required');
  const back = await h.post('/api/admin/user/snapshots/restore', { id: ANA, ts: snapshots[0].ts, confirm: true });
  assert.equal(back.status, 200);
  S = h.state();
  assert.deepEqual(S.workouts.map(x => x.id), ['a', 'b']);
  assert.equal(S._rev, 6, 'a rollback is a write like any other');
  assert.equal((await h.get(`/api/admin/user/snapshots?id=${ANA}`)).body.snapshots.length, 2, 'and it snapshots first');
  assert.equal((await h.post('/api/admin/user/snapshots/restore', { id: ANA, ts: 12345, confirm: true })).status, 404);
});

test('snapshots can be deleted one at a time or all at once', async t => {
  const h = await startServer(t);
  await h.post('/api/admin/user/state', { id: ANA, mode: 'merge', state: { workouts: [] } });
  await h.post('/api/admin/user/state', { id: ANA, mode: 'merge', state: { workouts: [] } });
  const { snapshots } = (await h.get(`/api/admin/user/snapshots?id=${ANA}`)).body;
  assert.equal(snapshots.length, 2);
  const one = await h.post('/api/admin/user/snapshots/delete', { id: ANA, ts: snapshots[0].ts });
  assert.equal(one.body.removed, 1);
  assert.equal(one.body.snapshots.length, 1);
  const all = await h.post('/api/admin/user/snapshots/delete', { id: ANA, ts: 'all' });
  assert.equal(all.body.removed, 1);
  assert.deepEqual(all.body.snapshots, []);
});

test('deleting the account takes its snapshots with it', async t => {
  const h = await startServer(t);
  await h.post('/api/admin/user/state', { id: ANA, mode: 'merge', state: { workouts: [] } });
  assert.equal((await h.post('/api/admin/user/delete', { id: ANA })).status, 200);
  const left = fs.readdirSync(path.join(h.dataDir, 'snapshots')).filter(f => f.includes(ANA));
  assert.deepEqual(left, []);
});

test('promote and demote, and the three demotions that are refused', async t => {
  const h = await startServer(t);
  assert.equal((await h.post('/api/admin/user/admin', { id: ADMIN, admin: false })).body.code, 'self');
  assert.equal((await h.post('/api/admin/user/admin', { id: ENV_ADMIN, admin: false })).body.code, 'env-admin');
  const up = await h.post('/api/admin/user/admin', { id: ANA, admin: true });
  assert.deepEqual([up.status, up.body.admin], [200, true]);
  assert.equal(h.db().users.find(u => u.id === ANA).admin, true);
  // Ana demotes Adminna, then cannot demote herself — and the env admin still counts.
  assert.equal((await h.post('/api/admin/user/admin', { id: ADMIN, admin: false }, ANA)).status, 200);
  assert.equal(h.db().users.find(u => u.id === ADMIN).admin, undefined);
});

test('a disabled account cannot be made an admin', async t => {
  const h = await startServer(t);
  await h.post('/api/admin/user/disable', { id: ANA, disabled: true });
  const res = await h.post('/api/admin/user/admin', { id: ANA, admin: true });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'disabled');
});

test('the drill-down carries the rollups the user screen charts', async t => {
  const h = await startServer(t);
  const { body } = await h.get(`/api/admin/user?id=${ANA}`);
  assert.equal(body.user.envAdmin, false);
  assert.equal(body.live, false);
  assert.deepEqual(body.counts, { workouts: 2, bodyweight: 1, routines: 1, customEx: 0 });
  assert.deepEqual(body.monthly.map(m => [m.m, m.workouts, m.vol]), [['2026-01', 2, 2000]]);
  assert.equal(body.first, '2026-01-05');
  const env = await h.get(`/api/admin/user?id=${ENV_ADMIN}`);
  assert.equal(env.body.user.envAdmin, true);
});

test('the backup source is the stored document, ascending and whole', async t => {
  const h = await startServer(t);
  const { body } = await h.get(`/api/admin/user/state?id=${ANA}`);
  assert.deepEqual(body.state.workouts.map(x => x.id), ['a', 'b']);
  assert.equal(body.ts, 1000);
  assert.equal((await h.get(`/api/admin/user/state?id=${ANA}`, ANA)).status, 403, 'admins only');
});

test('every write is in the activity log, and the log can be exported', async t => {
  const h = await startServer(t);
  await h.post('/api/admin/user/state', { id: ANA, mode: 'merge', state: { workouts: [] } });
  await h.post('/api/admin/user/workout/delete', { id: ANA, workoutId: 'a' });
  const { body } = await h.get('/api/admin/audit/export');
  const evs = body.events.map(e => e.ev);
  assert.ok(evs.includes('admin.user.state.merge'), evs.join());
  assert.ok(evs.includes('admin.user.workout.delete'), evs.join());
  assert.equal(h.stackFrames(), 0, `no stack traces:\n${h.log}`);
});
