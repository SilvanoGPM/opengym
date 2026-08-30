/* Storage for a user's LLM API key.
 *
 * The key is encrypted at rest with AES-256-GCM under a key derived from DATA/secret — the
 * same secret that already signs sessions, but through HKDF with its own `info` string so the
 * two uses can never produce the same bytes. HKDF and not scrypt on purpose: the input is
 * already 32 bytes of randomBytes(), not a password, so a deliberately slow KDF would buy
 * latency and nothing else.
 *
 * The AAD is `uid|provider`. That binds a ciphertext to its owner: hand-editing the file to
 * move somebody else's blob onto your own uid fails authentication instead of quietly working.
 *
 * What this does NOT protect against, and the docs say so plainly: whoever can read DATA/secret
 * can also read DATA/ai-keys.json. This is armour against a leaked partial backup, not against
 * the operator of the instance.
 */
import crypto from 'node:crypto';

export const KDF_INFO = 'opengym:ai-keys:v1';
const ALG = 'aes-256-gcm';

export const emptyFile = () => ({
  v: 1,
  kdf: { alg: 'hkdf-sha256', salt: crypto.randomBytes(16).toString('base64'), info: KDF_INFO },
  keys: {}
});

/** 32-byte data-encryption key. `secret` is the raw DATA/secret text, exactly as sessions use it. */
export function deriveKey(secret, saltB64, info = KDF_INFO) {
  return Buffer.from(crypto.hkdfSync(
    'sha256',
    Buffer.from(String(secret), 'utf8'),
    Buffer.from(String(saltB64 || ''), 'base64'),
    Buffer.from(info, 'utf8'),
    32
  ));
}

const aad = (uid, provider) => Buffer.from(`${uid}|${provider}`, 'utf8');

export function encryptKey(dek, uid, provider, plaintext) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv(ALG, dek, iv);
  c.setAAD(aad(uid, provider));
  const ct = Buffer.concat([c.update(String(plaintext), 'utf8'), c.final()]);
  return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), ct: ct.toString('base64') };
}

/**
 * Decrypt, or null. Never throws.
 *
 * Every failure mode lands here and they all mean the same thing to the user — "we cannot read
 * your key, put it in again": a regenerated DATA/secret, a restored backup missing it, a
 * hand-edited file, a blob moved between users. Turning any of those into a 500 would be a
 * server error for something that is not the server's fault.
 */
export function decryptKey(dek, uid, provider, rec) {
  try {
    const d = crypto.createDecipheriv(ALG, dek, Buffer.from(rec.iv, 'base64'));
    d.setAAD(aad(uid, provider));
    d.setAuthTag(Buffer.from(rec.tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(rec.ct, 'base64')), d.final()]).toString('utf8');
  } catch { return null; }
}

/** Last four characters, for the masked display. Never enough to reconstruct anything. */
export const hintOf = plaintext => String(plaintext || '').slice(-4);

/** UTC month bucket. Said out loud in the UI: a cap that resets at a surprising hour is worse than one that resets late. */
export const monthKey = (date = new Date()) => date.toISOString().slice(0, 7);

export const emptySpend = (date = new Date()) => ({ month: monthKey(date), usd: 0, calls: 0, unpriced: 0, in: 0, out: 0 });

/** True when the cap is set and already reached. `capUSD` of 0 means no cap. */
export function budgetExceeded(rec, date = new Date()) {
  const cap = Number(rec?.capUSD) || 0;
  if (cap <= 0) return false;
  const spend = rec.spend && rec.spend.month === monthKey(date) ? rec.spend : null;
  return !!spend && spend.usd >= cap;
}

/**
 * Fold one call's usage into the record, rolling the month over lazily on read.
 *
 * Nothing in this server schedules work — no cron, no timer beyond the audit rotation — so the
 * reset happens the next time somebody spends something, which is the only moment it matters.
 *
 * `usd` of null means the model is not in the price table. The tokens are still counted and
 * `unpriced` goes up, so the UI can say the spend is not estimable rather than silently
 * reporting $0.00 against the cap. A cap driven by a wrong number is worse than no cap.
 */
export function applySpend(rec, usage, usd, date = new Date()) {
  const m = monthKey(date);
  const s = rec.spend && rec.spend.month === m ? rec.spend : emptySpend(date);
  s.calls += 1;
  s.in += Number(usage?.in) || 0;
  s.out += Number(usage?.out) || 0;
  if (usd == null || !Number.isFinite(usd)) s.unpriced += 1;
  else s.usd = Math.round((s.usd + usd) * 1e6) / 1e6;
  rec.spend = s;
  return rec;
}
