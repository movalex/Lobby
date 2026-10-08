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
    headers.every((h) => h.path === '/*' || h.path === '/assets/*' || h.path === '/excalidraw-assets/*'),
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
