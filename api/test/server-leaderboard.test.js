/* The ranking: who is listed (only those who joined, never a disabled account), who may look
   (only those who joined), what crosses between profiles (a name and two numbers), and the switch
   that removes it all. Plus the display-name route, which keeps the password sign-in rule that no
   two profiles that sign in by name share one. Real server.js in a child, same harness as
   server-admin-delete.test.js. */
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
const ORIGIN = 'http://localhost:8080';
const as = uid => ({ Cookie: `gymsid=${mintSession(uid)}`, 'Content-Type': 'application/json', Origin: ORIGIN });
const ANA = 'u_ana', BEN = 'u_ben', CAI = 'u_cai', DEE = 'u_dee';
const w = (d, vol) => ({ id: 'w' + d + vol, d, start: 1, end: 2, vol, entries: [{ id: '0025', sets: [{ w: 999, r: 9 }] }] });

async function startServer(t, env = {}, { passwordFor = [] } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-lb-'));
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
    users: [
      { id: ANA, name: 'Ana', created: new Date().toISOString(), lb: true },
      { id: BEN, name: 'Ben', created: new Date().toISOString(), lb: true },
      { id: CAI, name: 'Cai', created: new Date().toISOString() },
      { id: DEE, name: 'Dee', created: new Date().toISOString(), lb: true, disabled: true, pw: { h: 'x', set: 'x' } },
    ],
    creds: [], subs: [], invites: [],
  }));
  if (passwordFor.length) {
    const db = JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
    for (const u of db.users) if (passwordFor.includes(u.id)) u.pw = { h: 'not-a-real-hash', set: 'x' };
    fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify(db));
  }
  const state = (uid, S) => fs.writeFileSync(path.join(dataDir, `state-${uid}.json`), JSON.stringify(S));
  state(ANA, { unit: 'kg', workouts: [w('2026-08-24', 1000), w('2026-08-24', 500), w('2026-08-26', 2000), w('2026-07-01', 9000)] });
  state(BEN, { unit: 'lb', workouts: [w('2026-08-25', 1000), null, { d: '2026-08-27' }] });
  state(CAI, { unit: 'kg', workouts: [w('2026-08-25', 99999)] });
  const child = spawn(process.execPath, ['server.js'], {
    cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: '0', DATA_DIR: dataDir, ORIGIN, RP_ID: 'localhost', ...env },
  });
  const h = { api: '', log: '', dataDir };
  child.stdout.on('data', d => h.log += d);
  child.stderr.on('data', d => h.log += d);
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(dataDir, { recursive: true, force: true }); });
  h.port = await boundPort(child, () => h.log);
  h.api = `http://127.0.0.1:${h.port}`;
  h.call = async (method, route, body, uid) => {
    const r = await fetch(h.api + route, { method, headers: uid ? as(uid) : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  h.board = (uid, from = '2026-08-24', to = '2026-08-30') => h.call('GET', `/api/leaderboard?from=${from}&to=${to}`, null, uid);
  h.db = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
  return h;
}

test('those who joined see each other: days, sessions and volume in kg, and nothing else', async t => {
  const h = await startServer(t);
  const { status, body } = await h.board(ANA);
  assert.equal(status, 200);
  assert.equal(body.participants, 2, 'a disabled account is not a participant');
  const rows = Object.fromEntries(body.rows.map(r => [r.uid, r]));
  assert.deepEqual(Object.keys(rows).sort(), [ANA, BEN]);
  assert.deepEqual(rows[ANA], { uid: ANA, name: 'Ana', checkins: 2, sessions: 3, volKg: 3500, volUnknown: 0 });
  assert.equal(rows[BEN].volKg, 453.6, 'pounds weighed in kilos');
  assert.equal(rows[BEN].volUnknown, 1, 'a workout with no volume is counted apart, a null one skipped');
  assert.ok(!JSON.stringify(body).includes('999'), 'no set ever crosses');
});

test('somebody who has not joined is shown nobody', async t => {
  const h = await startServer(t);
  const { body } = await h.board(CAI);
  assert.deepEqual(body.rows, []);
  assert.equal(body.participants, 2);
});

test('joining and leaving are the person\'s own, and reach /api/me', async t => {
  const h = await startServer(t);
  assert.equal((await h.call('GET', '/api/me', null, CAI)).body.user.lb, undefined);
  assert.equal((await h.call('POST', '/api/leaderboard/opt', { on: 'yes' }, CAI)).status, 400);
  assert.deepEqual((await h.call('POST', '/api/leaderboard/opt', { on: true }, CAI)).body, { lb: true });
  assert.equal((await h.call('GET', '/api/me', null, CAI)).body.user.lb, true);
  assert.equal((await h.board(ANA)).body.participants, 3);
  assert.deepEqual((await h.call('POST', '/api/leaderboard/opt', { on: false }, CAI)).body, { lb: false });
  assert.equal(h.db().users.find(u => u.id === CAI).lb, undefined);
});

test('a range that is not two days in order is refused, and so is nobody', async t => {
  const h = await startServer(t);
  assert.equal((await h.board(ANA, '2026-8-24', '2026-08-30')).status, 400);
  assert.equal((await h.board(ANA, '2026-08-30', '2026-08-24')).status, 400);
  assert.equal((await h.board(null)).status, 401);
});

test('LEADERBOARD=0 removes it, and says so in /api/config', async t => {
  const h = await startServer(t, { LEADERBOARD: '0' });
  assert.equal((await h.board(ANA)).status, 404);
  assert.equal((await h.call('POST', '/api/leaderboard/opt', { on: true }, CAI)).status, 404);
  assert.equal((await h.call('GET', '/api/config')).body.leaderboard, false);
});

test('an instance that never touched it answers /api/config as before', async t => {
  const h = await startServer(t);
  assert.equal('leaderboard' in (await h.call('GET', '/api/config')).body, false);
});

test('a display name can be changed, trimmed and capped', async t => {
  const h = await startServer(t);
  assert.equal((await h.call('POST', '/api/me/name', { name: '   ' }, ANA)).status, 400);
  const r = await h.call('POST', '/api/me/name', { name: '  Ana Paula ' + 'x'.repeat(50) }, ANA);
  assert.equal(r.status, 200);
  assert.equal(r.body.name.length, 40);
  assert.ok(r.body.name.startsWith('Ana Paula'));
  assert.equal(h.db().users.find(u => u.id === ANA).name, r.body.name);
});

test('a profile that signs in by name cannot take a name another one signs in with', async t => {
  // Dee has a password, so "dee" is a sign-in name. Ben gets one here; Ana has none, so her name
  // is only a label and may match anything.
  const h = await startServer(t, {}, { passwordFor: [BEN] });
  const taken = await h.call('POST', '/api/me/name', { name: ' DEE ' }, BEN);
  assert.equal(taken.status, 409);
  assert.equal(taken.body.code, 'name-taken');
  assert.equal(h.db().users.find(u => u.id === BEN).name, 'Ben');
  assert.equal((await h.call('POST', '/api/me/name', { name: 'Dee' }, ANA)).status, 200);
  assert.equal((await h.call('POST', '/api/me/name', { name: 'Benjamin' }, BEN)).status, 200);
});
