import test from 'node:test';
import assert from 'node:assert/strict';
import { validateState, normalizeState } from '../state-schema.js';

const good = () => ({
  unit: 'kg',
  workouts: [{ id: 'w1', d: '2026-01-01', entries: [] }],
  routines: [{ id: 'r1', name: 'Push', ex: [] }],
  bodyweight: [{ d: '2026-01-01', w: 80 }],
  customEx: [],
});

test('accepts a real state file', () => {
  assert.deepEqual(validateState(good()), { ok: true, errors: [] });
});

test('refuses anything that is not a state object', () => {
  for (const bad of [null, undefined, [], 'x', 7]) {
    assert.equal(validateState(bad).ok, false);
  }
});

test('refuses a list that is not a list', () => {
  const v = validateState({ ...good(), workouts: 'nope' });
  assert.equal(v.ok, false);
  assert.match(v.errors[0], /workouts is not a list/);
});

test('refuses a workout with no usable date', () => {
  // '2026-8-1' is the shape a hand-edited file tends to have, and every date comparison in the
  // app is a string compare — it would sort and dedupe wrongly rather than fail.
  for (const d of ['2026-8-1', '01/01/2026', '', undefined]) {
    const v = validateState({ ...good(), workouts: [{ id: 'w1', d }] });
    assert.equal(v.ok, false, JSON.stringify(d));
  }
});

test('refuses a weigh-in with no weight', () => {
  assert.equal(validateState({ ...good(), bodyweight: [{ d: '2026-01-01' }] }).ok, false);
  assert.equal(validateState({ ...good(), bodyweight: [{ d: '2026-01-01', w: 'heavy' }] }).ok, false);
});

test('stops listing errors before it becomes a wall of text', () => {
  const workouts = Array.from({ length: 50 }, (_, i) => ({ id: 'w' + i }));
  assert.equal(validateState({ ...good(), workouts }).errors.length, 10);
});

test('normalize drops the in-progress session', () => {
  const out = normalizeState({ ...good(), active: { id: 'live' } });
  assert.equal('active' in out, false);
});

test('normalize sorts history ascending', () => {
  // The screen hands its page out newest-first; writing that back unsorted would put the history
  // in reverse, and array order is how progression.js decides which session is the latest.
  const out = normalizeState({
    ...good(),
    workouts: [{ id: 'b', d: '2026-03-01' }, { id: 'a', d: '2026-01-01' }, { id: 'c', d: '2026-02-01' }],
  });
  assert.deepEqual(out.workouts.map(w => w.d), ['2026-01-01', '2026-02-01', '2026-03-01']);
});

test('normalize sorts weigh-ins too, and drops duplicate workout ids', () => {
  const out = normalizeState({
    ...good(),
    workouts: [{ id: 'a', d: '2026-01-01' }, { id: 'a', d: '2026-02-01' }],
    bodyweight: [{ d: '2026-05-01', w: 79 }, { d: '2026-01-01', w: 80 }],
  });
  assert.equal(out.workouts.length, 1);
  assert.deepEqual(out.bodyweight.map(b => b.d), ['2026-01-01', '2026-05-01']);
});

test('normalize keeps a field this build has never heard of', () => {
  // A client one version ahead may carry something new. Dropping it would corrupt a good backup.
  const out = normalizeState({ ...good(), somethingNewer: { keep: 'me' } });
  assert.deepEqual(out.somethingNewer, { keep: 'me' });
});

test('normalize stamps the sync time', () => {
  assert.equal(normalizeState(good(), { ts: 1234 })._ts, 1234);
});

test('normalize drops the revision — the server owns it', () => {
  assert.equal('_rev' in normalizeState({ ...good(), _rev: 7 }), false);
});
