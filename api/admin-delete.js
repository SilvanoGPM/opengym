// Working out exactly what a permanent account deletion removes.
//
// Pure and separate for two reasons: it decides what gets destroyed, which is worth a test rather
// than a careful read; and db.json is an in-memory cache that saveDb() rewrites wholesale, so the
// caller has to assign these arrays back onto `db` in process. Returning new arrays makes that
// the only shape the call site can take — editing the file on disk while the server is running is
// undone by the next saveDb() from any route.

/**
 * @returns {{ users, creds, subs, invites, removed: { creds, subs, invitesMarked } }}
 */
export function planUserDelete(db, uid) {
  const users = (db.users || []).filter(u => u.id !== uid);
  const creds = (db.creds || []).filter(c => c.userId !== uid);
  const subs = (db.subs || []).filter(s => s.userId !== uid);

  // A redeemed invite keeps its row and is flagged instead of being freed: a code that has been
  // used must never become usable again just because the account it created is gone. Codes this
  // user *created* are left exactly as they are — that is ownership history, not their data.
  let invitesMarked = 0;
  const invites = (db.invites || []).map(i => {
    if (i.usedBy !== uid) return i;
    invitesMarked++;
    return { ...i, usedByDeleted: true };
  });

  return {
    users, creds, subs, invites,
    removed: {
      creds: (db.creds || []).length - creds.length,
      subs: (db.subs || []).length - subs.length,
      invitesMarked,
    },
  };
}
