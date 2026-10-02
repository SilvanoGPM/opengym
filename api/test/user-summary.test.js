import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from '../user-summary.js';

const w = (d, over = {}) => ({ id: 'w' + d, d, start: 1000, end: 1000 + 45 * 60000, vol: 100, ...over });

test('summarize buckets by month, ascending, skipping empty months', () => {
  const out = summarize({ workouts: [w('2026-01-05'), w('2026-03-02'), w('2026-01-20')] });
  assert.deepEqual(out.monthly.map(m => m.m), ['2026-01', '2026-03']);
  assert.equal(out.monthly[0].workouts, 2);
  assert.equal(out.monthly[0].vol, 200);
});

test('a workout with no volume is counted as unknown, not as zero', () => {
  // The alternative is a chart that under-reports and looks like a drop in training.
  const out = summarize({ workouts: [w('2026-01-05'), w('2026-01-06', { vol: undefined })] });
  assert.equal(out.volUnknown, 1);
  assert.equal(out.monthly[0].vol, 100);
});

test('a session with no clock adds no time', () => {
  // Imported history and days filled in later have end === start.
  const out = summarize({ workouts: [w('2026-01-05', { end: 1000 })] });
  assert.equal(out.monthly[0].ms, 0);
});

test('reports the span actually trained', () => {
  const out = summarize({ workouts: [w('2026-01-05'), w('2026-02-09'), w('2026-03-02')] });
  assert.equal(out.first, '2026-01-05');
  assert.equal(out.last, '2026-03-02');
});

test('an empty state gives empty arrays, never nulls', () => {
  const out = summarize({});
  assert.deepEqual(out.monthly, []);
  assert.deepEqual(out.counts, { workouts: 0, bodyweight: 0, routines: 0, customEx: 0 });
  assert.equal(out.first, null);
  assert.equal(out.volUnknown, 0);
});

test('a workout with no date is ignored rather than bucketed under undefined', () => {
  const out = summarize({ workouts: [w('2026-01-05'), { id: 'broken' }] });
  assert.equal(out.monthly.length, 1);
  assert.equal(out.counts.workouts, 2);
});
