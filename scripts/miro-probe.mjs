#!/usr/bin/env node
// The Miro probe (wave R, plan item R0.4; docs/WAVE-R-CONTRACTS.md §3.4): the owner runs it ONCE, on his own machine,
// with a Miro access token of his (scope boards:read), before WS1 freezes the importer's host list and help text. It
// answers what Miro's documentation does not: which team the token reaches, how the boards' items are made up (types,
// shape kinds, connectors, groups, tags, frames, paint order), which host a resource answer's signed URL points at
// (MIRO_DOWNLOAD_HOSTS), whether that URL expires, and the rate-limit headers. Nothing is written to Miro (GET only).
//
// Usage (the token is read from the environment or a file, NEVER from the command line, so it stays out of the shell
// history and the process list):
//   MIRO_TOKEN=… node scripts/miro-probe.mjs                     the team, the first 3 boards, a summary
//   MIRO_TOKEN_FILE=token.txt node scripts/miro-probe.mjs --boards 5
//   MIRO_TOKEN=… node scripts/miro-probe.mjs --board uXjVOD1Ab2c= --board uXjVOD9Zz8y=
//   MIRO_TOKEN=… node scripts/miro-probe.mjs --json probe.json --mindmaps
//
// What it prints and writes: the team's name, the token's scopes, board names (on the screen only, to pick from) and,
// per probed board, counts by item type and shape kind, connector shapes and caps, groups, tags, frames, whether
// children are frame-relative, the first item ids in Miro's order, and the image download host with the NAMES of its
// query parameters. Never the token, never a signed URL, never item text or content; every printed line is scrubbed
// of the token as a last guard. The JSON holds ids and counts only (no board names unless --names).
//
// Only https://api.miro.com is called (redirects refused, 20 s per request, 4 MiB per answer). The files themselves
// are never downloaded. After the probe: revoke the token in Miro (Settings → Your apps → the app → uninstall).
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const MIRO_API = 'https://api.miro.com'
const TIMEOUT_MS = 20_000
const MAX_ANSWER_BYTES = 4 * 1024 * 1024
const MAX_ITEMS_PER_BOARD = 10_000
const FIRST_IDS = 20

/** A probe failure: a code and an HTTP status, never another service's words. */
export class ProbeError extends Error {
  constructor(code, status = null) {
    super(status ? `${code} (HTTP ${status})` : code)
    this.name = 'ProbeError'
    this.code = code
    this.status = status
  }
}

/** `text` with the token (as written and percent-encoded) replaced. */
export function scrub(text, token) {
  if (!token) return text
  return String(text).split(token).join('[redacted]').split(encodeURIComponent(token)).join('[redacted]')
}

/** What a signed URL may tell: its host, its scheme and the names (not values) of its query parameters. */
export function describeSignedUrl(raw, nowMs = Date.now()) {
  let url
  try {
    url = new URL(raw)
  } catch {
    return { host: null, scheme: null, params: [], expiresInS: null }
  }
  const expires = url.searchParams.get('Expires')
  const expiresInS = expires && /^\d{9,11}$/.test(expires) ? Math.round(Number(expires) - nowMs / 1000) : null
  return {
    host: url.hostname,
    scheme: url.protocol.replace(':', ''),
    params: [...new Set(url.searchParams.keys())].sort(),
    expiresInS,
  }
}

/** A JSON GET to the API with the Bearer token: redirects refused, a deadline, a byte cap. */
export function makeClient({ token, base = MIRO_API, fetchImpl = fetch }) {
  const origin = new URL(base).origin
  const local = /^http:\/\/127\.0\.0\.1:\d+$/.test(origin)
  if (origin !== MIRO_API && !local) throw new ProbeError('BASE_NOT_ALLOWED')
  const rate = { limit: null, remaining: null }
  async function get(path) {
    if (!path.startsWith('/v1/') && !path.startsWith('/v2/') && !path.startsWith('/v2-experimental/'))
      throw new ProbeError('PATH_NOT_ALLOWED')
    let res
    try {
      res = await fetchImpl(`${origin}${path}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (e) {
      throw new ProbeError(e?.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK')
    }
    rate.limit = res.headers.get('x-ratelimit-limit') ?? rate.limit
    rate.remaining = res.headers.get('x-ratelimit-remaining') ?? rate.remaining
    if (res.status >= 300 && res.status < 400) throw new ProbeError('REDIRECT_REFUSED', res.status)
    const body = Buffer.from(await res.arrayBuffer())
    if (body.length > MAX_ANSWER_BYTES) throw new ProbeError('ANSWER_TOO_LARGE', res.status)
    if (res.status === 400 || res.status === 401) throw new ProbeError('TOKEN_INVALID', res.status)
    if (res.status === 403) throw new ProbeError('SCOPE_MISSING', res.status)
    if (res.status === 404) throw new ProbeError('NOT_VISIBLE', res.status)
    if (res.status === 429) throw new ProbeError('RATE_LIMITED', res.status)
    if (res.status !== 200) throw new ProbeError('UNAVAILABLE', res.status)
    try {
      return JSON.parse(body.toString('utf8'))
    } catch {
      throw new ProbeError('NOT_JSON', res.status)
    }
  }
  return { get, rate, origin }
}

const bump = (map, key) => {
  const k = String(key ?? '(none)')
  map[k] = (map[k] ?? 0) + 1
}

/** Every page of a cursor-paged list (items, connectors, groups), up to `max` entries. */
async function allPages(get, path, max) {
  const out = []
  let cursor = null
  for (let pages = 0; pages < 1_000 && out.length < max; pages++) {
    const sep = path.includes('?') ? '&' : '?'
    const page = await get(`${path}${sep}limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
    for (const entry of page.data ?? []) out.push(entry)
    cursor = page.cursor ?? null
    if (!cursor) break
  }
  return out
}

/** One board's make-up: counts and ids, never content. */
export async function probeBoard(client, boardId, opts = {}) {
  // A board id is [A-Za-z0-9_=-]. Whether Miro wants its `=` as it is or percent-encoded in a path is not documented
  // (UNVERIFIED): the probe tries it as it is (what the importer's egress rules match) and, on a 404, encoded, and
  // records which one worked (`idInPath`).
  if (!/^[A-Za-z0-9_=-]{6,64}$/.test(boardId)) throw new ProbeError('BAD_BOARD_ID')
  let enc = boardId
  let items
  try {
    items = await allPages(client.get, `/v2/boards/${enc}/items`, MAX_ITEMS_PER_BOARD)
  } catch (e) {
    if (e.code !== 'NOT_VISIBLE' || !boardId.includes('=')) throw e
    enc = encodeURIComponent(boardId)
    items = await allPages(client.get, `/v2/boards/${enc}/items`, MAX_ITEMS_PER_BOARD)
  }
  const idInPath = enc === boardId ? 'as-is' : 'encoded'
  const byType = {}
  const shapes = {}
  const stickyShapes = {}
  const relativeTo = {}
  const fonts = {}
  let withParent = 0
  let image = null
  let document = null
  for (const it of items) {
    bump(byType, it.type)
    if (it.type === 'shape') bump(shapes, it.data?.shape)
    if (it.type === 'sticky_note') bump(stickyShapes, it.data?.shape)
    if (it.style?.fontFamily) bump(fonts, it.style.fontFamily)
    bump(relativeTo, it.position?.relativeTo)
    if (it.parent?.id) withParent++
    if (it.type === 'image' && !image && it.data?.imageUrl) image = it.data.imageUrl
    if (it.type === 'document' && !document && it.data?.documentUrl) document = it.data.documentUrl
  }
  const connectors = await allPages(client.get, `/v2/boards/${enc}/connectors`, MAX_ITEMS_PER_BOARD)
  const connectorShapes = {}
  const caps = {}
  let unsupported = 0
  let captions = 0
  for (const c of connectors) {
    bump(connectorShapes, c.shape)
    bump(caps, c.style?.startStrokeCap)
    bump(caps, c.style?.endStrokeCap)
    if (c.isSupported === false) unsupported++
    captions += Array.isArray(c.captions) ? c.captions.length : 0
  }
  const groups = await allPages(client.get, `/v2/boards/${enc}/groups`, MAX_ITEMS_PER_BOARD)
  const tags = await client.get(`/v2/boards/${enc}/tags?limit=50`).catch(() => ({ data: [] }))
  const files = {}
  for (const [kind, raw] of [
    ['image', image],
    ['document', document],
  ]) {
    if (!raw) continue
    const path = resourcePath(raw, client.origin)
    if (!path) {
      files[kind] = { error: 'UNEXPECTED_RESOURCE_URL' }
      continue
    }
    try {
      const answer = await client.get(`${path}?format=original&redirect=false`)
      files[kind] = { answerType: answer.type ?? null, ...describeSignedUrl(answer.url ?? '') }
    } catch (e) {
      files[kind] = { error: e.code ?? 'FAILED' }
    }
  }
  let mindmap = null
  if (opts.mindmaps) {
    try {
      const path = `/v2-experimental/boards/${enc}/mindmap_nodes`
      const nodes = await allPages(client.get, path, MAX_ITEMS_PER_BOARD)
      mindmap = {
        nodes: nodes.length,
        withPosition: nodes.filter((n) => n.position && typeof n.position.x === 'number').length,
        withGeometry: nodes.filter((n) => n.geometry && typeof n.geometry.width === 'number').length,
      }
    } catch (e) {
      mindmap = { error: e.code ?? 'FAILED' }
    }
  }
  return {
    boardId,
    idInPath,
    items: items.length,
    itemsCapped: items.length >= MAX_ITEMS_PER_BOARD,
    byType,
    shapes,
    stickyShapes,
    fonts,
    positionRelativeTo: relativeTo,
    withParent,
    firstItemIds: items.slice(0, FIRST_IDS).map((i) => String(i.id)),
    connectors: { count: connectors.length, shapes: connectorShapes, caps, unsupported, captions },
    groups: groups.length,
    tags: (tags.data ?? []).length,
    files,
    mindmap,
  }
}

/** The API path of an item's imageUrl or documentUrl (`/v2/boards/…/resources/…`), or null. */
const RESOURCE_PATH =
  /^\/v2\/boards\/[A-Za-z0-9_=-]{6,64}\/resources\/(images|documents)\/[A-Za-z0-9_=-]{1,64}$/

export function resourcePath(raw, origin = MIRO_API) {
  try {
    const url = new URL(raw)
    if (url.origin !== origin) return null
    return RESOURCE_PATH.test(url.pathname) ? url.pathname : null
  } catch {
    return null
  }
}

/** The whole probe: `print` gets every line (already scrubbed); it returns the summary (ids and counts only). */
export async function runProbe({
  token,
  base,
  boards = 3,
  ids = [],
  mindmaps = false,
  names = false,
  print,
  fetchImpl,
}) {
  const say = (line) => print(scrub(line, token))
  const client = makeClient({ token, base, fetchImpl })
  const context = await client.get('/v1/oauth-token')
  say(`Team: ${context.team?.name ?? '(unknown)'}`)
  say(`Scopes: ${(context.scopes ?? []).join(', ') || '(none listed)'}`)
  const list = await client.get('/v2/boards?limit=50&sort=last_modified')
  const visible = list.data ?? []
  say(`Boards this token can see: ${list.total ?? visible.length}`)
  for (const b of visible.slice(0, 50)) say(`  ${b.id}  ${b.name ?? ''}  (modified ${b.modifiedAt ?? '?'})`)
  const chosen = ids.length ? ids : visible.slice(0, boards).map((b) => b.id)
  const results = []
  for (const id of chosen) {
    say(`Probing board ${id} …`)
    try {
      const r = await probeBoard(client, id, { mindmaps })
      results.push(names ? { ...r, name: visible.find((b) => b.id === id)?.name ?? null } : r)
      say(`  items ${r.items}: ${JSON.stringify(r.byType)}`)
      say(`  shapes: ${JSON.stringify(r.shapes)}; sticky shapes: ${JSON.stringify(r.stickyShapes)}`)
      const c = r.connectors
      say(`  connectors ${c.count}: ${JSON.stringify(c.shapes)}; caps ${JSON.stringify(c.caps)}`)
      say(`  groups ${r.groups}, tags ${r.tags}, frame children ${r.withParent}`)
      for (const [kind, f] of Object.entries(r.files))
        say(
          `  ${kind} download host: ${f.host ?? f.error} (params: ${(f.params ?? []).join(', ')}; ` +
            `expires in ${f.expiresInS ?? '?'} s)`,
        )
      if (r.mindmap) say(`  mind map: ${JSON.stringify(r.mindmap)}`)
    } catch (e) {
      results.push({ boardId: id, error: e.code ?? 'FAILED', status: e.status ?? null })
      say(`  failed: ${e.code ?? 'FAILED'}`)
    }
  }
  const hosts = [
    ...new Set(
      results.flatMap((r) =>
        Object.values(r.files ?? {})
          .map((f) => f.host)
          .filter(Boolean),
      ),
    ),
  ].sort()
  say(`Download hosts seen: ${hosts.join(', ') || '(none)'}`)
  say(`Rate limit: ${client.rate.remaining ?? '?'} of ${client.rate.limit ?? '?'} credits left this minute`)
  say('Done. Revoke the token in Miro now: Settings → Your apps → (your app) → uninstall.')
  return {
    probedAt: new Date().toISOString(),
    team: names ? (context.team?.name ?? null) : undefined,
    scopes: context.scopes ?? [],
    boardsVisible: list.total ?? visible.length,
    boards: results,
    downloadHosts: hosts,
    rateLimit: { ...client.rate },
  }
}

function parseArgs(argv) {
  const opts = { boards: 3, ids: [], mindmaps: false, names: false, json: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--boards') opts.boards = Math.max(1, Math.min(20, Number(argv[++i]) || 3))
    else if (a === '--board') opts.ids.push(String(argv[++i] ?? ''))
    else if (a === '--json') opts.json = String(argv[++i] ?? '')
    else if (a === '--mindmaps') opts.mindmaps = true
    else if (a === '--names') opts.names = true
    else if (a === '--token' || a.startsWith('--token='))
      throw new ProbeError('Give the token in MIRO_TOKEN or MIRO_TOKEN_FILE, never on the command line')
    else throw new ProbeError(`unknown option ${a}`)
  }
  if (opts.ids.some((id) => !/^[A-Za-z0-9_=-]{6,64}$/.test(id))) throw new ProbeError('BAD_BOARD_ID')
  return opts
}

function readToken(env) {
  const raw = env.MIRO_TOKEN ?? (env.MIRO_TOKEN_FILE ? readFileSync(env.MIRO_TOKEN_FILE, 'utf8') : '')
  const token = raw.trim()
  if (!/^[A-Za-z0-9._~+/=-]{16,4096}$/.test(token))
    throw new ProbeError('Set MIRO_TOKEN (or MIRO_TOKEN_FILE) to a Miro access token with boards:read')
  return token
}

async function main() {
  let token = ''
  try {
    const opts = parseArgs(process.argv.slice(2))
    token = readToken(process.env)
    const summary = await runProbe({ token, ...opts, print: (l) => console.log(l) })
    if (opts.json) {
      writeFileSync(opts.json, `${scrub(JSON.stringify(summary, null, 2), token)}\n`)
      console.log(`Wrote ${opts.json} (ids and counts only).`)
    }
  } catch (e) {
    console.error(scrub(`miro-probe: ${e instanceof ProbeError ? e.message : 'failed'}`, token))
    process.exitCode = 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
