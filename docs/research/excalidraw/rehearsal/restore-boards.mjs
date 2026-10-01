// Rehearsal prep step 2: restore every staging board's newest offsite backup (R2) into a NEW scratch
// folder, signatures verified, with the drill tooling of the live build (main = origin/main). Modeled on
// switch/spike-restore.mjs, but every secret comes from the Render API (the sync service's R2_* values
// and the env group's DRAFTROOM_INTERNAL_SECRET): RENDER_API_KEY is the only key read locally. Secrets
// go only into the child process env; nothing secret is printed or written.
// Usage: node restore-boards.mjs [--dry]
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const REPO = 'C:/Users/Chase/Documents/GitHub/Draftroom'
const SCRATCH =
  'C:/Users/Chase/AppData/Local/Temp/claude/C--Users-Chase-Documents-GitHub-Draftroom/3dc84691-7141-4bcc-93bd-450e201c602f/scratchpad/rehearsal-data'
const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)
const RUN = `${SCRATCH}/${stamp}`

const keyLine = readFileSync(`${REPO}/.env.deploy.local`, 'utf8')
  .split(/\r?\n/)
  .find((l) => l.startsWith('RENDER_API_KEY='))
const H = { Authorization: `Bearer ${keyLine.slice(keyLine.indexOf('=') + 1).trim()}`, Accept: 'application/json' }
const SYNC = 'srv-dasq3e8473hc739f9sq0'
const render = async (path) => {
  const res = await fetch(`https://api.render.com/v1${path}`, { headers: H })
  if (!res.ok) throw new Error(`render GET ${path.split('?')[0]} -> ${res.status}`)
  return res.json()
}
const vars = (await render(`/services/${SYNC}/env-vars?limit=100`)).map((v) => v.envVar ?? v)
const env = Object.fromEntries(vars.filter((v) => v.value).map((v) => [v.key, v.value]))
for (const g of (await render('/env-groups?limit=50')).map((x) => x.envGroup ?? x)) {
  if (!(g.serviceLinks ?? []).some((s) => s.id === SYNC)) continue
  const full = await render(`/env-groups/${g.id}`)
  for (const v of (full.envVars ?? []).map((v) => v.envVar ?? v)) if (v.value && !(v.key in env)) env[v.key] = v.value
}
const NEEDED = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'DRAFTROOM_INTERNAL_SECRET']
const missing = NEEDED.filter((k) => !env[k])
if (missing.length) throw new Error(`missing on the sync service / its env groups: ${missing.join(', ')}`)
console.log(`secrets: ${NEEDED.map((k) => `${k}(${env[k].length})`).join(' ')}; store ${env.DRAFTROOM_BACKUP_STORE ?? '-'}`)
if (process.argv.includes('--dry')) process.exit(0)

mkdirSync(`${RUN}/data`, { recursive: true })
mkdirSync(`${RUN}/tmp`, { recursive: true })
writeFileSync(`${RUN}/README.txt`, `rehearsal board restore ${new Date().toISOString()} from R2 (read-only), build ${REPO} main\n`)
console.log(`run folder: ${RUN}`)
const child = spawn(
  process.execPath,
  ['src/backup/restore-drill.ts', '--from=store', '--keep', '--data-dir', `${RUN}/data`],
  {
    cwd: `${REPO}/apps/sync`,
    stdio: 'inherit',
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      TEMP: `${RUN}/tmp`,
      TMP: `${RUN}/tmp`,
      NODE_ENV: 'production',
      DRAFTROOM_BACKUP_STORE: 'r2',
      DRAFTROOM_INTERNAL_SECRET: env.DRAFTROOM_INTERNAL_SECRET,
      R2_ACCOUNT_ID: env.R2_ACCOUNT_ID,
      R2_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID,
      R2_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY,
      R2_BUCKET: env.R2_BUCKET,
    },
  },
)
child.on('exit', (code) => process.exit(code ?? 1))
