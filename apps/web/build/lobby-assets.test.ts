// Wave Q (WS1): the /lobby-assets/ plugin (./lobby-assets.ts). The vitest projects do not include apps/web/build, so
// this runs with Node's test runner (CI's "Build guards" step runs apps/web/build/*.test.ts):
//   node --test apps/web/build/lobby-assets.test.ts
//
// A small real icon set (the first icons of both pinned sets, through the real generator) in a throwaway root: the
// dev server serves the index, the shards and LICENSES.txt from memory and answers 404 (never the SPA page) for
// anything else under the prefix; a build emits them under lobby-assets/icons/ and replaces __LOBBY_ICON_INDEX__
// with the index's hashed name; vite preview serves the emitted files and still 404s a miss; and the web's own
// vite.config.ts lists the plugin.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { ICON_INDEX_FILE_PATTERN, IconIndex, IconShard } from '@draftroom/contracts'
import { type GeneratedIcons, generateIcons, readSourceIcons } from '@draftroom/icon-sets/generate'
import { build, createServer, type Plugin, preview, type Rolldown } from 'vite'
import { ICON_INDEX_DEFINE, LOBBY_ASSET_BASE, lobbyAssetFiles, lobbyAssets } from './lobby-assets.ts'

const source = readSourceIcons()
const small: GeneratedIcons = generateIcons([
  ...source.filter((s) => s.set === 'lucide').slice(0, 30),
  ...source.filter((s) => s.set === 'tabler').slice(0, 30),
])
const generate = () => small

function siteRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'lobby-assets-'))
  writeFileSync(
    path.join(root, 'index.html'),
    '<!doctype html><script type="module" src="/main.js"></script>',
  )
  writeFileSync(path.join(root, 'main.js'), `globalThis.indexFile = ${ICON_INDEX_DEFINE}\n`)
  return root
}

async function get(base: string, p: string) {
  const res = await fetch(`${base}${p}`)
  return {
    status: res.status,
    type: res.headers.get('content-type') ?? '',
    cache: res.headers.get('cache-control'),
    body: await res.text(),
  }
}

test('the files: the index, 64 shards and LICENSES.txt under icons/, JSON or text', () => {
  const files = lobbyAssetFiles(small)
  assert.equal(files.size, 66)
  const index = files.get(`icons/${small.indexFile}`)
  assert.ok(index, 'the index is listed')
  assert.equal(index.type, 'application/json')
  assert.equal(index.hashed, true)
  IconIndex.parse(JSON.parse(index.body))
  assert.equal(files.get('icons/LICENSES.txt')?.type, 'text/plain; charset=utf-8')
  assert.equal(files.get('icons/LICENSES.txt')?.hashed, false)
  for (const name of small.index.shards) IconShard.parse(JSON.parse(files.get(`icons/${name}`)?.body ?? ''))
  assert.match(small.indexFile, ICON_INDEX_FILE_PATTERN)
  assert.equal(LOBBY_ASSET_BASE, '/lobby-assets/')
})

test('the dev server serves the generated files and 404s (not index.html) everything else under the prefix', async () => {
  const root = siteRoot()
  const server = await createServer({
    configFile: false,
    root,
    logLevel: 'silent',
    plugins: [lobbyAssets(generate)],
    server: { host: '127.0.0.1', port: 0 },
  })
  try {
    await server.listen()
    const { port } = server.httpServer?.address() as AddressInfo
    const base = `http://127.0.0.1:${port}`
    const index = await get(base, `/lobby-assets/icons/${small.indexFile}`)
    assert.equal(index.status, 200)
    assert.match(index.type, /application\/json/)
    assert.equal(index.cache, 'public, max-age=31536000, immutable')
    assert.deepEqual(JSON.parse(index.body), small.index)
    const shard = await get(base, `/lobby-assets/icons/${small.index.shards[3]}`)
    assert.equal(shard.status, 200)
    assert.equal(IconShard.parse(JSON.parse(shard.body)).shard, 3)
    const licences = await get(base, '/lobby-assets/icons/LICENSES.txt')
    assert.equal(licences.status, 200)
    assert.match(licences.body, /ISC License/)
    for (const miss of [
      '/lobby-assets/icons/index.0123456789abcdef.json',
      '/lobby-assets/icons/shard-99.0123456789abcdef.json',
      '/lobby-assets/icons/',
      '/lobby-assets/',
      '/lobby-assets/icons/..%2f..%2fpackage.json',
      '/lobby-assets/icons/%E0%A4%A',
    ]) {
      const r = await get(base, miss)
      assert.equal(r.status, 404, miss)
      assert.doesNotMatch(r.type, /text\/html/, miss)
    }
    // positive control: outside the prefix the SPA page still answers
    assert.match((await get(base, '/some/page')).type, /text\/html/)
  } finally {
    await server.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('a build emits the files under lobby-assets/icons/ and replaces the define with the hashed index name', async () => {
  const root = siteRoot()
  try {
    const out = (await build({
      configFile: false,
      root,
      logLevel: 'silent',
      plugins: [lobbyAssets(generate)],
      build: { write: false, outDir: path.join(root, 'dist') },
    })) as Rolldown.RolldownOutput | Rolldown.RolldownOutput[]
    const outputs = (Array.isArray(out) ? out : [out]).flatMap((o) => o.output)
    const emitted = outputs.filter((o) => o.fileName.startsWith('lobby-assets/'))
    assert.equal(emitted.length, 66)
    const index = emitted.find((o) => o.fileName === `lobby-assets/icons/${small.indexFile}`)
    assert.ok(index && index.type === 'asset', 'the index is emitted')
    assert.equal(String(index.source), small.files[0]?.content)
    const main = outputs.find((o): o is Rolldown.OutputChunk => o.type === 'chunk' && o.isEntry)
    assert.ok(main, 'an entry chunk')
    assert.ok(main.code.includes(small.indexFile), 'the define is the hashed name')
    assert.ok(!main.code.includes(ICON_INDEX_DEFINE), 'no define left unreplaced')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('vite preview serves the emitted files and 404s a miss under the prefix', async () => {
  const root = siteRoot()
  const outDir = path.join(root, 'dist')
  try {
    await build({
      configFile: false,
      root,
      logLevel: 'silent',
      plugins: [lobbyAssets(generate)],
      build: { outDir },
    })
    assert.equal(
      readFileSync(path.join(outDir, 'lobby-assets', 'icons', 'LICENSES.txt'), 'utf8'),
      small.files.at(-1)?.content,
    )
    const server = await preview({
      configFile: false,
      root,
      logLevel: 'silent',
      plugins: [lobbyAssets(generate)],
      build: { outDir },
      preview: { host: '127.0.0.1', port: 0 },
    })
    try {
      const { port } = server.httpServer.address() as AddressInfo
      const base = `http://127.0.0.1:${port}`
      const shard = await get(base, `/lobby-assets/icons/${small.index.shards[0]}`)
      assert.equal(shard.status, 200)
      assert.equal(IconShard.parse(JSON.parse(shard.body)).shard, 0)
      const miss = await get(base, '/lobby-assets/icons/shard-0.0000000000000000.json')
      assert.equal(miss.status, 404)
      assert.doesNotMatch(miss.type, /text\/html/)
    } finally {
      await server.close()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("the web's vite.config.ts lists the plugin", async () => {
  const config = (await import('../vite.config.ts')) as { default: { plugins?: unknown[] } }
  const plugins = (config.default.plugins ?? []).flat(4) as Plugin[]
  assert.ok(plugins.some((p) => p && typeof p === 'object' && p.name === 'lobby:lobby-assets'))
})
