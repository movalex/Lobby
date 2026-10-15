// node --test apps/web/test/bundle/icon-assets.test.ts
//
// Wave Q (WS1): the built-in icons add nothing to the board's eager code. The production build of the web app
// (apps/web/vite.config.ts), in memory, with the board page importing the icon API lazily as the Elements panel will
// (a transform adds `import('…/features/elements/icons/index.ts')` to LobbyBoardPage.tsx; the files on disk are
// never touched):
//
//  - the index, the 64 shards and LICENSES.txt are emitted as files under lobby-assets/icons/;
//  - no chunk carries icon data (no shard's or the index's content, no icon key), and no chunk holds the generator
//    or converter (packages/icon-sets);
//  - the icon API is a lazy chunk of its own: neither the entry, nor the board page, nor anything either loads
//    statically holds a module of features/elements/icons/;
//  - the index's hashed name reaches only that lazy chunk (the define), and it is the emitted index.
// About 15 s.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { ICON_INDEX_FILE_PATTERN, ICON_SHARD_COUNT, ICON_SHARD_FILE_PATTERN } from '@draftroom/contracts'
import { build, type Plugin, type Rolldown } from 'vite'

const WEB = fileURLToPath(new URL('../../', import.meta.url))
const norm = (id: string) => id.split('\\').join('/')
const ICONS_DIR = '/apps/web/src/features/elements/icons/'
const BOARD_PAGE = /\/src\/canvas\/board\/LobbyBoardPage\.tsx$/

/** The Elements panel's lazy import of the icon API, made in the transform. */
function lazyIconsProbe(): Plugin {
  return {
    name: 'wave-q-lazy-icons-probe',
    enforce: 'post',
    transform(code, id) {
      if (!BOARD_PAGE.test(norm(id))) return null
      const probe = "\n;globalThis.__iconsProbe = () => import('../../features/elements/icons/index.ts')\n"
      return { code: `${code}${probe}`, map: null }
    },
  }
}

test('the icons are files under lobby-assets/icons/ and a lazy chunk: nothing in the entry or the board page', async () => {
  const result = await build({
    root: WEB,
    configFile: `${WEB}vite.config.ts`,
    logLevel: 'silent',
    define: { __LOBBY_COMMIT__: JSON.stringify('wave-q-icons-test') },
    build: { write: false, emptyOutDir: false },
    plugins: [lazyIconsProbe()],
  })
  const outputs = Array.isArray(result) ? result : [result]
  const all = outputs.flatMap((o) => (o as Rolldown.RolldownOutput).output)
  const chunks = all.filter((o): o is Rolldown.OutputChunk => o.type === 'chunk')
  const assets = all.filter((o): o is Rolldown.OutputAsset => o.type === 'asset')

  // the files
  const iconFiles = assets.filter((a) => a.fileName.startsWith('lobby-assets/icons/'))
  const names = iconFiles.map((a) => a.fileName.slice('lobby-assets/icons/'.length))
  const indexFiles = names.filter((n) => ICON_INDEX_FILE_PATTERN.test(n))
  assert.equal(indexFiles.length, 1, 'one index')
  assert.equal(names.filter((n) => ICON_SHARD_FILE_PATTERN.test(n)).length, ICON_SHARD_COUNT, '64 shards')
  assert.ok(names.includes('LICENSES.txt'), 'LICENSES.txt')
  assert.equal(names.length, ICON_SHARD_COUNT + 2, 'nothing else under lobby-assets/icons/')

  // no icon data and no generator in any chunk
  const data = iconFiles.filter((a) => a.fileName.endsWith('.json')).map((a) => String(a.source))
  const indexText = data.find((d) => d.includes('"lobby-icon-index"')) ?? '{}'
  const index = JSON.parse(indexText) as { icons: [string, string][] }
  const keys = index.icons.filter((_, n) => n % 97 === 0).map(([set, name]) => `"${set}:${name}"`)
  assert.ok(keys.length > 50, 'a sample of icon keys')
  for (const c of chunks) {
    for (const d of data) assert.ok(!c.code.includes(d.slice(200, 400)), `icon data in ${c.fileName}`)
    for (const k of keys) assert.ok(!c.code.includes(k), `the icon key ${k} in ${c.fileName}`)
    const generator = c.moduleIds.some((id) => norm(id).includes('/packages/icon-sets/'))
    assert.ok(!generator, `icon-sets in ${c.fileName}`)
  }

  // the icon API: a lazy chunk, outside the entry's and the board page's static closure
  const byName = new Map(chunks.map((c) => [c.fileName, c]))
  const closure = (from: Rolldown.OutputChunk) => {
    const seen = new Set<string>()
    const stack = [from.fileName]
    while (stack.length) {
      const f = stack.pop() as string
      if (seen.has(f)) continue
      seen.add(f)
      for (const i of byName.get(f)?.imports ?? []) stack.push(i)
    }
    return [...seen].map((f) => byName.get(f) as Rolldown.OutputChunk)
  }
  const holdsIcons = (c: Rolldown.OutputChunk) => c.moduleIds.some((id) => norm(id).includes(ICONS_DIR))
  const iconChunks = chunks.filter(holdsIcons)
  assert.ok(iconChunks.length >= 1, 'positive control: the probe pulled the icon API into the build')
  const entry = chunks.find((c) => c.isEntry)
  const page = chunks.find((c) => BOARD_PAGE.test(norm(c.facadeModuleId ?? '')))
  assert.ok(entry && page, 'the entry and the board page chunks')
  for (const c of [...closure(entry), ...closure(page)])
    assert.ok(!holdsIcons(c), `${c.fileName} (eager for the board) holds the icon API`)
  assert.ok(
    iconChunks.some((c) => page.dynamicImports.includes(c.fileName)),
    'the board page imports the icon API lazily',
  )

  // the index's hashed name, in the lazy chunk only, is the emitted index
  const indexName = indexFiles[0] as string
  const naming = chunks.filter((c) => c.code.includes(indexName))
  assert.ok(naming.length >= 1, 'the define reached the loader')
  assert.ok(naming.every(holdsIcons), 'only the icon API names the index')
  assert.ok(!chunks.some((c) => c.code.includes('__LOBBY_ICON_INDEX__')), 'no define left unreplaced')
})
