import test from 'node:test';
import assert from 'node:assert/strict';
import { canAdminWrite } from './admin-write.js';

const target = { id: 'u2', name: 'Ana' };
const state = { workouts: [{ id: 'w1', d: '2026-01-01' }], routines: [] };

test('a merge with a good file goes through', () => {
  assert.deepEqual(canAdminWrite({ target, mode: 'merge', state, live: false }), { ok: true });
});

test('an unknown user is a 404 before anything else is considered', () => {
  const r = canAdminWrite({ target: null, mode: 'merge', state, live: true });
  assert.equal(r.status, 404);
});

test('replace will not run without an explicit confirmation', () => {
  const r = canAdminWrite({ target, mode: 'replace', state, live: false });
  assert.equal(r.status, 400);
  assert.equal(r.code, 'confirm-required');
  assert.deepEqual(canAdminWrite({ target, mode: 'replace', state, confirm: true, live: false }), { ok: true });
});

test('merge does not need one', () => {
  assert.equal(canAdminWrite({ target, mode: 'merge', state, live: false }).ok, true);
});

test('a broken file is rejected before the live check', () => {
  // Order matters: someone who picked the wrong file should be told that, not told to come back
  // later — and a file that was never going to be written must not cost a snapshot.
  const r = canAdminWrite({ target, mode: 'merge', state: { workouts: 'nope' }, live: true });
  assert.equal(r.status, 400);
  assert.equal(r.code, 'invalid-state');
});

test('writing under someone who is training is refused', () => {
  const r = canAdminWrite({ target, mode: 'merge', state, live: true });
  assert.equal(r.status, 409);
  assert.equal(r.code, 'live');
  assert.match(r.error, /Ana/);
  assert.match(r.error, /training right now/);
});

test('an unknown mode is refused', () => {
  assert.equal(canAdminWrite({ target, mode: 'overwrite', state, live: false }).code, 'bad-mode');
});

test('operations with no state still get the live guard', () => {
  // Deleting a workout carries no file, but must not land under an active session either.
  assert.deepEqual(canAdminWrite({ target, live: false }), { ok: true });
  assert.equal(canAdminWrite({ target, live: true }).code, 'live');
});

test('an operation can demand confirmation on its own', () => {
  assert.equal(canAdminWrite({ target, live: false, requireConfirm: true }).code, 'confirm-required');
  assert.equal(canAdminWrite({ target, live: false, requireConfirm: true, confirm: true }).ok, true);
});
