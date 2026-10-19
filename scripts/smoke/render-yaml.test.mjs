// node --test scripts/smoke/render-yaml.test.mjs
// The smoke script's expectations come from render.yaml (render-yaml.mjs): this reads the real Blueprint
// and a few hand-written ones, and compares policies the way the live check does. No network.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  CSP,
  CSP_REPORT_ONLY,
  cspDifferences,
  expectedCsp,
  headerFor,
  staticSiteHeaders,
} from './render-yaml.mjs'

const RENDER_YAML = readFileSync(fileURLToPath(new URL('../../render.yaml', import.meta.url)), 'utf8')

test("render.yaml: the static site's headers, the enforced CSP on one line", () => {
  const headers = staticSiteHeaders(RENDER_YAML)
  assert.equal(headerFor(headers, '/*', 'x-content-type-options'), 'nosniff')
  assert.equal(headerFor(headers, '/*', 'X-Frame-Options'), 'DENY')
  assert.equal(headerFor(headers, '/*', 'Referrer-Policy'), 'strict-origin-when-cross-origin')
  assert.equal(headerFor(headers, '/assets/*', 'Cache-Control'), 'public, max-age=31536000, immutable')
  // K1-6 (wave K): the self-hosted fonts, a week
  assert.equal(headerFor(headers, '/excalidraw-assets/*', 'Cache-Control'), 'public, max-age=604800')
  // wave Q: the icons' hashed index and shards, a year; their fixed-name LICENSES.txt, a day
  assert.equal(headerFor(headers, '/lobby-assets/*', 'Cache-Control'), 'public, max-age=31536000, immutable')
  assert.equal(
    headerFor(headers, '/lobby-assets/icons/LICENSES.txt', 'Cache-Control'),
    'public, max-age=86400',
  )
  // wave M (S2, M3-5): the build's version file is never cached (open tabs compare it with their own commit)
  assert.equal(headerFor(headers, '/version.json', 'Cache-Control'), 'no-store')
  const csp = expectedCsp(headers)
  assert.ok(csp, 'render.yaml sets a CSP for /*')
  assert.equal(csp.name, CSP, 'enforced, not report-only')
  assert.ok(!csp.value.includes('\n'))
  assert.match(csp.value, /^default-src 'self'; script-src 'self' /)
  assert.match(csp.value, /connect-src 'self' blob: /)
  assert.match(csp.value, /frame-ancestors 'none'$/)
  assert.deepEqual(cspDifferences(csp.value, csp.value), [])
  // Only the static site's own headers: nothing from another service.
  assert.ok(
    headers.every((h) =>
      [
        '/*',
        '/assets/*',
        '/excalidraw-assets/*',
        '/lobby-assets/*',
        '/lobby-assets/icons/LICENSES.txt',
        '/version.json',
      ].includes(h.path),
    ),
    JSON.stringify(headers),
  )
})

/** The static site's rewrite rules in order: [source, destination]. */
function staticRewrites(yaml) {
  const lines = yaml.replace(/\r\n?/g, '\n').split('\n')
  const start = lines.findIndex((l) => l.trimEnd() === '    name: draftroom-staging-web')
  const out = []
  let inRoutes = false
  for (let i = start + 1; i < lines.length && !/^ {2}- type:/.test(lines[i]); i++) {
    if (/^ {4}[a-zA-Z]/.test(lines[i])) inRoutes = lines[i].trim() === 'routes:'
    if (!inRoutes || lines[i].trim() !== '- type: rewrite') continue
    const source = /^\s*source:\s*(\S+)/.exec(lines[i + 1] ?? '')?.[1]
    const destination = /^\s*destination:\s*(\S+)/.exec(lines[i + 2] ?? '')?.[1]
    out.push([source, destination])
  }
  return out
}

test("render.yaml: the static site's asset prefixes go to the api (its 404) before the SPA fallback", () => {
  const rewrites = staticRewrites(RENDER_YAML)
  const at = (source) => rewrites.findIndex(([s]) => s === source)
  const spa = at('/*')
  assert.ok(spa >= 0, JSON.stringify(rewrites))
  assert.equal(rewrites[spa][1], '/index.html')
  assert.equal(spa, rewrites.length - 1, 'the SPA fallback is the last rule')
  for (const prefix of ['/excalidraw-assets', '/lobby-assets']) {
    const i = at(`${prefix}/*`)
    assert.ok(i >= 0 && i < spa, `${prefix}/* is rewritten before the SPA fallback`)
    assert.equal(rewrites[i][1], `https://draftroom-staging-api.onrender.com${prefix}/*`)
  }
})

test('a live policy is compared directive by directive (order and case do not matter)', () => {
  const { value } = expectedCsp(staticSiteHeaders(RENDER_YAML))
  const reordered = value
    .split(';')
    .map((p) => p.trim())
    .reverse()
    .map((p) => p.replace(/^[a-z-]+/, (d) => d.toUpperCase()))
    .join('; ')
  assert.deepEqual(cspDifferences(reordered, value), [])
  const noBlob = value.replace("connect-src 'self' blob: ", "connect-src 'self' ")
  assert.deepEqual(cspDifferences(noBlob, value), ['connect-src: lacks blob:'])
  const evalToo = value.replace("script-src 'self'", "script-src 'self' 'unsafe-eval'")
  assert.deepEqual(cspDifferences(evalToo, value), ["script-src: adds 'unsafe-eval'"])
  const noFonts = value.replace(/font-src 'self';\s*/, '')
  assert.deepEqual(cspDifferences(`${noFonts}; report-uri /csp`, value), [
    "font-src missing (render.yaml: 'self')",
    'report-uri not in render.yaml',
  ])
})

test('other shapes: quoted and literal values, report-only, list items at the key, comments; only the static service', () => {
  const yaml = [
    'services:',
    '  - type: web',
    '    runtime: node',
    '    name: api',
    '    headers:',
    '      - path: /*',
    '        name: X-Api-Only',
    '        value: nope',
    '  - type: web',
    '    runtime: static # the SPA',
    '    name: web',
    '    buildCommand: >-',
    '      pnpm install &&',
    '      pnpm build',
    '    headers:',
    '    # a comment before the first entry',
    '    - path: /*',
    '      name: Content-Security-Policy-Report-Only',
    '      value: |-',
    "        default-src 'self';",
    "        object-src 'none'",
    '    - path: "/*"',
    '      name: Referrer-Policy',
    "      value: 'no-referrer' # trailing comment",
    '    envVars:',
    '      - key: A',
    '        value: b',
  ].join('\n')
  const headers = staticSiteHeaders(yaml)
  assert.deepEqual(headers, [
    {
      path: '/*',
      name: 'Content-Security-Policy-Report-Only',
      value: "default-src 'self';\nobject-src 'none'",
    },
    { path: '/*', name: 'Referrer-Policy', value: 'no-referrer' },
  ])
  assert.deepEqual(expectedCsp(headers), {
    name: CSP_REPORT_ONLY,
    value: "default-src 'self';\nobject-src 'none'",
  })
  assert.deepEqual(cspDifferences("object-src 'none'; default-src 'self'", expectedCsp(headers).value), [])
  assert.deepEqual(staticSiteHeaders('services:\n  - type: web\n    runtime: static\n    name: web\n'), [])
})

/** The plain `value:` of env key `key` in the service named `service` (a text read, like the reader above). */
function envValue(yaml, service, key) {
  const lines = yaml.replace(/\r\n?/g, '\n').split('\n')
  // the service itself (indent 4), not a fromService reference to it inside another service
  const start = lines.findIndex((l) => l.trimEnd() === `    name: ${service}`)
  if (start < 0) return null
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}- type:/.test(lines[i])) return null // the next service
    if (lines[i].trim() !== `- key: ${key}`) continue
    const v = /^\s*value:\s*(.*?)\s*(#.*)?$/.exec(lines[i + 1] ?? '')
    return v ? v[1].replace(/^"(.*)"$/, '$1') : null
  }
  return null
}

test('render.yaml: the wave M keys (the lead applies them through the Render API before each deploy)', () => {
  const api = (k) => envValue(RENDER_YAML, 'draftroom-staging-api', k)
  const sync = (k) => envValue(RENDER_YAML, 'draftroom-staging-sync', k)
  const web = (k) => envValue(RENDER_YAML, 'draftroom-staging-web', k)
  assert.equal(api('DRAFTROOM_DB_POOL_MAX'), '5')
  assert.equal(api('DRAFTROOM_WORKSPACE_QUOTA_MB'), '5120')
  assert.equal(sync('DRAFTROOM_WS_DEFLATE'), 'off')
  assert.equal(sync('DRAFTROOM_BACKUP_KEEP'), '4')
  assert.equal(sync('DRAFTROOM_OUTBOUND_BUDGET_MB'), '64')
  assert.equal(web('VITE_PUBLIC_ORIGIN'), 'https://draftroom-staging-web.onrender.com')
  // unchanged by wave M
  assert.equal(sync('ACCESS_RECHECK_MS'), '10000')
  // each in its own service only
  assert.equal(sync('DRAFTROOM_DB_POOL_MAX'), null)
  assert.equal(api('DRAFTROOM_WS_DEFLATE'), null)
})

test('render.yaml: the wave N keys (the lead applies them through the Render API before each deploy)', () => {
  const api = (k) => envValue(RENDER_YAML, 'draftroom-staging-api', k)
  const sync = (k) => envValue(RENDER_YAML, 'draftroom-staging-sync', k)
  assert.equal(api('DRAFTROOM_AI_VISION'), 'on')
  assert.equal(api('DRAFTROOM_AI_VISION_USER_DAILY'), '10')
  assert.equal(api('DRAFTROOM_AI_VISION_GLOBAL_DAILY'), '150')
  assert.equal(api('DRAFTROOM_AI_TRANSCRIPT_MAX_CHARS'), '60000')
  assert.equal(api('DRAFTROOM_AI_TRANSCRIPT_USER_DAILY'), '10')
  assert.equal(api('DRAFTROOM_AI_VISION_TIMEOUT_MS'), '60000')
  assert.equal(api('DRAFTROOM_VISITS_RETENTION_DAYS'), '180')
  // the vision model stays OPENAI_MODEL's (no key)
  assert.equal(api('DRAFTROOM_AI_VISION_MODEL'), null)
  assert.equal(sync('DRAFTROOM_REACTIONS'), 'on')
  // the wave M hold stays
  assert.equal(sync('DRAFTROOM_WS_DEFLATE'), 'off')
  // each in its own service only
  assert.equal(sync('DRAFTROOM_AI_VISION'), null)
  assert.equal(api('DRAFTROOM_REACTIONS'), null)
})

test('render.yaml: the wave T key (on since the wave T integration; the sync only)', () => {
  const api = (k) => envValue(RENDER_YAML, 'draftroom-staging-api', k)
  const sync = (k) => envValue(RENDER_YAML, 'draftroom-staging-sync', k)
  assert.equal(sync('DRAFTROOM_PLANNING'), 'on')
  assert.equal(api('DRAFTROOM_PLANNING'), null)
  // the reactions switch it builds on stays on (the room says 13 with planning off, 12 with reactions off)
  assert.equal(sync('DRAFTROOM_REACTIONS'), 'on')
})

/** The env keys of group `group` with their lines (`- key:` and what follows until the next key or group). */
function groupKeys(yaml, group) {
  const lines = yaml.replace(/\r\n?/g, '\n').split('\n')
  const start = lines.findIndex((l) => l.trimEnd() === `  - name: ${group}`)
  if (start < 0) return null
  const keys = {}
  let key = null
  for (let i = start + 1; i < lines.length && !/^ {2}- name:/.test(lines[i]) && !/^\S/.test(lines[i]); i++) {
    const k = /^\s+- key: (\S+)/.exec(lines[i])
    if (k) {
      key = k[1]
      keys[key] = []
    } else if (key && lines[i].trim()) keys[key].push(lines[i].trim())
  }
  return keys
}

/** Whether the service named `service` links env group `group`. */
function linksGroup(yaml, service, group) {
  const lines = yaml.replace(/\r\n?/g, '\n').split('\n')
  const start = lines.findIndex((l) => l.trimEnd() === `    name: ${service}`)
  if (start < 0) return false
  for (let i = start + 1; i < lines.length && !/^ {2}- type:/.test(lines[i]); i++)
    if (lines[i].trim() === `- fromGroup: ${group}`) return true
  return false
}

test('render.yaml: design previews are on on the api (the NAS preview worker runs the wave R build)', () => {
  assert.equal(envValue(RENDER_YAML, 'draftroom-staging-api', 'DRAFTROOM_DESIGN_PREVIEWS'), 'on')
  // an api setting only: sync and web never read it
  assert.equal(envValue(RENDER_YAML, 'draftroom-staging-sync', 'DRAFTROOM_DESIGN_PREVIEWS'), null)
})

test('render.yaml: the wave R key (a generated secret in its own group, linked to the api only)', () => {
  const keys = groupKeys(RENDER_YAML, 'draftroom-staging-webhook-secret')
  assert.ok(keys, 'the group exists')
  assert.deepEqual(Object.keys(keys), ['DRAFTROOM_WEBHOOK_SECRET'])
  assert.match(keys.DRAFTROOM_WEBHOOK_SECRET.join(' '), /^generateValue: true\b/)
  assert.equal(linksGroup(RENDER_YAML, 'draftroom-staging-api', 'draftroom-staging-webhook-secret'), true)
  assert.equal(linksGroup(RENDER_YAML, 'draftroom-staging-sync', 'draftroom-staging-webhook-secret'), false)
  // never in the shared group (sync would get it) nor as a plain value anywhere
  assert.deepEqual(Object.keys(groupKeys(RENDER_YAML, 'draftroom-staging-secrets')).sort(), [
    'DRAFTROOM_INTERNAL_SECRET',
    'DRAFTROOM_TICKET_SECRET',
  ])
  assert.equal(envValue(RENDER_YAML, 'draftroom-staging-api', 'DRAFTROOM_WEBHOOK_SECRET'), null)
  // the test seams are local development only: never in the Blueprint
  for (const k of ['DRAFTROOM_MIRO_TEST_ORIGINS', 'DRAFTROOM_CHAT_HOOK_TEST_ORIGINS'])
    assert.equal(RENDER_YAML.includes(k), false, k)
  // the helpers read what they should
  const sample = 'envVarGroups:\n  - name: g\n    envVars:\n      - key: A\n        value: x\n'
  assert.deepEqual(groupKeys(sample, 'g'), { A: ['value: x'] })
})
