import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeState, replaceState, stampRemoval } from '../state-merge.js';

const w = (id, d, over = {}) => ({ id, d, entries: [], ...over });
const cur = () => ({
  unit: 'kg',
  workouts: [w('a', '2026-01-01'), w('b', '2026-01-08')],
  bodyweight: [{ d: '2026-01-01', w: 80 }],
  routines: [{ id: 'r1', name: 'Push', ex: [] }],
  customEx: [], exWeights: {},
});

test('merge adds a day the user does not have', () => {
  const out = mergeState(cur(), { workouts: [w('x', '2026-02-01')] });
  assert.equal(out.added, 1);
  assert.equal(out.state.workouts.length, 3);
});

test('a day that already exists wins — merge can never remove', () => {
  // The property that makes merge the safe default.
  const out = mergeState(cur(), { workouts: [w('other', '2026-01-01', { name: 'Replaced?' })] });
  assert.equal(out.added, 0);
  assert.equal(out.skipped, 1);
  assert.equal(out.state.workouts.length, 2);
  assert.equal(out.state.workouts.find(x => x.d === '2026-01-01').id, 'a');
});

test('merging the same file twice adds nothing the second time', () => {
  const incoming = { workouts: [w('x', '2026-02-01'), w('y', '2026-03-01')] };
  const once = mergeState(cur(), incoming);
  const twice = mergeState(once.state, incoming);
  assert.equal(once.added, 2);
  assert.equal(twice.added, 0);
  assert.equal(twice.state.workouts.length, once.state.workouts.length);
});

test('merge never lowers the workout count', () => {
  for (const incoming of [{}, { workouts: [] }, { workouts: [w('a', '2026-01-01')] }]) {
    const out = mergeState(cur(), incoming);
    assert.ok(out.state.workouts.length >= 2, JSON.stringify(incoming));
  }
});

test('the result is ascending by date whatever order it arrived in', () => {
  const out = mergeState(cur(), { workouts: [w('z', '2026-05-01'), w('y', '2026-02-01')] });
  const days = out.state.workouts.map(x => x.d);
  assert.deepEqual(days, [...days].sort());
});

test('weigh-ins follow the same day rule', () => {
  const out = mergeState(cur(), { bodyweight: [{ d: '2026-01-01', w: 99 }, { d: '2026-06-01', w: 78 }] });
  assert.equal(out.addedBodyweight, 1);
  assert.equal(out.state.bodyweight.find(b => b.d === '2026-01-01').w, 80);
});

test('custom exercises come only for lifts the new workouts actually use', () => {
  const out = mergeState(cur(), {
    workouts: [w('x', '2026-02-01', { entries: [{ id: 'mine', sets: [] }] })],
    customEx: [{ id: 'mine', n: 'My lift' }, { id: 'unused', n: 'Never done' }],
  });
  assert.deepEqual(out.state.customEx.map(c => c.id), ['mine']);
});

test('a custom exercise already present is not duplicated', () => {
  const start = { ...cur(), customEx: [{ id: 'mine', n: 'My lift' }] };
  const out = mergeState(start, {
    workouts: [w('x', '2026-02-01', { entries: [{ id: 'mine', sets: [] }] })],
    customEx: [{ id: 'mine', n: 'My lift (again)' }],
  });
  assert.equal(out.state.customEx.length, 1);
});

test('working weights are seeded, and an older session never lowers a newer one', () => {
  // mergeImport's exact rule: `if (!cur || w.d >= cur.d)`.
  const start = { ...cur(), exWeights: { '0025': { w: 100, d: '2026-06-01' } } };
  const out = mergeState(start, {
    workouts: [w('old', '2026-02-01', { entries: [{ id: '0025', sets: [{ w: 60 }], topW: 60 }] })],
  });
  assert.deepEqual(out.state.exWeights['0025'], { w: 100, d: '2026-06-01' });

  const newer = mergeState(start, {
    workouts: [w('new', '2026-09-01', { entries: [{ id: '0025', sets: [{ w: 110 }], topW: 110 }] })],
  });
  assert.deepEqual(newer.state.exWeights['0025'], { w: 110, d: '2026-09-01' });
});

test('merge leaves routines alone', () => {
  // A merge is about history. Rewriting somebody's plan is what replace is for.
  const out = mergeState(cur(), { routines: [{ id: 'other', name: 'Theirs', ex: [] }] });
  assert.deepEqual(out.state.routines.map(r => r.id), ['r1']);
});

test('an empty incoming state changes nothing', () => {
  const before = cur();
  const out = mergeState(before, {});
  assert.equal(out.added, 0);
  assert.deepEqual(out.state.workouts, before.workouts);
});

test('replace keeps nothing of the current state', () => {
  const out = replaceState({ workouts: [w('only', '2026-07-01')], routines: [] });
  assert.equal(out.state.workouts.length, 1);
  assert.equal(out.state.workouts[0].id, 'only');
  assert.equal(out.added, 1);
});

test('replace normalizes too — no active session, sorted, stamped', () => {
  const out = replaceState({
    active: { id: 'live' },
    workouts: [w('b', '2026-03-01'), w('a', '2026-01-01')],
  }, { ts: 99 });
  assert.equal('active' in out.state, false);
  assert.deepEqual(out.state.workouts.map(x => x.d), ['2026-01-01', '2026-03-01']);
  assert.equal(out.state._ts, 99);
});

test('merge stamps the document as changed now', () => {
  const out = mergeState({ ...cur(), _ts: 5 }, { workouts: [w('x', '2026-02-01')] }, { ts: 99 });
  assert.equal(out.state._ts, 99);
});

test('two sessions on one day keep their order by start', () => {
  const out = mergeState({ ...cur(), workouts: [] }, {
    workouts: [w('pm', '2026-02-01', { start: 2000 }), w('am', '2026-02-02', { start: 1000 })],
  });
  assert.deepEqual(out.state.workouts.map(x => x.id), ['pm', 'am']);
  const one = replaceState({ workouts: [w('pm', '2026-02-01', { start: 2000 }), w('am', '2026-02-01', { start: 1000 })] });
  assert.deepEqual(one.state.workouts.map(x => x.id), ['am', 'pm']);
});

test('stampRemoval names exactly what the new document no longer holds', () => {
  const before = {
    ...cur(),
    workouts: [w('a', '2026-01-01'), w('b', '2026-01-08'), { d: '2026-01-09', start: 7, entries: [] }],
    bodyweight: [{ d: '2026-01-01', w: 80, t: 11 }, { d: '2026-01-02', w: 81 }],
    favEx: ['0025', '0031'],
    exNotes: { '0025': 'elbows in', '0031': 'slow' },
  };
  const next = { ...before, workouts: [w('a', '2026-01-01')], bodyweight: [{ d: '2026-01-02', w: 81 }],
    favEx: ['0025'], exNotes: { '0025': 'elbows in' }, routines: [] };
  stampRemoval(before, next, 1000);
  assert.equal(next.resetAt, 1000);
  assert.deepEqual(next.resetIds.workouts, ['b', '2026-01-09|7']);
  assert.deepEqual(next.resetIds.bodyweight, ['2026-01-01|11']);
  assert.deepEqual(next.resetIds.routines, ['r1']);
  assert.deepEqual(next.resetIds.favEx, ['0031']);
  assert.deepEqual(next.resetIds.exNotes, ['0031']);
  assert.equal('customEx' in next.resetIds, false, 'a field with nothing removed is left out');
});

test('stampRemoval keeps the names of an earlier reset and only moves forward', () => {
  // A device that missed the earlier reset too must still drop what that one wiped; and a stamp
  // that went backwards would read, on every device that saw the later one, as an older copy.
  const before = { ...cur(), resetAt: 5000, resetIds: { workouts: ['old'] } };
  const next = { ...before, workouts: [w('a', '2026-01-01')] };
  stampRemoval(before, next, 1000);
  assert.equal(next.resetAt, 5001);
  assert.deepEqual(next.resetIds.workouts, ['old', 'b']);
});

test('stampRemoval of an unchanged document removes nothing, but is still a stamp', () => {
  const before = cur();
  const next = { ...before };
  stampRemoval(before, next, 1000);
  assert.equal(next.resetAt, 1000);
  assert.deepEqual(next.resetIds, {});
});
