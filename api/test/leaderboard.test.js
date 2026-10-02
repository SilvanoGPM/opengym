import test from 'node:test';
import assert from 'node:assert/strict';
import { dailyRoll, isDay, rangeTotals, toKg } from '../leaderboard.js';

const w = (d, over = {}) => ({ id: 'w' + d, d, start: 1000, end: 1000 + 45 * 60000, vol: 100, ...over });
const totals = (state, from, to) => rangeTotals(dailyRoll(state), from, to);

test('a day is only a day', () => {
  for (const ok of ['2026-08-30', '0000-01-01']) assert.equal(isDay(ok), true);
  for (const bad of ['2026-8-30', '2026-08-30T00:00', 'today', '', null, undefined, 20260830]) {
    assert.equal(isDay(bad), false);
  }
});

test('pounds are weighed in kilos so two profiles can be compared at all', () => {
  // The whole point: same logged number, different unit, must not mean the same rank.
  assert.equal(toKg(100, 'kg'), 100);
  assert.equal(Math.round(toKg(100, 'lb') * 100) / 100, 45.36);
  // Anything that isn't a finite number contributes nothing rather than NaN-ing the total.
  for (const junk of [undefined, null, 'heavy', NaN, Infinity]) assert.equal(toKg(junk, 'kg'), 0);
});

test('dailyRoll survives a missing, empty or nonsense state', () => {
  for (const s of [null, undefined, {}, { workouts: 'nonsense' }]) {
    assert.deepEqual(rangeTotals(dailyRoll(s), '0000-01-01', '9999-12-31'),
      { checkins: 0, sessions: 0, volKg: 0, volUnknown: 0 });
  }
});

test('a record with no date is skipped rather than bucketed under undefined', () => {
  const roll = dailyRoll({ workouts: [w('2026-08-30'), { id: 'x', vol: 500 }, w(null)] });
  assert.deepEqual(Object.keys(roll.days), ['2026-08-30']);
});

test('two sessions in one day are one check-in but two sessions', () => {
  // Otherwise a double day out-ranks two separate days for the same amount of showing up.
  const out = totals({ workouts: [w('2026-08-30'), w('2026-08-30'), w('2026-08-28')] },
    '2026-08-24', '2026-08-30');
  assert.equal(out.checkins, 2);
  assert.equal(out.sessions, 3);
  assert.equal(out.volKg, 300);
});

test('the range includes both of its ends', () => {
  const state = { workouts: ['2026-08-23', '2026-08-24', '2026-08-27', '2026-08-30', '2026-08-31'].map(d => w(d)) };
  const out = totals(state, '2026-08-24', '2026-08-30');
  assert.equal(out.checkins, 3);
  // The days just outside are the ones that catch an off-by-one.
  assert.equal(totals(state, '2026-08-24', '2026-08-24').checkins, 1);
  assert.equal(totals(state, '2026-08-25', '2026-08-26').checkins, 0);
});

test('a range comparison on strings needs no Date and crosses a year end', () => {
  const state = { workouts: [w('2025-12-29'), w('2025-12-31'), w('2026-01-01'), w('2026-01-05')] };
  assert.equal(totals(state, '2025-12-29', '2026-01-04').checkins, 3);
});

test('a pound profile ranks by the same yardstick as a kilo one', () => {
  const lb = totals({ unit: 'lb', workouts: [w('2026-08-30', { vol: 1000 })] }, '2026-08-01', '2026-08-31');
  const kg = totals({ unit: 'kg', workouts: [w('2026-08-30', { vol: 1000 })] }, '2026-08-01', '2026-08-31');
  assert.equal(kg.volKg, 1000);
  assert.equal(lb.volKg, 453.6);
  assert.ok(lb.volKg < kg.volKg);
});

test('a workout with no volume is counted as unknown, not as zero', () => {
  // Same call as summarize(): under-reporting a total silently is worse than admitting the gap.
  const out = totals({ workouts: [w('2026-08-29'), w('2026-08-30', { vol: undefined })] },
    '2026-08-01', '2026-08-31');
  assert.equal(out.volKg, 100);
  assert.equal(out.volUnknown, 1);
  assert.equal(out.checkins, 2);
});

test('a session with no clock still counts — only volume needs a number', () => {
  // Backdated sessions have end === start. They lost the time ranking; they keep this one.
  const out = totals({ workouts: [w('2026-08-30', { end: 1000 })] }, '2026-08-01', '2026-08-31');
  assert.equal(out.checkins, 1);
  assert.equal(out.volKg, 100);
});

test('volume is rounded past what a plate can express', () => {
  const out = totals({ unit: 'lb', workouts: [w('2026-08-30', { vol: 137 })] }, '2026-08-01', '2026-08-31');
  assert.equal(out.volKg, 62.1);
});
