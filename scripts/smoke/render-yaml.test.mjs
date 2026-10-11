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
    headers.every((h) => ['/*', '/assets/*', '/excalidraw-assets/*', '/version.json'].includes(h.path)),
    JSON.stringify(headers),
  )
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
  assert.equal(sync('DRAFTROOM_OUTBOUND_BUDGET_MB'), '128')
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
