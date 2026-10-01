#!/usr/bin/env node
// GET (or POST) an api path through the rehearsal edge with the rehearsal-local session cookie, and print
// a privacy-safe summary: status, and for known shapes ids/counts/codes only. Never prints titles or text.
//   node api-get.mjs --base https://192.168.10.1:8443 --token-file session.token --path /api/boards
//   node api-get.mjs ... --path /api/boards/<id>/ticket --method POST
//   node api-get.mjs ... --path /api/workspaces/<wid>/boards --method POST --body '{"title":"Rehearsal born-after board"}'
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

const { values: a } = parseArgs({
  options: {
    base: { type: 'string' },
    'token-file': { type: 'string' },
    path: { type: 'string' },
    method: { type: 'string', default: 'GET' },
    body: { type: 'string' },
    raw: { type: 'boolean', default: false },
  },
})
const BASE = new URL(a.base)
const token = readFileSync(a['token-file'], 'utf8').trim()
const res = await fetch(`${BASE.origin}${a.path}`, {
  method: a.method,
  headers: {
    cookie: `dr_session=${token}`,
    origin: BASE.origin,
    ...(a.body ? { 'content-type': 'application/json' } : {}),
  },
  body: a.body,
  signal: AbortSignal.timeout(30_000),
})
const text = await res.text()
let j = null
try {
  j = JSON.parse(text)
} catch {}
const SAFE_KEYS = new Set([
  'id', 'role', 'status', 'newCanvas', 'new_canvas', 'reason', 'bodyVersion', 'body_version', 'createdAt', 'created_at',
  'kind', 'workspaceId', 'workspace_id', 'projectId', 'expiresAt', 'documentClock', 'clock', 'automatic', 'authorId',
  'count', 'total', 'code', 'ok', 'providers', 'visibility', 'engine', 'canvas', 'elements', 'archived',
])
const scrub = (v, depth = 0) => {
  if (Array.isArray(v)) return v.map((x) => scrub(x, depth + 1))
  if (v && typeof v === 'object') {
    const o = {}
    for (const [k, x] of Object.entries(v)) {
      if (SAFE_KEYS.has(k)) o[k] = typeof x === 'object' ? scrub(x, depth + 1) : x
      else if (Array.isArray(x)) o[k] = `[${x.length}]`
      else if (x && typeof x === 'object') o[k] = scrub(x, depth + 1)
      else if (k === 'ticket') o[k] = `<${String(x).length} chars>`
      else o[k] = typeof x === 'string' ? `<${x.length} chars>` : typeof x
    }
    return o
  }
  return v
}
if (a.raw) console.log(res.status, text)
else console.log(res.status, j === null ? `<${text.length} bytes, not JSON>` : JSON.stringify(scrub(j)))
process.exit(res.ok ? 0 : 1)
