// node --test apps/web/test/bundle/vendor-chunk.test.ts
//
// K1-6 (wave K): the production build of the web app (apps/web/vite.config.ts), twice, in memory: once as
// it is and once with Lobby's own code changed (a statement added to App.tsx and to the board page, as a
// source edit would). The Excalidraw engine (node_modules/@excalidraw/excalidraw/dist/prod) is in a chunk of
// its own, with no Lobby module in it, and keeps its file name (its content hash) across the two builds;
// so do the react and preload-helper chunks it imports, and the engine's stylesheet. Positive controls: the
// board page's chunk and the entry change. The dashboard's entry does not load the engine; the host rewrite
// ran on the engine chunk; the head scripts are emitted hashed under /assets/ and stay classic,
// same-origin, non-inline scripts in index.html's <head>, before the module script. About 10 s.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { build, type Plugin, type Rolldown } from 'vite'

const WEB = fileURLToPath(new URL('../../', import.meta.url))
const norm = (id: string) => id.split('\\').join('/')

/** A Lobby source change, made in the transform (the files on disk are never touched). */
function lobbyEdit(variant: string): Plugin {
  return {
    name: 'k1-lobby-edit',
    enforce: 'post',
    transform(code, id) {
      const n = norm(id)
      if (n.endsWith('/apps/web/src/App.tsx') || n.endsWith('/apps/web/src/canvas/board/LobbyBoardPage.tsx'))
        return { code: `${code}\n;globalThis.__k1Edit = ${JSON.stringify(variant)}\n`, map: null }
      return null
    },
  }
}

interface Built {
  chunks: Rolldown.OutputChunk[]
  assets: Rolldown.OutputAsset[]
}

async function buildWeb(variant?: string): Promise<Built> {
  const result = await build({
    root: WEB,
    configFile: `${WEB}vite.config.ts`,
    logLevel: 'silent',
    // the same commit in both builds (the feedback dialog's build info)
    define: { __LOBBY_COMMIT__: JSON.stringify('k1-vendor-test') },
    build: { write: false, emptyOutDir: false },
    plugins: variant ? [lobbyEdit(variant)] : [],
  })
  const outputs = (Array.isArray(result) ? result : [result]) as Rolldown.RolldownOutput[]
  const all = outputs.flatMap((o) => o.output)
  return {
    chunks: all.filter((o): o is Rolldown.OutputChunk => o.type === 'chunk'),
    assets: all.filter((o): o is Rolldown.OutputAsset => o.type === 'asset'),
  }
}

const isEngine = (id: string) =>
  /\/node_modules\/@excalidraw\/excalidraw\/dist\/prod\/index\.js$/.test(norm(id))
const engineChunk = (b: Built) => {
  const found = b.chunks.filter((c) => c.moduleIds.some(isEngine))
  assert.equal(found.length, 1, 'the engine entry is in exactly one chunk')
  return found[0] as Rolldown.OutputChunk
}
const chunkOf = (b: Built, facade: RegExp) => {
  const c = b.chunks.find((x) => x.facadeModuleId && facade.test(norm(x.facadeModuleId)))
  assert.ok(c, `a chunk for ${facade}`)
  return c
}
const named = (b: Built, prefix: string) => b.chunks.filter((c) => c.fileName.startsWith(`assets/${prefix}-`))

/** Every chunk the entry loads before anything lazy: its static imports, transitively. */
function staticClosure(b: Built, from: Rolldown.OutputChunk): Set<string> {
  const byName = new Map(b.chunks.map((c) => [c.fileName, c]))
  const seen = new Set<string>()
  const stack = [from.fileName]
  while (stack.length) {
    const f = stack.pop() as string
    if (seen.has(f)) continue
    seen.add(f)
    for (const i of byName.get(f)?.imports ?? []) stack.push(i)
  }
  return seen
}

test('the engine is a chunk of its own whose name survives a Lobby-only change; the head scripts are hashed', async () => {
  const a = await buildWeb()
  const b = await buildWeb('B')

  // the engine's chunk: node_modules only (and the mermaid stub the engine imports), no Lobby source
  const engineA = engineChunk(a)
  const engineB = engineChunk(b)
  const lobbyModules = engineA.moduleIds
    .map(norm)
    .filter((id) => !id.includes('/node_modules/') && !id.includes('\0'))
  assert.deepEqual(
    lobbyModules.filter((id) => !id.endsWith('/apps/web/build/mermaid-to-excalidraw-stub.ts')),
    [],
    'no Lobby module in the engine chunk',
  )
  assert.ok(!engineA.moduleIds.some((id) => norm(id).includes('/apps/web/src/')), 'no apps/web/src module')
  assert.match(engineA.fileName, /^assets\/excalidraw-[\w-]+\.js$/)
  // it imports only the vendor chunks (whose names are stable too)
  for (const imp of engineA.imports)
    assert.match(imp, /^assets\/(react|preload-helper|rolldown-runtime)-/, imp)

  // the same file name after a change to Lobby's code; so are the vendor chunks and the engine stylesheet
  assert.equal(engineB.fileName, engineA.fileName, 'the engine chunk keeps its hash')
  for (const prefix of ['react', 'preload-helper', 'rolldown-runtime'])
    assert.deepEqual(
      named(b, prefix).map((c) => c.fileName),
      named(a, prefix).map((c) => c.fileName),
      prefix,
    )
  const engineCss = (x: Built) =>
    x.assets.filter((s) => /^assets\/excalidraw-[\w-]+\.css$/.test(s.fileName)).map((s) => s.fileName)
  assert.equal(engineCss(a).length, 1, 'the engine stylesheet is a file of its own')
  assert.deepEqual(engineCss(b), engineCss(a), 'the engine stylesheet keeps its hash')

  // positive controls: the edit reached the board page's chunk and the entry
  const pageA = chunkOf(a, /\/src\/canvas\/board\/LobbyBoardPage\.tsx$/)
  const pageB = chunkOf(b, /\/src\/canvas\/board\/LobbyBoardPage\.tsx$/)
  assert.notEqual(pageB.fileName, pageA.fileName, 'the board page chunk changed')
  const entryA = a.chunks.find((c) => c.isEntry) as Rolldown.OutputChunk
  const entryB = b.chunks.find((c) => c.isEntry) as Rolldown.OutputChunk
  assert.notEqual(entryB.fileName, entryA.fileName, 'the entry changed')
  assert.ok(pageA.imports.includes(engineA.fileName), 'the board page imports the engine chunk')

  // the dashboard (the entry and what it loads statically) never downloads the engine; K1-1: the board route
  // is in the entry, so the board page is the one lazy step
  assert.ok(!staticClosure(a, entryA).has(engineA.fileName), 'the entry does not load the engine')
  assert.ok(!staticClosure(a, entryA).has(pageA.fileName), 'the entry does not load the board page')
  assert.ok(entryA.dynamicImports.includes(pageA.fileName), 'the entry imports the board page lazily')
  assert.equal(
    a.chunks.filter(
      (c) => c.facadeModuleId && /\/src\/canvas\/board\/route\.tsx$/.test(norm(c.facadeModuleId)),
    ).length,
    0,
    'no separate route chunk',
  )

  // the host rewrite ran on the engine's code in its new chunk (apps/web/build/excalidraw-host-rewrite.ts)
  assert.ok(!engineA.code.includes('esm.sh'), 'no esm.sh left in the engine chunk')
  assert.ok(engineA.code.includes('blocked.invalid'), 'the rewritten hosts are there')

  // K1-6: the head scripts, hashed under /assets/, classic, same-origin, never inline, before the module script
  const html = String(a.assets.find((s) => s.fileName === 'index.html')?.source ?? '')
  for (const name of ['theme-boot', 'zod-jitless']) {
    const asset = a.assets.find((s) => new RegExp(`^assets/${name}-[\\w-]{8}\\.js$`).test(s.fileName))
    assert.ok(asset, `${name} is emitted under assets/`)
    assert.equal(
      String(asset.source),
      readFileSync(`${WEB}public/${name}.js`, 'utf8'),
      `${name}: the public file, as it is`,
    )
    const tag = `<script src="/${asset.fileName}"></script>`
    const at = html.indexOf(tag)
    assert.ok(at > -1, `index.html loads ${tag}`)
    assert.ok(at < html.indexOf('</head>'), `${name} in <head>`)
    assert.ok(at < html.indexOf('type="module"'), `${name} before the module script`)
    assert.ok(!html.includes(`<script src="/${name}.js">`), `${name}: the unhashed tag is gone`)
    // the same name when only Lobby's code changed (the scripts did not)
    assert.ok(
      b.assets.some((s) => s.fileName === asset.fileName),
      `${name} keeps its hash`,
    )
  }
  assert.equal(html.match(/<script(?![^>]*\bsrc=)[^>]*>/g), null, 'no inline script')
})
