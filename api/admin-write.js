// The gate every administrative write passes through.
//
// Writing into another person's account is only defensible with guards that hold, so they live in
// one pure function instead of being re-typed per route. The ORDER is part of the contract:
// validate before anything is snapshotted, so a file that was never going to be written does not
// leave a snapshot behind; and check "is this person training right now" last, so somebody who
// picked the wrong file is told that first.
import { validateState } from './state-schema.js';

/**
 * @returns {{ ok: true } | { ok: false, status: number, code: string, error: string }}
 */
export function canAdminWrite({ target, mode, state, confirm, live, requireConfirm = false }) {
  if (!target) return { ok: false, status: 404, code: 'no-user', error: 'no such user' };

  if (mode !== undefined) {
    if (mode !== 'merge' && mode !== 'replace') {
      return { ok: false, status: 400, code: 'bad-mode', error: "mode must be 'merge' or 'replace'" };
    }
    const v = validateState(state);
    if (!v.ok) {
      return { ok: false, status: 400, code: 'invalid-state', error: v.errors.join('; ') };
    }
    // Replace is the only operation here that can destroy data the user made, so it is the only
    // one that will not run on a request that merely looks right.
    if (mode === 'replace' && confirm !== true) {
      return { ok: false, status: 400, code: 'confirm-required', error: 'replacing a user\'s data needs an explicit confirmation' };
    }
  }

  if (requireConfirm && confirm !== true) {
    return { ok: false, status: 400, code: 'confirm-required', error: 'this needs an explicit confirmation' };
  }

  // A courtesy, not a lock: presence is in memory and expires ~70s after the last heartbeat. Every
  // admin write bumps the profile's `_rev`, so a client mid-session gets a 409 and merges rather
  // than overwriting — but the session it is logging is device-local (`active`) until it finishes,
  // and a restore under it would leave that session to land on a profile that changed under it.
  if (live) {
    return {
      ok: false, status: 409, code: 'live',
      error: `${target.name || 'That user'} is training right now — their app would overwrite this. Try again once they finish.`,
    };
  }

  return { ok: true };
}
