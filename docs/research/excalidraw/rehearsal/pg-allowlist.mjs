// The staging Postgres allow list, for the rehearsal's dump (docs/research/excalidraw/REHEARSAL-PREP.md §3).
// Render refuses every external connection while `ipAllowList` is empty (render.yaml), so the dump needs the
// NAS's public /32 on the list for a few minutes, and nothing else, and the list put back exactly as it was.
//
//   node rehearsal/pg-allowlist.mjs show          the current entries (cidr and description)
//   node rehearsal/pg-allowlist.mjs add <ip>      save the current list, then PATCH it to current + <ip>/32
//   node rehearsal/pg-allowlist.mjs restore       PATCH the saved list back, read it back, forget the save
//
// Reads RENDER_API_KEY from the main checkout's .env.deploy.local (the same file as nas-env.mjs; override
// with DEPLOY_ENV_FILE) and nothing else; prints no value, ever.
// Owner approval (2026-10-01) covers draftroom-staging-db only, for the minutes of one dump.
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PG_ID = process.env.RENDER_PG_ID ?? 'dpg-dasq2t8473hc739f7ri0-a' // draftroom-staging-db
const ENV_FILE = process.env.DEPLOY_ENV_FILE ?? 'C:/Users/Chase/Documents/GitHub/Draftroom/.env.deploy.local'
const SAVE = process.env.PG_ALLOWLIST_SAVE ?? join(tmpdir(), `draftroom-pg-allowlist-${PG_ID}.json`)
const DESCRIPTION = 'draftroom rehearsal dump (temporary)'

const line = readFileSync(ENV_FILE, 'utf8')
  .split(/\r?\n/)
  .map((l) => l.match(/^\s*RENDER_API_KEY\s*=\s*(.+?)\s*$/))
  .find(Boolean)
if (!line) throw new Error('RENDER_API_KEY not found in .env.deploy.local')
const H = {
  authorization: `Bearer ${line[1].replace(/^["']|["']$/g, '')}`,
  accept: 'application/json',
  'content-type': 'application/json',
}
const pick = (list) => (list ?? []).map((e) => ({ cidrBlock: e.cidrBlock, description: e.description }))
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

async function get() {
  const r = await fetch(`https://api.render.com/v1/postgres/${PG_ID}`, { headers: H })
  if (!r.ok) throw new Error(`GET /postgres/${PG_ID} -> ${r.status}`)
  const j = await r.json()
  return { name: j.name, list: pick(j.ipAllowList) }
}
async function patch(list) {
  const r = await fetch(`https://api.render.com/v1/postgres/${PG_ID}`, {
    method: 'PATCH',
    headers: H,
    body: JSON.stringify({ ipAllowList: list }),
  })
  if (!r.ok) throw new Error(`PATCH /postgres/${PG_ID} -> ${r.status} ${(await r.text()).slice(0, 200)}`)
  return pick((await r.json()).ipAllowList)
}

const [cmd, ip] = process.argv.slice(2)
const cur = await get()
console.log(`${cur.name}: ${JSON.stringify(cur.list)}`)

if (cmd === 'show' || cmd === undefined) {
  // nothing more
} else if (cmd === 'add') {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip ?? '')) throw new Error('usage: add <ipv4>')
  if (existsSync(SAVE)) {
    const saved = JSON.parse(readFileSync(SAVE, 'utf8')).list
    if (!same(saved, cur.list)) throw new Error(`a saved list exists at ${SAVE} and differs from the current one: run restore first`)
  } else {
    writeFileSync(SAVE, JSON.stringify({ id: PG_ID, at: new Date().toISOString(), list: cur.list }, null, 2))
  }
  console.log(`saved -> ${SAVE}`)
  const next = [...cur.list, { cidrBlock: `${ip}/32`, description: DESCRIPTION }]
  console.log(`PATCH -> ${JSON.stringify(await patch(next))}`)
  console.log(`read back: ${JSON.stringify((await get()).list)}`)
} else if (cmd === 'restore') {
  if (!existsSync(SAVE)) throw new Error(`no saved list at ${SAVE}`)
  const saved = JSON.parse(readFileSync(SAVE, 'utf8')).list
  console.log(`PATCH (saved) -> ${JSON.stringify(await patch(saved))}`)
  const after = (await get()).list
  console.log(`read back: ${JSON.stringify(after)}`)
  if (!same(after, saved)) throw new Error('the list read back differs from the saved one')
  unlinkSync(SAVE)
  console.log('restored; the save file is gone')
} else {
  throw new Error(`unknown command ${cmd}: show | add <ip> | restore`)
}
