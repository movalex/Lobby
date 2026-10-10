// Wave M foundation (S2, M3-5; vite.config.ts is lead-only): the build emits /version.json with the commit the page
// was built from (__LOBBY_COMMIT__), for W3's version check. The vitest projects do not include apps/web/build, so
// this runs with Node's test runner (CI's "Build guards" step runs apps/web/build/*.test.ts):
//   node --test apps/web/build/version-json.test.ts
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { build, type Plugin, type Rolldown } from 'vite'

const HERE = path.dirname(fileURLToPath(import.meta.url))

const config = (await import('../vite.config.ts')) as {
  default: { plugins?: unknown[]; define?: Record<string, string> }
  LOBBY_COMMIT: string
  VERSION_FILE: string
  versionJson(commit: string): Plugin
  versionJsonSource(commit: string): string
}

test('the body is {"commit": …} on one line', () => {
  assert.equal(config.versionJsonSource('0123456789ab'), '{"commit":"0123456789ab"}\n')
  assert.deepEqual(JSON.parse(config.versionJsonSource('unknown')), { commit: 'unknown' })
  assert.equal(config.VERSION_FILE, 'version.json')
})

test('the web build uses the plugin with the same commit as __LOBBY_COMMIT__ (build only)', () => {
  const plugins = (config.default.plugins ?? []).flat(4) as Plugin[]
  const plugin = plugins.find((p) => p && typeof p === 'object' && p.name === 'lobby-version-json')
  assert.ok(plugin, 'vite.config.ts lists versionJson()')
  assert.equal(plugin.apply, 'build')
  assert.equal(config.default.define?.__LOBBY_COMMIT__, JSON.stringify(config.LOBBY_COMMIT))
  assert.match(config.LOBBY_COMMIT, /^([0-9a-f]{7,12}|unknown)$/)
})

test('public/ has no version.json of its own (it would be copied over the build’s)', () => {
  assert.equal(existsSync(path.join(HERE, '..', 'public', 'version.json')), false)
})

test('a real build emits version.json at the root of dist with the commit', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'lobby-version-json-'))
  try {
    writeFileSync(
      path.join(root, 'index.html'),
      '<!doctype html><script type="module" src="/main.js"></script>',
    )
    writeFileSync(path.join(root, 'main.js'), 'console.log(1)\n')
    const out = (await build({
      configFile: false,
      root,
      logLevel: 'silent',
      plugins: [config.versionJson('feedc0ffee12')],
      build: { write: false, outDir: path.join(root, 'dist') },
    })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[]
    const outputs = (Array.isArray(out) ? out : [out]).flatMap((o) => o.output)
    const asset = outputs.find((o) => o.fileName === 'version.json')
    assert.ok(asset && asset.type === 'asset', 'version.json is emitted')
    assert.deepEqual(JSON.parse(String(asset.source)), { commit: 'feedc0ffee12' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
