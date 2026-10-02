import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshotName, parseSnapshotName, snapshotsFor, snapshotsToPrune } from '../snapshots.js';

test('a name round-trips', () => {
  const f = snapshotName('abc123', 1788000000000);
  assert.deepEqual(parseSnapshotName(f), { uid: 'abc123', ts: 1788000000000 });
});

test('the live state file is not a snapshot', () => {
  // The prune list is fed a directory listing; mistaking state-<uid>.json for a snapshot would
  // delete the very file being protected.
  assert.equal(parseSnapshotName('state-abc123.json'), null);
  assert.equal(parseSnapshotName('db.json'), null);
  assert.equal(parseSnapshotName('audit.log'), null);
  assert.equal(parseSnapshotName(''), null);
  assert.equal(parseSnapshotName(undefined), null);
});

test('snapshots are listed newest first', () => {
  const files = [snapshotName('u1', 100), snapshotName('u1', 300), snapshotName('u1', 200)];
  assert.deepEqual(snapshotsFor(files, 'u1').map(s => s.ts), [300, 200, 100]);
});

test('pruning keeps the newest N and never touches another user', () => {
  // The one that matters: uids share a directory.
  const files = [
    snapshotName('u1', 1), snapshotName('u1', 2), snapshotName('u1', 3), snapshotName('u1', 4),
    snapshotName('u2', 1), snapshotName('u2', 2),
    'state-u1.json', 'db.json',
  ];
  const prune = snapshotsToPrune(files, 'u1', 2);
  assert.deepEqual(prune.sort(), [snapshotName('u1', 1), snapshotName('u1', 2)].sort());
  assert.ok(prune.every(f => !f.includes('u2')));
  assert.ok(!prune.includes('state-u1.json'));
});

test('nothing to prune when there are fewer than the limit', () => {
  assert.deepEqual(snapshotsToPrune([snapshotName('u1', 1)], 'u1', 10), []);
  assert.deepEqual(snapshotsToPrune([], 'u1', 10), []);
});

test('a keep of zero still leaves one', () => {
  // Somebody written to once a year must not lose their only undo to a misconfigured limit.
  const files = [snapshotName('u1', 1), snapshotName('u1', 2)];
  assert.deepEqual(snapshotsToPrune(files, 'u1', 0), [snapshotName('u1', 1)]);
});

test('a uid that is a prefix of another is not confused with it', () => {
  const files = [snapshotName('u1', 1), snapshotName('u10', 1)];
  assert.deepEqual(snapshotsFor(files, 'u1').length, 1);
  assert.deepEqual(snapshotsFor(files, 'u1')[0].file, snapshotName('u1', 1));
});
