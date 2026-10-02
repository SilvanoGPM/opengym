// Sign in as a local dev profile without a passkey.
//
// A passkey ceremony needs a real authenticator, which is fine in a browser but is a wall in
// front of anyone trying to poke at the API or the admin dashboard from a terminal. The session
// is just an HMAC over "<uid>:<expiry>:<sv>" (api/server.js, sign/makeSession), so this creates a
// profile in db.json if it is missing and prints the cookie for it.
//
// Development only. It reads DATA_DIR/secret, so it can only mint a session for an instance whose
// data directory you already have on disk — but that is exactly why it must never run anywhere
// near a real one.
//
//   node scripts/dev-session.mjs [name] [--data ./data] [--days 90]
//
// Then either:
//   curl -b "$(node scripts/dev-session.mjs dev --quiet)" http://localhost:3000/api/me
// or paste the printed document.cookie line into the browser console on the dev server origin.
//
// `gymsid` is the cookie's name on plain http, which is what a dev API runs on. Behind https it is
// `__Host-gymsid`, or send the same token as `Authorization: Bearer <token>`, the way a paired
// phone does. With PASSWORD_LOGIN=1 a browser can simply sign in with a password instead.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const VALUE_FLAGS = ['--data', '--days']
const flag = (name, fallback) => {
  const i = args.indexOf('--' + name)
  return i < 0 ? fallback : args[i + 1]
}
const quiet = args.includes('--quiet')
// The first bare word that is not the value of a --flag.
const name = args.find((a, i) => !a.startsWith('--') && !VALUE_FLAGS.includes(args[i - 1])) || 'dev'
const dataDir = path.resolve(flag('data', './data'))
const days = +flag('days', 90)

const secretFile = path.join(dataDir, 'secret')
if (!fs.existsSync(secretFile)) {
  console.error(`No secret at ${secretFile} — start the API once so it generates one:\n` +
    `  DATA_DIR=${flag('data', './data')} PORT=3000 RP_ID=localhost ORIGIN=http://localhost:5173 node api/server.js`)
  process.exit(1)
}
// Read exactly as api/server.js reads it: as text, trimmed.
const secret = fs.readFileSync(secretFile, 'utf8').trim()

const dbFile = path.join(dataDir, 'db.json')
let db = { users: [], creds: [], subs: [], invites: [] }
try { db = JSON.parse(fs.readFileSync(dbFile, 'utf8')) } catch { /* first run */ }
db.users = db.users || []

let user = db.users.find(u => u.name === name)
if (!user) {
  // Same shape the register route writes, minus the credential — there is no passkey to store.
  user = { id: crypto.randomBytes(8).toString('hex'), name, created: new Date().toISOString() }
  db.users.push(user)
  fs.writeFileSync(dbFile, JSON.stringify(db, null, 2))
  if (!quiet) console.error(`Created profile "${name}" (${user.id}) in ${dbFile}`)
}

const payload = `${user.id}:${Date.now() + days * 86400000}:${user.sv || 0}`
const mac = crypto.createHmac('sha256', secret).update(payload).digest('base64url')
const cookie = `gymsid=${payload}.${mac}`

if (quiet) { console.log(cookie); process.exit(0) }

console.log(`\nuid   ${user.id}`)
console.log(`name  ${user.name}`)
console.log(`\nMake this profile an admin — restart the API with:`)
console.log(`  ADMIN_UIDS=${user.id}`)
console.log(`\ncurl:`)
console.log(`  curl -b "${cookie}" http://localhost:3000/api/me`)
console.log(`\nbrowser console, on the dev server's origin:`)
console.log(`  document.cookie = ${JSON.stringify(cookie + '; path=/')}; location.reload()\n`)
