import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  emptyFile, deriveKey, encryptKey, decryptKey, hintOf,
  monthKey, emptySpend, budgetExceeded, applySpend
} from './ai-keys.js';

const SECRET = crypto.randomBytes(32).toString('hex');
const file = emptyFile();
const dek = deriveKey(SECRET, file.kdf.salt);

test('a key round-trips', () => {
  const rec = encryptKey(dek, 'u1', 'anthropic', 'sk-ant-secret-value');
  assert.equal(decryptKey(dek, 'u1', 'anthropic', rec), 'sk-ant-secret-value');
});

test('the ciphertext is not the key', () => {
  const rec = encryptKey(dek, 'u1', 'anthropic', 'sk-ant-secret-value');
  assert.ok(!JSON.stringify(rec).includes('secret-value'));
});

test('a blob moved to another user does not decrypt', () => {
  // The AAD is uid|provider. Hand-editing ai-keys.json to put somebody else's blob under your
  // own id has to fail authentication rather than quietly hand you their key.
  const rec = encryptKey(dek, 'u1', 'anthropic', 'sk-ant-secret-value');
  assert.equal(decryptKey(dek, 'u2', 'anthropic', rec), null);
  assert.equal(decryptKey(dek, 'u1', 'openai', rec), null);
});

test('a regenerated secret reads as unreadable, not as a crash', () => {
  // Deleting or restoring DATA/secret already invalidates every session. The AI key has to
  // degrade the same way: "save it again", never a 500.
  const rec = encryptKey(dek, 'u1', 'anthropic', 'sk-ant-secret-value');
  const other = deriveKey(crypto.randomBytes(32).toString('hex'), file.kdf.salt);
  assert.equal(decryptKey(other, 'u1', 'anthropic', rec), null);
});

test('garbage in the file reads as unreadable, not as a crash', () => {
  assert.equal(decryptKey(dek, 'u1', 'anthropic', { iv: '!', tag: '!', ct: '!' }), null);
  assert.equal(decryptKey(dek, 'u1', 'anthropic', {}), null);
});

test('the derived key is not the session secret, and depends on the salt', () => {
  // Same secret, different purpose: HKDF's info string is what keeps the two apart.
  assert.notEqual(dek.toString('hex'), Buffer.from(SECRET, 'utf8').toString('hex'));
  assert.notEqual(dek.toString('hex'), deriveKey(SECRET, emptyFile().kdf.salt).toString('hex'));
});

test('the hint is four characters and nothing more', () => {
  assert.equal(hintOf('sk-ant-api03-abcd1234'), '1234');
  assert.equal(hintOf(''), '');
  assert.equal(hintOf(undefined), '');
});

test('spend accumulates and rolls over at the month boundary', () => {
  const jan = new Date('2026-01-31T23:00:00Z');
  const feb = new Date('2026-02-01T01:00:00Z');
  const rec = { capUSD: 5 };
  applySpend(rec, { in: 1000, out: 500 }, 0.01, jan);
  applySpend(rec, { in: 1000, out: 500 }, 0.02, jan);
  assert.equal(rec.spend.month, '2026-01');
  assert.equal(rec.spend.usd, 0.03);
  assert.equal(rec.spend.calls, 2);
  assert.equal(rec.spend.in, 2000);

  applySpend(rec, { in: 10, out: 10 }, 0.005, feb);
  assert.equal(rec.spend.month, '2026-02');
  assert.equal(rec.spend.usd, 0.005, 'February starts from zero');
  assert.equal(rec.spend.calls, 1);
});

test('an unpriced model counts tokens but not money', () => {
  // A model missing from the table must not read as free, or the cap would be enforced with a
  // number that is quietly wrong.
  const rec = {};
  applySpend(rec, { in: 900, out: 100 }, null, new Date('2026-03-02T00:00:00Z'));
  assert.equal(rec.spend.usd, 0);
  assert.equal(rec.spend.unpriced, 1);
  assert.equal(rec.spend.in, 900);
});

test('a cap of zero is no cap', () => {
  const rec = { capUSD: 0, spend: { ...emptySpend(), usd: 999 } };
  assert.equal(budgetExceeded(rec), false);
});

test('the cap only counts this month', () => {
  const now = new Date('2026-04-10T00:00:00Z');
  assert.equal(budgetExceeded({ capUSD: 1, spend: { month: '2026-04', usd: 1 } }, now), true);
  assert.equal(budgetExceeded({ capUSD: 1, spend: { month: '2026-03', usd: 99 } }, now), false);
  assert.equal(budgetExceeded({ capUSD: 1, spend: { month: '2026-04', usd: 0.99 } }, now), false);
});

test('the month bucket is UTC', () => {
  assert.equal(monthKey(new Date('2026-02-01T00:30:00Z')), '2026-02');
});
