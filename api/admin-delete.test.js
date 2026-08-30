import test from 'node:test';
import assert from 'node:assert/strict';
import { planUserDelete } from './admin-delete.js';

const db = () => ({
  users: [{ id: 'u1', name: 'Root', admin: true }, { id: 'u2', name: 'Ana' }, { id: 'u3', name: 'Bo' }],
  creds: [{ id: 'c1', userId: 'u2' }, { id: 'c2', userId: 'u2' }, { id: 'c3', userId: 'u3' }],
  subs: [{ userId: 'u2', endpoint: 'https://push/1' }, { userId: 'u3', endpoint: 'https://push/2' }],
  invites: [
    { code: 'AAA', createdBy: 'u1', usedBy: 'u2', usedAt: '2026-01-01' },
    { code: 'BBB', createdBy: 'u2' },
    { code: 'CCC', createdBy: 'u1', usedBy: 'u3' },
  ],
});

test('removes exactly the one user', () => {
  const p = planUserDelete(db(), 'u2');
  assert.deepEqual(p.users.map(u => u.id), ['u1', 'u3']);
});

test('takes their passkeys and push subscriptions with them', () => {
  // Leaving a credential behind means login/verify can find one pointing at nobody, and a stale
  // subscription means the server keeps contacting an endpoint for a ghost.
  const p = planUserDelete(db(), 'u2');
  assert.deepEqual(p.creds.map(c => c.id), ['c3']);
  assert.deepEqual(p.subs.map(s => s.userId), ['u3']);
  assert.equal(p.removed.creds, 2);
  assert.equal(p.removed.subs, 1);
});

test('everybody else comes back byte-identical', () => {
  const before = db();
  const p = planUserDelete(before, 'u2');
  assert.deepEqual(p.users.find(u => u.id === 'u3'), before.users.find(u => u.id === 'u3'));
  assert.deepEqual(p.creds.find(c => c.id === 'c3'), before.creds.find(c => c.id === 'c3'));
});

test('a redeemed invite is flagged, never freed', () => {
  // The point: a code that has been used must not become usable again because the account went.
  const p = planUserDelete(db(), 'u2');
  const used = p.invites.find(i => i.code === 'AAA');
  assert.equal(used.usedBy, 'u2');
  assert.equal(used.usedByDeleted, true);
  assert.equal(p.removed.invitesMarked, 1);
});

test('a code they created is left alone', () => {
  const p = planUserDelete(db(), 'u2');
  const made = p.invites.find(i => i.code === 'BBB');
  assert.deepEqual(made, { code: 'BBB', createdBy: 'u2' });
});

test('does not mutate the db it was handed', () => {
  // The caller assigns the results and calls saveDb(); mutating here would half-apply on a throw.
  const before = db();
  planUserDelete(before, 'u2');
  assert.equal(before.users.length, 3);
  assert.equal(before.creds.length, 3);
  assert.equal(before.invites[0].usedByDeleted, undefined);
});

test('an unknown uid changes nothing', () => {
  const p = planUserDelete(db(), 'nobody');
  assert.equal(p.users.length, 3);
  assert.deepEqual(p.removed, { creds: 0, subs: 0, invitesMarked: 0 });
});

test('survives a db with missing arrays', () => {
  const p = planUserDelete({ users: [{ id: 'u1' }] }, 'u1');
  assert.deepEqual(p.users, []);
  assert.deepEqual(p.creds, []);
  assert.deepEqual(p.invites, []);
});
