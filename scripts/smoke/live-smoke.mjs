#!/usr/bin/env node
// Post-switch smoke checks for Lobby's live static site, api and sync (docs/EXCALIDRAW-CUTOVER.md C14-C17,
// B9 after a rollback). Read-only and secret-free: it GETs public pages and endpoints, POSTs one
// /api/auth/* route to see the signed-out 401, opens the invite page with a bogus token, and opens one
// unauthenticated board socket that the sync must refuse. It never signs in, creates data or calls an
// internal route.
//
//   node scripts/smoke/live-smoke.mjs --base https://draftroom-staging-web.onrender.com --expect excalidraw
//   node scripts/smoke/live-smoke.mjs --base https://draftroom-staging-web.onrender.com --expect r0
//
// --expect excalidraw: the cut-over build (the static site's headers and Content-Security-Policy exactly as
//   render.yaml sets them, /excalidraw-assets/, the Excalidraw engine markers, no foreign host but Clerk's).
// --expect r0: the bridge release R0 (tldraw; no CSP, runbook B5; tldraw's engine markers; the hosts the
//   R0 bundle is known to name).
// --api / --sync: the api and sync origins when they cannot be derived from --base (<name>-web.<domain>
//   -> <name>-api / <name>-sync). --json <file> writes every check as JSON for the cut-over log.
// --render-yaml <file>: the Blueprint the expected headers are read from (default: this checkout's
//   render.yaml, scripts/smoke/render-yaml.mjs). Its CSP is the one checked: enforced since 2026-10-03.
//
// Every check prints one PASS / FAIL / WARN / INFO line; the exit code is 1 when any check FAILED.

import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { connect as netConnect } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import {
  CSP,
  CSP_REPORT_ONLY,
  cspDifferences,
  expectedCsp,
  headerFor,
  parseCsp,
  staticSiteHeaders,
} from './render-yaml.mjs'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const FETCH_TIMEOUT_MS = 30_000
const SOCKET_TIMEOUT_MS = 20_000
const BROWSER_TIMEOUT_MS = 45_000

// ---- expectations -----------------------------------------------------------------------------------

/** Strict-Transport-Security: Render's edge sends it (not render.yaml); at least a year is expected. */
const HSTS_MIN_MAX_AGE = 31_536_000

/**
 * Engine markers, as the integration scripts grep built output for them
 * (docs/research/excalidraw/spike-b/scripts/integration-*.sh: a normal build carries none of the
 * Excalidraw markers, the engine build carries them). tldraw's markers are the editor's own CSS classes.
 */
const MARKERS = {
  excalidraw: {
    present: ['excalidraw__canvas', 'EXCALIDRAW_ASSET_PATH', 'Excalifont', 'excalidraw-assets'],
    absent: ['tl-container', 'tlui-'],
  },
  r0: {
    present: ['tl-container', 'tlui-', '@tldraw/'],
    absent: [
      'excalidraw__canvas',
      'EXCALIDRAW_ASSET_PATH',
      'Excalifont',
      'excalidraw-assets',
      '@excalidraw/',
    ],
  },
}

/**
 * Clerk's hosts: the frontend API (<instance>.clerk.accounts.dev), img.clerk.com and clerk-telemetry.com
 * (render.yaml's CSP), clerk.com's docs in @clerk/shared's messages, Clerk's own domain suffixes
 * (accounts.dev, accountsstage.dev, clerk.dev) and its bot protection (challenges.cloudflare.com, the
 * CSP's frame-src / script-src).
 */
const isClerkHost = (h) =>
  ['clerk.com', 'clerk.dev', 'accounts.dev', 'accountsstage.dev', 'clerkstage.dev'].some(
    (d) => h === d || h.endsWith(`.${d}`),
  ) ||
  h === 'clerk-telemetry.com' ||
  h === 'challenges.cloudflare.com'

/**
 * Hosts that are identifiers or sentinels, never requested: XML namespaces (the host-rewrite plugin's
 * NON_REQUEST_HOSTS), zod's $schema id, RFC 6761 .invalid names (Lobby's own `draftroom.invalid`, the
 * plugin's `blocked.invalid`).
 */
const isNonRequestHost = (h) => h === 'www.w3.org' || h === 'json-schema.org' || h.endsWith('.invalid')

/**
 * Documentation links inside error messages of libraries outside the engine tree (the host-rewrite plugin
 * rewrites only @excalidraw/excalidraw's dependency tree): React's error decoder, pdf.js's issue tracker,
 * the bundler runtime. Named, not requested.
 */
const DOC_LINK_HOSTS = new Set(['react.dev', 'github.com', 'rolldown.rs'])

/**
 * Google Identity Services, the open sign-in's "Continue with Google" (apps/web/src/auth/GoogleSignIn.tsx,
 * docs/OPEN-SIGNIN.md). The script loads only where GET /api/auth/config offers Google, so it is the auth
 * provider's host there and an unused name everywhere else. Section 5 checks which one this server is.
 */
const GOOGLE_SIGNIN_HOST = 'accounts.google.com'
/** Set by the bundle scan (section 4): the bundle names GOOGLE_SIGNIN_HOST. */
let bundleNamesGoogleSignIn = false

/**
 * The hosts the bridge release R0's bundle names besides the above, measured on staging on 2026-10-01
 * (main 380aa92 / r0 38d3833 lineage): tldraw's embed allowlist and URL builders (@tldraw/tlschema and
 * tldraw), its asset CDN and docs, ProseMirror's docs, RFC 2606's example.com. None is requested by Lobby
 * (the board fetches files same-origin; embeds are not offered). A host outside this list on an R0 build
 * is a change worth looking at.
 */
const R0_BUNDLE_HOSTS = new Set([
  'cdn.tldraw.com',
  'demo.tldraw.xyz',
  'tldraw.dev',
  'codepen.io',
  'codesandbox.io',
  'example.com',
  'gist.github.com',
  'player.vimeo.com',
  'prosemirror.net',
  'scratch.mit.edu',
  'support.google.com',
  'vimeo.com',
  'www.figma.com',
  'www.google.com',
  'www.val.town',
  'www.youtube.com',
])

// ---- arguments --------------------------------------------------------------------------------------

const { values: args } = parseArgs({
  options: {
    base: { type: 'string' },
    expect: { type: 'string' },
    api: { type: 'string' },
    sync: { type: 'string' },
    json: { type: 'string' },
    'render-yaml': { type: 'string' },
    help: { type: 'boolean', default: false },
  },
})

if (args.help || !args.base || !args.expect) {
  console.log(
    'usage: node scripts/smoke/live-smoke.mjs --base <web url> --expect excalidraw|r0 [--api <url>] [--sync <url>] [--json <file>]',
  )
  process.exit(args.help ? 0 : 2)
}
if (args.expect !== 'excalidraw' && args.expect !== 'r0') {
  console.error(`--expect must be excalidraw or r0, not ${JSON.stringify(args.expect)}`)
  process.exit(2)
}
const EXPECT = args.expect
const BASE = new URL(args.base)
// The site's origin plus any path prefix, never with a trailing slash (a URL object re-adds one to an
// empty pathname): every request below is `${base}/...`, and `base` is the Origin header the api and the
// sync compare with PUBLIC_ORIGIN / ALLOWED_ORIGINS.
const base = BASE.origin + BASE.pathname.replace(/\/+$/, '')

function sibling(kind) {
  const m = /^(.*)-web(\..+)$/.exec(BASE.hostname)
  if (!m) {
    console.error(`--${kind} is required: ${BASE.hostname} is not <name>-web.<domain>`)
    process.exit(2)
  }
  return `${BASE.protocol}//${m[1]}-${kind}${m[2]}${BASE.port ? `:${BASE.port}` : ''}`
}
const API = (args.api ?? sibling('api')).replace(/\/+$/, '')
const SYNC = (args.sync ?? sibling('sync')).replace(/\/+$/, '')
const OWN_HOSTS = new Set([BASE.hostname, new URL(API).hostname, new URL(SYNC).hostname])

// What render.yaml (the Blueprint) says the static site answers: never copied into this script, so the
// check follows the file (the CSP was report-only until 2026-10-03, then enforced).
const RENDER_YAML = args['render-yaml'] ?? `${REPO_ROOT}render.yaml`
let blueprint
try {
  blueprint = staticSiteHeaders(readFileSync(RENDER_YAML, 'utf8'))
} catch (e) {
  console.error(`cannot read ${RENDER_YAML}: ${e.message}`)
  process.exit(2)
}
const isCspName = (name) => [CSP, CSP_REPORT_ONLY].includes(name.toLowerCase())
/** render.yaml's static-site headers for /* (both builds), CSP aside: lower-case name -> value. */
const STATIC_HEADERS = Object.fromEntries(
  blueprint.filter((h) => h.path === '/*' && !isCspName(h.name)).map((h) => [h.name.toLowerCase(), h.value]),
)
/** render.yaml's Cache-Control for /assets/*. */
const ASSETS_CACHE_CONTROL = headerFor(blueprint, '/assets/*', 'cache-control')
/** render.yaml's CSP for /* ({ name, value }; null when it sets none). */
const EXPECTED_CSP = expectedCsp(blueprint)
if (Object.keys(STATIC_HEADERS).length === 0 || !ASSETS_CACHE_CONTROL) {
  console.error(`${RENDER_YAML}: no static-site headers found (is it the Blueprint?)`)
  process.exit(2)
}

// ---- reporting --------------------------------------------------------------------------------------

const results = []
const record = (status, name, detail) => {
  results.push({ status, name, detail })
  console.log(`${status.padEnd(5)} ${name}: ${detail}`)
}
const pass = (name, detail) => record('PASS', name, detail)
const fail = (name, detail) => record('FAIL', name, detail)
const warn = (name, detail) => record('WARN', name, detail)
const info = (name, detail) => record('INFO', name, detail)
const check = (ok, name, detail) => (ok ? pass(name, detail) : fail(name, detail))
const short = (s, n = 160) => (s.length > n ? `${s.slice(0, n)}…` : s)

// ---- http -------------------------------------------------------------------------------------------

/** GET/POST with a timeout; redirects are reported, not followed. Returns {status, type, headers, text}. */
async function http(url, init = {}) {
  const res = await fetch(url, {
    redirect: 'manual',
    ...init,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { 'user-agent': 'lobby-live-smoke', ...(init.headers ?? {}) },
  })
  const text = await res.text()
  return {
    status: res.status,
    type: (res.headers.get('content-type') ?? '').toLowerCase(),
    headers: res.headers,
    text,
  }
}
const isHtml = (r) => r.type.startsWith('text/html')
const isJs = (r) => /javascript|ecmascript/.test(r.type)
const isCss = (r) => r.type.startsWith('text/css')
const describe = (r) => `${r.status} ${r.type || '(no content-type)'}`

// ---- 1. the web serves, with its headers ----------------------------------------------------------------

/** The Content-Security-Policy header of GET /, or null (read again by the Clerk and browser checks). */
let cspHeader = null
let indexHtml = ''
try {
  const r = await http(`${base}/`)
  indexHtml = r.text
  check(r.status === 200 && isHtml(r), 'web index', `GET ${base}/ -> ${describe(r)}, ${r.text.length} bytes`)
  for (const [name, want] of Object.entries(STATIC_HEADERS)) {
    const got = r.headers.get(name)
    check(
      (got ?? '').trim().toLowerCase() === want.toLowerCase(),
      `header ${name}`,
      got === null ? `missing (render.yaml: ${want})` : `${got}`,
    )
  }
  const hsts = r.headers.get('strict-transport-security')
  const maxAge = Number(/max-age=(\d+)/i.exec(hsts ?? '')?.[1] ?? 0)
  ;(hsts !== null && maxAge >= HSTS_MIN_MAX_AGE ? pass : warn)(
    'header strict-transport-security',
    hsts === null
      ? "absent (Render's edge sends it on onrender.com; not in render.yaml)"
      : `${hsts}${maxAge < HSTS_MIN_MAX_AGE ? ` (max-age under ${HSTS_MIN_MAX_AGE})` : ''}`,
  )
  checkCsp(r.headers)
} catch (e) {
  fail('web index', `GET ${base}/ failed: ${e.message}`)
}

/** The Clerk frontend-API host, decoded from a publishable key (pk_test_<base64 "host$">). */
function clerkFrontendHost(publishableKey) {
  const m = /^pk_(?:test|live)_([A-Za-z0-9+/=]+)$/.exec(publishableKey ?? '')
  if (!m) return null
  try {
    return Buffer.from(m[1], 'base64').toString('utf8').replace(/\$$/, '')
  } catch {
    return null
  }
}

function checkCsp(headers) {
  const enforced = headers.get(CSP)
  const reportOnly = headers.get(CSP_REPORT_ONLY)
  if (EXPECT === 'r0') {
    const value = enforced
    cspHeader = value
    // Runbook B5: R0's web (its inline theme script, zod's eval probe, tldraw's data: fetch) is not built
    // for the CSP; a rollback removes the enforced header (a report-only one blocks nothing).
    check(
      value === null,
      'content-security-policy (R0)',
      value === null
        ? 'absent, as R0 needs (runbook B5)'
        : `present on an R0 build, which breaks under it (B5 removes it): ${short(value)}`,
    )
    return
  }
  if (!EXPECTED_CSP) {
    fail('content-security-policy', `${RENDER_YAML} sets no CSP for /* (the cut-over build needs one)`)
    return
  }
  const want = EXPECTED_CSP
  const value = headers.get(want.name)
  cspHeader = value
  if (value === null) {
    const other = want.name === CSP ? reportOnly : enforced
    fail(
      'content-security-policy',
      `${want.name} missing (render.yaml sets it for /*)${other !== null ? `; the live header is ${want.name === CSP ? CSP_REPORT_ONLY : CSP}: the Dashboard and render.yaml disagree (a Manual Sync would change it)` : ''}`,
    )
    return
  }
  const differences = cspDifferences(value, want.value)
  check(
    differences.length === 0,
    `${want.name} as in render.yaml`,
    differences.length === 0
      ? `the same policy (${parseCsp(value).size} directives)`
      : `${differences.length} difference(s): ${differences.join(' | ')}`,
  )
  if (want.name === CSP && reportOnly !== null)
    warn(CSP_REPORT_ONLY, `also sent next to the enforced header: ${short(reportOnly)}`)
  const d = parseCsp(value)
  const src = (name) => d.get(name) ?? null
  const has = (name, token) => (src(name) ?? []).some((s) => s.toLowerCase() === token.toLowerCase())
  check(src('default-src') !== null, 'csp default-src', src('default-src')?.join(' ') ?? 'missing')
  const script = src('script-src')
  check(
    script !== null && !has('script-src', "'unsafe-eval'") && !has('script-src', "'unsafe-inline'"),
    'csp script-src',
    script ? `${script.join(' ')} (no 'unsafe-eval', no 'unsafe-inline')` : 'missing',
  )
  check(has('object-src', "'none'"), 'csp object-src', src('object-src')?.join(' ') ?? 'missing')
  check(
    has('frame-ancestors', "'none'"),
    'csp frame-ancestors',
    src('frame-ancestors')?.join(' ') ?? 'missing',
  )
  check(has('base-uri', "'self'"), 'csp base-uri', src('base-uri')?.join(' ') ?? 'missing')
  check(src('font-src') !== null, 'csp font-src', src('font-src')?.join(' ') ?? 'missing')
  const syncHttps = SYNC
  const syncWss = SYNC.replace(/^http/, 'ws')
  const connect = src('connect-src') ?? []
  check(
    connect.includes(syncHttps) || connect.includes(syncWss),
    'csp connect-src names the sync origin',
    `${connect.join(' ')} (sync: ${syncWss})`,
  )
  // Wave H1: the page fetches the board event stream from the api's own origin (section 5b).
  check(
    connect.includes(API),
    'csp connect-src names the api origin',
    `${connect.join(' ')} (api: ${API}; without it the board event stream falls back to the rewrite and nothing arrives live)`,
  )
}

// ---- 2. the index loads its chunks --------------------------------------------------------------------

/** Chunk and stylesheet paths index.html names (script src, modulepreload, stylesheet). */
function indexAssets(html) {
  const out = []
  for (const m of html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)) out.push({ path: m[1], kind: 'js' })
  for (const m of html.matchAll(/<link[^>]*\srel="modulepreload"[^>]*\shref="([^"]+)"/g))
    out.push({ path: m[1], kind: 'js' })
  for (const m of html.matchAll(/<link[^>]*\srel="stylesheet"[^>]*\shref="([^"]+)"/g))
    out.push({ path: m[1], kind: 'css' })
  return out
}

const inlineScripts = [...indexHtml.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].filter(
  (m) => m[1].trim() !== '',
)
if (EXPECT === 'excalidraw') {
  // Runbook C14: `curl -s $W/ | grep -o '<script[^>]*>' | grep -vc 'src='` must print 0 (G3: the theme
  // script moved to a file; render.yaml's CSP has no hash).
  check(
    inlineScripts.length === 0,
    'index has no inline script',
    `${inlineScripts.length} inline <script> (the CSP has no hash for one)`,
  )
} else info('index inline scripts', `${inlineScripts.length} (R0's theme script; no CSP on R0)`)

/** path -> {status, type, text} for every fetched chunk (the transitive closure, for the scans below). */
const chunks = new Map()
const listed = indexAssets(indexHtml)
let chunkFailures = 0
for (const a of listed) {
  try {
    const r = await http(`${base}${a.path}`)
    chunks.set(a.path, r)
    const typeOk = a.kind === 'js' ? isJs(r) : isCss(r)
    // A missing file is NOT a 404 on this host: the SPA fallback answers 200 index.html, so the type matters.
    if (r.status !== 200 || !typeOk) {
      chunkFailures++
      fail(`chunk ${a.path}`, `${describe(r)}${isHtml(r) ? ' (the SPA fallback: the file is missing)' : ''}`)
    }
  } catch (e) {
    chunkFailures++
    fail(`chunk ${a.path}`, e.message)
  }
}
check(
  listed.length > 0 && chunkFailures === 0,
  'index chunks',
  `${listed.length} listed in index.html (${listed.filter((a) => a.kind === 'js').length} js, ${listed.filter((a) => a.kind === 'css').length} css), ${listed.length - chunkFailures} answered 200 with the right type`,
)
{
  const entry = listed.find((a) => a.kind === 'js' && a.path.startsWith('/assets/'))
  const r = entry ? chunks.get(entry.path) : null
  const cc = r?.headers.get('cache-control') ?? null
  check(
    cc !== null && cc.replace(/\s/g, '').toLowerCase() === ASSETS_CACHE_CONTROL.replace(/\s/g, ''),
    'header cache-control on /assets/*',
    cc ?? (entry ? 'missing' : 'no /assets/ entry chunk in index.html'),
  )
}

// The chunks reached from the entry (dynamic imports, Vite's preload lists): what the app can load later.
{
  const queue = [...chunks.keys()]
  const seen = new Set(queue)
  const re = /["'`](?:\.\/|\/assets\/)([A-Za-z0-9_.-]+\.(?:js|css))["'`]/g
  while (queue.length) {
    const p = queue.shift()
    const r = chunks.get(p)
    if (!r || !p.endsWith('.js')) continue
    for (const m of r.text.matchAll(re)) {
      const next = `/assets/${m[1]}`
      if (seen.has(next)) continue
      seen.add(next)
      try {
        const rr = await http(`${base}${next}`)
        chunks.set(next, rr)
        if (rr.status !== 200 || !(next.endsWith('.js') ? isJs(rr) : isCss(rr)))
          fail(`chunk ${next}`, describe(rr))
        else queue.push(next)
      } catch (e) {
        fail(`chunk ${next}`, e.message)
      }
    }
  }
  const js = [...chunks.keys()].filter((p) => p.endsWith('.js')).length
  info(
    'bundle closure',
    `${chunks.size} files fetched (${js} js, ${chunks.size - js} css), ${[...chunks.values()].reduce((n, r) => n + r.text.length, 0)} bytes`,
  )
}

// ---- 3. /excalidraw-assets/ (the cut-over build) ------------------------------------------------------

if (EXPECT === 'excalidraw') {
  const fontRe = /fonts\/[A-Za-z0-9]+\/[A-Za-z0-9_.-]+\.woff2/g
  const fonts = new Set()
  for (const [p, r] of chunks) if (p.endsWith('.js')) for (const m of r.text.matchAll(fontRe)) fonts.add(m[0])
  const known = [...fonts].find((f) => f.includes('/Excalifont/')) ?? [...fonts][0]
  if (!known) fail('excalidraw-assets font', 'no fonts/<Family>/<file>.woff2 reference in the bundle')
  else {
    try {
      const r = await http(`${base}/excalidraw-assets/${known}`)
      check(
        r.status === 200 && !isHtml(r),
        'excalidraw-assets font',
        `GET /excalidraw-assets/${known} -> ${describe(r)}, ${r.text.length} bytes${isHtml(r) ? ' (the SPA fallback, not the font)' : ''}`,
      )
    } catch (e) {
      fail('excalidraw-assets font', e.message)
    }
  }
  try {
    // Runbook P6 / C14: a missing file under the prefix is a 404, never index.html.
    const missing = '/excalidraw-assets/fonts/Nunito/not-there.woff2'
    const r = await http(`${base}${missing}`)
    check(
      r.status === 404,
      'excalidraw-assets missing path',
      `GET ${missing} -> ${describe(r)}${r.status === 200 && isHtml(r) ? ' (the SPA fallback answered; the /excalidraw-assets/* rewrite is missing or below /*)' : ''}`,
    )
  } catch (e) {
    fail('excalidraw-assets missing path', e.message)
  }
}

// ---- 4. foreign hosts in the bundle --------------------------------------------------------------------

// Hosts of absolute URLs (`https://host`, `wss://host`, `\/\/host` in a regex source) and of quoted
// protocol-relative URLs (`"//host/..."`): what a request can actually be sent to. Bare hostnames
// ("player.vimeo.com", the host-rewrite plugin's third rule) are not scanned here: in Lobby's own bundle
// they are indistinguishable from dotted identifiers (tldraw's "com.tldraw.page", i18n keys such as
// "geo-style.cloud"), and the plugin already fails the build on a bare host left in the engine's tree.
const LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?'
const HOST = `${LABEL}(?:\\\\?\\.${LABEL})+`
const URL_HOST_RE = new RegExp(`(?:https?|wss?):(?:\\\\?/){2}(${HOST})(?![A-Za-z0-9.-])`, 'gi')
const PROTOCOL_RELATIVE_RE = new RegExp(`["'\`]//(${HOST})(?=[/"'\`?#])`, 'gi')
const plainHost = (h) => h.replace(/\\/g, '').toLowerCase()

function classify(host) {
  if (OWN_HOSTS.has(host)) return 'own'
  if (isClerkHost(host)) return 'clerk'
  if (isNonRequestHost(host)) return 'non-request'
  if (DOC_LINK_HOSTS.has(host)) return 'doc-link'
  if (host === GOOGLE_SIGNIN_HOST) return 'google-signin'
  if (EXPECT === 'r0' && R0_BUNDLE_HOSTS.has(host)) return 'r0-known'
  return 'foreign'
}

{
  /** host -> { kinds, files } */
  const hosts = new Map()
  const add = (host, kind, file) => {
    const e = hosts.get(host) ?? { kinds: new Set(), files: new Set() }
    e.kinds.add(kind)
    e.files.add(file.replace(/^\/assets\//, ''))
    hosts.set(host, e)
  }
  for (const [p, r] of chunks) {
    for (const m of r.text.matchAll(URL_HOST_RE)) add(plainHost(m[1]), 'url', p)
    for (const m of r.text.matchAll(PROTOCOL_RELATIVE_RE)) add(plainHost(m[1]), 'protocol-relative', p)
  }
  const rows = [...hosts].map(([host, e]) => ({
    host,
    cls: classify(host),
    kinds: [...e.kinds],
    files: [...e.files],
  }))
  rows.sort((a, b) => a.host.localeCompare(b.host))
  for (const r of rows)
    info(
      `bundle host ${r.host}`,
      `${r.cls} [${r.kinds.join(',')}] in ${r.files.slice(0, 3).join(', ')}${r.files.length > 3 ? ` +${r.files.length - 3}` : ''}`,
    )
  bundleNamesGoogleSignIn = rows.some((r) => r.cls === 'google-signin')
  const foreign = rows.filter((r) => r.cls === 'foreign')
  const clerk = rows.filter((r) => r.cls === 'clerk').map((r) => r.host)
  // @tldraw/tlschema's embed definitions name codepen.io, www.youtube.com and the like, and tlschema stays
  // after the cut-over (packages/tldraw-import, runbook P2's licence check): a chunk that names the package
  // is pointed out, so the owner can tell that allowlist from a host something would request.
  const tlschemaChunks = new Set(
    [...chunks]
      .filter(([, r]) => r.text.includes('@tldraw/tlschema'))
      .map(([p]) => p.replace(/^\/assets\//, '')),
  )
  const where = (r) =>
    `${r.files[0]}${tlschemaChunks.has(r.files[0]) ? ', a chunk naming @tldraw/tlschema: its embed allowlist' : ''}`
  check(
    foreign.length === 0,
    'bundle foreign hosts',
    foreign.length === 0
      ? `none but Clerk's (${clerk.join(', ') || 'no Clerk host named'}) and ${rows.length - clerk.length} own/identifier${EXPECT === 'r0' ? '/R0-known' : ''} host(s)`
      : `${foreign.length} host(s) not Lobby's, Clerk's${EXPECT === 'r0' ? ", R0's known" : ''} or an identifier: ${foreign.map((r) => `${r.host} (${where(r)})`).join('; ')}`,
  )
}

// ---- 5. api and sync -----------------------------------------------------------------------------------

async function expectJson401(name, url, init) {
  try {
    const r = await http(url, init)
    let code = null
    try {
      code = JSON.parse(r.text)?.error?.code ?? null
    } catch {}
    check(
      r.status === 401,
      name,
      `${init?.method ?? 'GET'} ${url} -> ${r.status} ${code ?? short(r.text, 80)}`,
    )
  } catch (e) {
    fail(name, `${url}: ${e.message}`)
  }
}
await expectJson401('/api/me signed out (through the web origin)', `${base}/api/me`)
await expectJson401('/api/me signed out (api origin)', `${API}/api/me`)
// The api's CSRF rule answers a cross-origin mutation 403 before auth; the web origin is the real one.
await expectJson401('POST /api/auth/sessions/revoke-all signed out', `${base}/api/auth/sessions/revoke-all`, {
  method: 'POST',
  headers: { origin: base, 'content-type': 'application/json' },
})
for (const [name, url] of [
  ['api /healthz', `${API}/healthz`],
  ['sync /healthz', `${SYNC}/healthz`],
]) {
  try {
    const r = await http(url)
    check(r.status === 200, name, `GET ${url} -> ${r.status} ${short(r.text.trim(), 40)}`)
  } catch (e) {
    fail(name, `${url}: ${e.message}`)
  }
}
let clerkFapi = null
try {
  const r = await http(`${base}/api/auth/config`)
  const cfg = JSON.parse(r.text)
  clerkFapi = clerkFrontendHost(cfg.clerkPublishableKey)
  check(
    r.status === 200 && Array.isArray(cfg.providers),
    '/api/auth/config',
    `${r.status} providers=${JSON.stringify(cfg.providers)}${clerkFapi ? ` clerk frontend api=${clerkFapi}` : ''}`,
  )
  if (EXPECT === 'excalidraw' && cspHeader && clerkFapi) {
    const d = parseCsp(cspHeader)
    const named = (d.get('script-src') ?? []).some((s) => s.toLowerCase().includes(clerkFapi.toLowerCase()))
    check(
      named,
      'csp script-src names the Clerk frontend api',
      `${clerkFapi} (runbook P5: corrected from a real sign-in)`,
    )
  }
  if (bundleNamesGoogleSignIn) {
    // The bundle's Google host is requested only when this server offers Google sign-in; then the page's
    // CSP must allow it (the theater's nginx.conf does). Anywhere else it must stay an unused name.
    const offersGoogle =
      Boolean(cfg.googleClientId) && (cfg.openSigninMethods ?? ['email']).includes('google')
    const cspAllows = (dir) =>
      (parseCsp(cspHeader ?? '').get(dir) ?? []).some((s) => s.toLowerCase().includes(GOOGLE_SIGNIN_HOST))
    if (offersGoogle)
      check(
        cspHeader !== null && cspAllows('script-src'),
        'bundle Google sign-in host',
        `${GOOGLE_SIGNIN_HOST}: this server offers Google sign-in; the CSP's script-src ${cspAllows('script-src') ? 'allows' : 'does NOT allow'} it`,
      )
    else
      check(
        true,
        'bundle Google sign-in host',
        `${GOOGLE_SIGNIN_HOST} is named by the open sign-in's Google button only; this server offers no Google sign-in (providers=${JSON.stringify(cfg.providers)}), so it is never requested`,
      )
  }
} catch (e) {
  fail('/api/auth/config', e.message)
}

// ---- 5b. the board event stream reaches the browser live (wave H1) -------------------------------------

/**
 * GET a stream and time it: when the headers came, when the first body byte came, when it ended. The api's
 * /api/diag/stream writes a 2 KB comment at once, then three ticks a second apart, then ends: a proxy that
 * passes a stream through as it is written shows the first byte at once; one that holds the response until
 * it ends (Render's static-site rewrite, measured 2026-10-05) shows it at the end, about 3 s in.
 */
async function timeStream(url) {
  const t0 = performance.now()
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { 'user-agent': 'lobby-live-smoke', accept: 'text/event-stream' },
  })
  const headersMs = performance.now() - t0
  let firstByteMs = null
  let bytes = 0
  const reader = res.body?.getReader()
  if (reader)
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      if (firstByteMs === null && value.length) firstByteMs = performance.now() - t0
      bytes += value.length
    }
  return {
    status: res.status,
    type: res.headers.get('content-type') ?? '',
    headersMs,
    firstByteMs,
    totalMs: performance.now() - t0,
    bytes,
  }
}
const ms = (v) => (v === null ? 'never' : `${(v / 1000).toFixed(2)} s`)
/** The direct stream must start well inside this; through a buffering proxy it starts at the end (~3 s). */
const DIRECT_FIRST_BYTE_MS = 1_000

if (EXPECT === 'excalidraw') {
  try {
    const r = await timeStream(`${API}/api/diag/stream`)
    check(
      r.status === 200 && r.firstByteMs !== null && r.firstByteMs < DIRECT_FIRST_BYTE_MS,
      'event stream live from the api origin',
      `GET ${API}/api/diag/stream -> ${r.status} ${r.type || '(no content-type)'}: first byte ${ms(r.firstByteMs)}, total ${ms(r.totalMs)}, ${r.bytes} bytes (first byte must be < ${DIRECT_FIRST_BYTE_MS / 1000} s)`,
    )
  } catch (e) {
    fail('event stream live from the api origin', `${API}/api/diag/stream: ${e.message}`)
  }
  try {
    // Informational: what a page that still used the rewrite would get (the reason for the direct origin).
    const r = await timeStream(`${base}/api/diag/stream`)
    info(
      'event stream through the web origin',
      `GET ${base}/api/diag/stream -> ${r.status}: first byte ${ms(r.firstByteMs)}, total ${ms(r.totalMs)}${r.firstByteMs !== null && r.totalMs - r.firstByteMs < 500 ? ' (held until the end: the rewrite buffers; pages use the api origin)' : ''}`,
    )
  } catch (e) {
    info('event stream through the web origin', `${base}/api/diag/stream: ${e.message}`)
  }
  // The page mints its ticket through the web origin with the session cookie; without one: 401.
  await expectJson401(
    'POST /api/boards/:bid/events/ticket signed out',
    `${base}/api/boards/b-live-smoke/events/ticket`,
    { method: 'POST', headers: { origin: base } },
  )
  // The api answers the page's CORS preflight for the ticketed stream (only when DRAFTROOM_EVENTS_ORIGIN
  // is set), and refuses a made-up ticket with a 401 the page can read.
  try {
    const res = await fetch(`${API}/api/boards/b-live-smoke/events`, {
      method: 'OPTIONS',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        'user-agent': 'lobby-live-smoke',
        origin: base,
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization',
      },
    })
    const allow = res.headers.get('access-control-allow-origin')
    const headers = (res.headers.get('access-control-allow-headers') ?? '').toLowerCase()
    check(
      res.status === 204 &&
        allow === base &&
        headers.split(/\s*,\s*/).includes('authorization') &&
        !res.headers.get('access-control-allow-credentials'),
      'event stream CORS preflight (api origin)',
      `OPTIONS ${API}/api/boards/<board>/events from ${base} -> ${res.status}, allow-origin ${allow ?? '(none: DRAFTROOM_EVENTS_ORIGIN is not set on the api)'}, allow-headers ${headers || '(none)'}`,
    )
  } catch (e) {
    fail('event stream CORS preflight (api origin)', e.message)
  }
  try {
    const bogus = `evt_${randomBytes(32).toString('base64url')}`
    const res = await fetch(`${API}/api/boards/b-live-smoke/events`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'user-agent': 'lobby-live-smoke', origin: base, authorization: `Bearer ${bogus}` },
    })
    const text = await res.text()
    let code = null
    try {
      code = JSON.parse(text)?.error?.code ?? null
    } catch {}
    check(
      res.status === 401 && res.headers.get('access-control-allow-origin') === base,
      'event stream refuses a made-up ticket (api origin)',
      `GET ${API}/api/boards/<board>/events with a made-up ticket -> ${res.status} ${code ?? short(text, 60)}, allow-origin ${res.headers.get('access-control-allow-origin') ?? '(none)'}`,
    )
  } catch (e) {
    fail('event stream refuses a made-up ticket (api origin)', e.message)
  }
} else
  info('event stream (direct)', 'not checked on R0 (its pages use the cookie stream through the rewrite)')

// ---- 6. the invite page ------------------------------------------------------------------------------

{
  const token = `smoke-not-a-token-${randomBytes(6).toString('hex')}`
  try {
    const r = await http(`${base}/invite/${token}`)
    check(r.status === 200 && isHtml(r), 'invite page', `GET /invite/<bogus> -> ${describe(r)} (the SPA)`)
  } catch (e) {
    fail('invite page', e.message)
  }
  try {
    const r = await http(`${base}/api/invitations/${token}`)
    let code = null
    try {
      code = JSON.parse(r.text)?.error?.code ?? null
    } catch {}
    check(
      r.status === 404,
      'invite preview with a bogus token',
      `GET /api/invitations/<bogus> -> ${r.status} ${code ?? short(r.text, 60)}`,
    )
  } catch (e) {
    fail('invite preview with a bogus token', e.message)
  }
}

// ---- 7. engine markers -------------------------------------------------------------------------------

{
  const want = MARKERS[EXPECT]
  const filesWith = (marker) =>
    [...chunks].filter(([, r]) => r.text.includes(marker)).map(([p]) => p.replace(/^\/assets\//, ''))
  const missing = want.present.filter((m) => filesWith(m).length === 0)
  const leftover = want.absent.map((m) => [m, filesWith(m)]).filter(([, f]) => f.length > 0)
  check(
    missing.length === 0,
    `engine markers (${EXPECT}) present`,
    missing.length === 0
      ? want.present.map((m) => `${m} in ${filesWith(m).length} file(s)`).join('; ')
      : `missing: ${missing.join(', ')} (present: ${want.present.filter((m) => !missing.includes(m)).join(', ') || 'none'})`,
  )
  check(
    leftover.length === 0,
    `engine markers (${EXPECT === 'excalidraw' ? 'tldraw' : 'excalidraw'}) absent`,
    leftover.length === 0
      ? `none of ${want.absent.join(', ')}`
      : leftover
          .map(([m, f]) => `${m} in ${f.slice(0, 3).join(', ')}${f.length > 3 ? ` +${f.length - 3}` : ''}`)
          .join('; '),
  )
}

// ---- 8. headless Chromium on the sign-in page -------------------------------------------------------------

/** The e2e package's Playwright (@playwright/test re-exports playwright's `chromium`); a CommonJS entry. */
async function loadPlaywright() {
  const req = createRequire(new URL('e2e/package.json', pathToFileURL(REPO_ROOT)))
  const entry = req.resolve('@playwright/test')
  const mod = await import(pathToFileURL(entry))
  return mod.default ?? mod
}

const allowedPageHost = (h) => OWN_HOSTS.has(h) || isClerkHost(h) || (clerkFapi !== null && h === clerkFapi)

await (async () => {
  let browser = null
  try {
    const { chromium } = await loadPlaywright()
    browser = await chromium.launch({ headless: true })
  } catch (e) {
    fail('headless sign-in page', `Chromium did not start: ${short(e.message, 200)} (pnpm e2e:install)`)
    return
  }
  const consoleErrors = []
  const cspConsole = []
  const pageErrors = []
  const requestHosts = new Map()
  const failedRequests = []
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
    await context.addInitScript(() => {
      const list = []
      Object.defineProperty(window, '__lobbySmokeCsp', { value: list })
      document.addEventListener('securitypolicyviolation', (e) => {
        list.push({
          directive: e.effectiveDirective,
          blocked: e.blockedURI,
          source: `${e.sourceFile ?? ''}:${e.lineNumber ?? 0}`,
          disposition: e.disposition,
          sample: (e.sample ?? '').slice(0, 80),
        })
      })
    })
    const page = await context.newPage()
    page.on('console', (m) => {
      const text = m.text()
      if (/content.security.policy|refused to (load|execute|connect|apply|frame)/i.test(text))
        cspConsole.push(text)
      if (m.type() === 'error') consoleErrors.push(text)
    })
    page.on('pageerror', (e) => pageErrors.push(String(e)))
    page.on('request', (r) => {
      let host
      try {
        const u = new URL(r.url())
        if (['data:', 'blob:', 'about:'].includes(u.protocol)) return
        host = u.hostname
      } catch {
        return
      }
      requestHosts.set(host, (requestHosts.get(host) ?? 0) + 1)
    })
    page.on('requestfailed', (r) => failedRequests.push(`${r.url()} (${r.failure()?.errorText ?? 'failed'})`))

    const t0 = Date.now()
    const response = await page.goto(`${base}/signin`, { waitUntil: 'load', timeout: BROWSER_TIMEOUT_MS })
    const status = response?.status() ?? 0
    await page.waitForSelector('[data-testid="signin-page"]', { timeout: BROWSER_TIMEOUT_MS })
    // Clerk's hosted form (cl-*), the dev provider's heading, or the unreachable / unconfigured cards.
    const formSel = '.cl-rootBox, .cl-signIn-root, [data-testid="signin-heading"], .dr-signin__card h1'
    let formReady = true
    try {
      await page.waitForSelector(formSel, { timeout: BROWSER_TIMEOUT_MS })
    } catch {
      formReady = false
    }
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
    await page.waitForTimeout(1500)
    const title = await page.title()
    const heading = formReady
      ? await page
          .locator(formSel)
          .first()
          .innerText()
          .catch(() => '')
      : ''
    const unreachable = await page.locator('[data-testid="api-unreachable"]').count()
    const violations = await page.evaluate(() => window.__lobbySmokeCsp ?? [])
    const hosts = [...requestHosts].sort((a, b) => b[1] - a[1])

    check(
      status === 200 && formReady && unreachable === 0,
      'headless sign-in page renders',
      `${base}/signin -> ${status} in ${Date.now() - t0} ms, title ${JSON.stringify(title)}, ${formReady ? `form ${JSON.stringify(short(heading.replace(/\s+/g, ' ').trim(), 60))}` : 'no sign-in form within the timeout'}${unreachable ? ', "Can\'t reach Lobby" shown' : ''}`,
    )
    check(
      violations.length === 0 && cspConsole.length === 0,
      'headless sign-in page CSP violations',
      violations.length === 0 && cspConsole.length === 0
        ? `0 (${cspHeader ? 'header enforced' : 'no CSP header on this build'})`
        : `${violations.length} event(s), ${cspConsole.length} console line(s): ${[
            ...violations.map((v) => `${v.directive} blocked ${v.blocked} at ${v.source}`),
            ...cspConsole,
          ]
            .slice(0, 4)
            .map((s) => short(s, 160))
            .join(' | ')}`,
    )
    check(
      consoleErrors.length === 0 && pageErrors.length === 0,
      'headless sign-in page console errors',
      consoleErrors.length === 0 && pageErrors.length === 0
        ? '0 console errors, 0 page errors'
        : `${consoleErrors.length} console error(s), ${pageErrors.length} page error(s): ${[
            ...pageErrors,
            ...consoleErrors,
          ]
            .slice(0, 4)
            .map((s) => short(s, 160))
            .join(' | ')}`,
    )
    const strangers = hosts.filter(([h]) => !allowedPageHost(h))
    check(
      strangers.length === 0,
      'headless sign-in page requests',
      `${hosts.map(([h, n]) => `${h} (${n})`).join(', ')}${strangers.length ? ` ; not Lobby's or Clerk's: ${strangers.map(([h]) => h).join(', ')}` : ''}`,
    )
    if (failedRequests.length)
      info(
        'headless sign-in page failed requests',
        failedRequests
          .slice(0, 5)
          .map((s) => short(s, 120))
          .join(' | '),
      )
    await context.close()
  } catch (e) {
    fail('headless sign-in page renders', short(e.message, 300))
  } finally {
    await browser.close().catch(() => {})
  }
})()

// ---- 9. the board socket: refused for want of a ticket, not for maintenance ----------------------------------

/**
 * One unauthenticated WebSocket upgrade to the sync, with the web origin as Origin (ALLOWED_ORIGINS is
 * checked before the upgrade). The sync accepts the upgrade and closes at once with 4099 and a reason:
 * NOT_AUTHENTICATED for a missing ticket, MAINTENANCE while boards are closed. Written on the raw socket
 * so the status line and the close frame are seen as sent (no client library's interpretation).
 */
function probeSocket(url) {
  return new Promise((resolve) => {
    const u = new URL(url)
    const secure = u.protocol === 'wss:' || u.protocol === 'https:'
    const port = Number(u.port || (secure ? 443 : 80))
    const key = randomBytes(16).toString('base64')
    const out = { status: null, frames: [], error: null, closeCode: null, closeReason: null, timedOut: false }
    let buf = Buffer.alloc(0)
    let headDone = false
    const finish = () => {
      clearTimeout(timer)
      sock.destroy()
      resolve(out)
    }
    const timer = setTimeout(() => {
      out.timedOut = true
      finish()
    }, SOCKET_TIMEOUT_MS)
    const onConnect = () => {
      sock.write(
        `GET ${u.pathname}${u.search} HTTP/1.1\r\nHost: ${u.host}\r\nOrigin: ${base}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nUser-Agent: lobby-live-smoke\r\n\r\n`,
      )
    }
    const sock = secure
      ? tlsConnect({ host: u.hostname, port, servername: u.hostname }, onConnect)
      : netConnect({ host: u.hostname, port }, onConnect)
    sock.on('error', (e) => {
      out.error = e.message
      finish()
    })
    sock.on('close', () => finish())
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d])
      if (!headDone) {
        const i = buf.indexOf('\r\n\r\n')
        if (i < 0) return
        const head = buf.subarray(0, i).toString('latin1')
        out.status = Number(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1] ?? 0)
        buf = buf.subarray(i + 4)
        headDone = true
        if (out.status !== 101) return finish()
      }
      // Server frames are unmasked: opcode, 7-bit length (126 -> 2 bytes, 127 -> 8 bytes), payload.
      while (buf.length >= 2) {
        const opcode = buf[0] & 0x0f
        let len = buf[1] & 0x7f
        let off = 2
        if (len === 126) {
          if (buf.length < 4) return
          len = buf.readUInt16BE(2)
          off = 4
        } else if (len === 127) {
          if (buf.length < 10) return
          len = Number(buf.readBigUInt64BE(2))
          off = 10
        }
        if (buf.length < off + len) return
        const payload = buf.subarray(off, off + len)
        buf = buf.subarray(off + len)
        out.frames.push({ opcode, len })
        if (opcode === 8) {
          if (len >= 2) {
            out.closeCode = payload.readUInt16BE(0)
            out.closeReason = payload.subarray(2).toString('utf8')
          }
          // Answer the close (client frames are masked), then end.
          const mask = randomBytes(4)
          sock.write(Buffer.concat([Buffer.from([0x88, 0x80]), mask]))
          return finish()
        }
      }
    })
  })
}

{
  const url = `${SYNC.replace(/^http/, 'ws')}/connect/b-live-smoke?sessionId=live-smoke-${randomBytes(4).toString('hex')}`
  const r = await probeSocket(url)
  const where = `${url.replace(/\?.*$/, '')} (Origin ${base})`
  if (r.error) fail('sync socket', `${where}: ${r.error}`)
  else if (r.status !== 101)
    fail(
      'sync socket',
      `${where}: HTTP ${r.status ?? '(no response)'} instead of 101${r.status === 403 ? ' (ALLOWED_ORIGINS does not list the web origin)' : ''}`,
    )
  else if (r.timedOut && r.frames.length === 0)
    fail(
      'sync socket',
      `${where}: upgraded, then no close frame within ${SOCKET_TIMEOUT_MS} ms (an unauthenticated socket was not refused)`,
    )
  else if (r.closeReason === 'MAINTENANCE')
    fail(
      'sync socket',
      `${where}: refused with ${r.closeCode} MAINTENANCE (maintenance is ON: runbook C16 / F9)`,
    )
  else if (r.closeCode !== null && r.closeReason)
    pass(
      'sync socket',
      `${where}: upgraded, refused with ${r.closeCode} ${r.closeReason} (an auth close, not MAINTENANCE)`,
    )
  else
    warn(
      'sync socket',
      `${where}: upgraded, closed with an empty close frame (no code, no reason; the edge in front of the sync hides it): the refusal happened, but MAINTENANCE cannot be told from NOT_AUTHENTICATED from outside. The authoritative check is the runbook's \`int GET /internal/maintenance\` in the sync Shell.`,
    )
}

// ---- summary -----------------------------------------------------------------------------------------------

const count = (s) => results.filter((r) => r.status === s).length
const failed = count('FAIL')
console.log(
  `\n${failed === 0 ? 'OK' : 'FAILED'}: ${count('PASS')} passed, ${failed} failed, ${count('WARN')} warning(s), ${count('INFO')} info; --expect ${EXPECT}; base ${base}; api ${API}; sync ${SYNC}; ${new Date().toISOString()}`,
)
if (args.json) {
  writeFileSync(
    args.json,
    `${JSON.stringify({ at: new Date().toISOString(), base, api: API, sync: SYNC, expect: EXPECT, ok: failed === 0, results }, null, 2)}\n`,
  )
  console.log(`written ${args.json}`)
}
process.exit(failed === 0 ? 0 : 1)
