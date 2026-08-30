// Snapshot bookkeeping for administrative writes. Names and pruning only — the filesystem work
// stays in server.js, so this half is testable without touching a disk.
//
// A snapshot is taken before every admin write and never by a normal PUT /api/data. It is what
// makes an administrative change reversible, which is the whole reason writing somebody else's
// data is defensible at all.

/** Where they live, relative to DATA_DIR. A directory so `ls data/` stays readable. */
export const SNAPSHOT_DIR = 'snapshots';

const NAME = /^state-([A-Za-z0-9_-]+)\.bak-(\d+)\.json$/;

export const snapshotName = (uid, ts) => `state-${uid}.bak-${ts}.json`;

/** `null` for anything that is not one of ours — including the live `state-<uid>.json`. */
export function parseSnapshotName(file) {
  const m = NAME.exec(String(file || ''));
  return m ? { uid: m[1], ts: +m[2] } : null;
}

/** Newest first. */
export function snapshotsFor(files, uid) {
  return (files || [])
    .map(f => ({ file: f, meta: parseSnapshotName(f) }))
    .filter(x => x.meta && x.meta.uid === uid)
    .sort((a, b) => b.meta.ts - a.meta.ts)
    .map(x => ({ file: x.file, ts: x.meta.ts }));
}

/**
 * Which files to delete so only the newest `keep` remain for this user.
 *
 * Count-based rather than age-based on purpose: someone written to once a year still deserves an
 * undo, and an age cap would quietly remove the only one they have.
 */
export function snapshotsToPrune(files, uid, keep = 10) {
  const n = Math.max(1, keep | 0);
  return snapshotsFor(files, uid).slice(n).map(x => x.file);
}
