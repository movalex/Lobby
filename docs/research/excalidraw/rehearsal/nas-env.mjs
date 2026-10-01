// Rehearsal prep: writes the env files of the draftroom-rehearsal-* stack on the NAS (owner approval
// 2026-10-01: staging's Clerk keys and Postgres may be copied to the NAS for the rehearsal, LAN-only).
//
// Every staging value is read through the Render API (RENDER_API_KEY is the ONLY key read from
// .env.deploy.local) and goes straight into mode-600 files under /volume3/Apps/draftroom-rehearsal/env
// over ssh stdin. Nothing is printed except file names, key names and value lengths. Random secrets
// (ticket, internal, worker token, Postgres password) are generated once and reused on a re-run, so a
// re-run only refreshes the staging-derived values.
//
// Usage: node nas-env.mjs [--dry]
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'

const LAN = '192.168.10.1'
const WEB_ORIGIN = `https://${LAN}:8443`
const SYNC_ORIGIN = `https://${LAN}:8444`
const NAS = `chase@${LAN}`
const NAS_KEY = `${process.env.HOME ?? 'C:/Users/Chase'}/.ssh/ugreen_nas`
const DIR = '/volume3/Apps/draftroom-rehearsal'
const SVC = { api: 'srv-dasq3e0473hc739f9qt0', sync: 'srv-dasq3e8473hc739f9sq0', web: 'srv-dasq2t8473hc739f7rhg' }
const PG_ID = 'dpg-dasq2t8473hc739f7ri0-a'
const dry = process.argv.includes('--dry')

const keyLine = readFileSync('C:/Users/Chase/Documents/GitHub/Draftroom/.env.deploy.local', 'utf8')
  .split(/\r?\n/)
  .find((l) => l.startsWith('RENDER_API_KEY='))
if (!keyLine) throw new Error('RENDER_API_KEY not found')
const H = { Authorization: `Bearer ${keyLine.slice(keyLine.indexOf('=') + 1).trim()}`, Accept: 'application/json' }
const render = async (path) => {
  const res = await fetch(`https://api.render.com/v1${path}`, { headers: H })
  if (!res.ok) throw new Error(`render GET ${path.split('?')[0]} -> ${res.status}`)
  return res.json()
}
async function serviceEnv(id) {
  const vars = (await render(`/services/${id}/env-vars?limit=100`)).map((v) => v.envVar ?? v)
  const out = Object.fromEntries(vars.filter((v) => v.value).map((v) => [v.key, v.value]))
  for (const g of (await render('/env-groups?limit=50')).map((x) => x.envGroup ?? x)) {
    if (!(g.serviceLinks ?? []).some((s) => s.id === id)) continue
    const full = await render(`/env-groups/${g.id}`)
    for (const v of (full.envVars ?? []).map((v) => v.envVar ?? v)) if (v.value && !(v.key in out)) out[v.key] = v.value
  }
  return out
}
const need = (obj, k, from) => {
  if (!obj[k]) throw new Error(`${k} missing on ${from}`)
  return obj[k]
}

const ssh = (cmd, input) => {
  const r = spawnSync('ssh', ['-i', NAS_KEY, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', NAS, cmd], {
    input,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (r.status !== 0) throw new Error(`ssh failed (${r.status}): ${(r.stderr || '').split('\n').filter((l) => !/post-quantum|store now|openssh.com\/pq/.test(l)).join(' ').slice(0, 200)}`)
  return r.stdout
}
const parseEnv = (text) =>
  Object.fromEntries(
    text
      .split(/\r?\n/)
      .filter((l) => l && !l.startsWith('#') && l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1)]),
  )

// 1. staging values
const api = await serviceEnv(SVC.api)
const web = await serviceEnv(SVC.web)
const ci = await render(`/postgres/${PG_ID}/connection-info`)
const staging = {
  CLERK_SECRET_KEY: need(api, 'CLERK_SECRET_KEY', 'api'),
  CLERK_PUBLISHABLE_KEY: need(api, 'CLERK_PUBLISHABLE_KEY', 'api'),
  DRAFTROOM_CREATOR_EMAILS: api.DRAFTROOM_CREATOR_EMAILS ?? '',
  DRAFTROOM_WORKSPACE_QUOTA_MB: api.DRAFTROOM_WORKSPACE_QUOTA_MB ?? '102400',
  VITE_TLDRAW_LICENSE_KEY: need(web, 'VITE_TLDRAW_LICENSE_KEY', 'web'),
  PG_EXTERNAL_URL: need(ci, 'externalConnectionString', 'postgres connection-info'),
}
console.log(
  'staging values read:',
  Object.entries(staging)
    .map(([k, v]) => `${k}(${v.length})`)
    .join(' '),
)

// 2. random secrets: reuse what the NAS already has
const existing = parseEnv(ssh(`cat ${DIR}/env/pg.env ${DIR}/env/api.env 2>/dev/null; true`))
const gen = (k, make) => {
  if (existing[k]) return { v: existing[k], src: 'kept' }
  return { v: make(), src: 'new' }
}
const b64 = () => randomBytes(32).toString('base64')
const pgPw = gen('POSTGRES_PASSWORD', () => randomBytes(24).toString('hex'))
const ticket = gen('DRAFTROOM_TICKET_SECRET', b64)
const internal = gen('DRAFTROOM_INTERNAL_SECRET', b64)
const worker = gen('DRAFTROOM_WORKER_TOKEN', b64)
console.log(`random secrets: pg password ${pgPw.src}, ticket ${ticket.src}, internal ${internal.src}, worker token ${worker.src}`)

// 3. the files
const files = {
  'pg-source.env': `# staging Postgres external URL: used ONLY by the one-shot pg_dump container\nPGURL=${staging.PG_EXTERNAL_URL}\n`,
  'pg.env': `POSTGRES_USER=draftroom\nPOSTGRES_PASSWORD=${pgPw.v}\nPOSTGRES_DB=draftroom\n`,
  'api.env': [
    'NODE_ENV=production',
    'HOST=0.0.0.0',
    'PORT=10000',
    'DRAFTROOM_DATA_DIR=/var/data',
    `DATABASE_URL=postgres://draftroom:${pgPw.v}@draftroom-rehearsal-pg:5432/draftroom`,
    'DRAFTROOM_BLOB_STORE=fs',
    `DRAFTROOM_WORKSPACE_QUOTA_MB=${staging.DRAFTROOM_WORKSPACE_QUOTA_MB}`,
    `PUBLIC_ORIGIN=${WEB_ORIGIN}`,
    'DRAFTROOM_SYNC_INTERNAL_URL=http://draftroom-rehearsal-sync:10000',
    'TRUST_PROXY=1',
    'AUTH_PROVIDER=clerk',
    `CLERK_SECRET_KEY=${staging.CLERK_SECRET_KEY}`,
    `CLERK_PUBLISHABLE_KEY=${staging.CLERK_PUBLISHABLE_KEY}`,
    ...(staging.DRAFTROOM_CREATOR_EMAILS ? [`DRAFTROOM_CREATOR_EMAILS=${staging.DRAFTROOM_CREATOR_EMAILS}`] : []),
    `DRAFTROOM_TICKET_SECRET=${ticket.v}`,
    `DRAFTROOM_INTERNAL_SECRET=${internal.v}`,
    `DRAFTROOM_WORKER_TOKEN=${worker.v}`,
    '',
  ].join('\n'),
  'sync.env': [
    'NODE_ENV=production',
    'HOST=0.0.0.0',
    'PORT=10000',
    'DRAFTROOM_DATA_DIR=/var/data',
    'DRAFTROOM_API_INTERNAL_URL=http://draftroom-rehearsal-api:10000',
    `ALLOWED_ORIGINS=${WEB_ORIGIN}`,
    'ACCESS_RECHECK_MS=10000',
    'DRAFTROOM_BACKUP_STORE=off',
    `DRAFTROOM_TICKET_SECRET=${ticket.v}`,
    `DRAFTROOM_INTERNAL_SECRET=${internal.v}`,
    '',
  ].join('\n'),
  'web-build.env': [`VITE_TLDRAW_LICENSE_KEY=${staging.VITE_TLDRAW_LICENSE_KEY}`, `VITE_DRAFTROOM_SYNC_ORIGIN=${SYNC_ORIGIN}`, ''].join('\n'),
}
for (const [name, body] of Object.entries(files)) {
  const keys = body.split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.slice(0, l.indexOf('=')))
  console.log(`${dry ? '(dry) ' : ''}${name}: ${keys.join(' ')}`)
  if (dry) continue
  ssh(`umask 077 && mkdir -p ${DIR}/env && chmod 700 ${DIR}/env && cat > ${DIR}/env/${name}.part && chmod 600 ${DIR}/env/${name}.part && mv ${DIR}/env/${name}.part ${DIR}/env/${name}`, body)
}
if (!dry) console.log(ssh(`ls -la ${DIR}/env`))
