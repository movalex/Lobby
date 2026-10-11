// node --test apps/web/test/bundle/pdf-worker-chunk.test.ts
//
// Wave N, N6-1 (the dependency change: @cantoo/pdf-lib in apps/web, @pdf-lib/fontkit when it lands): the production
// build of the web app (apps/web/vite.config.ts), in memory, once.
//  - The PDF library lives in the PDF worker's own bundle (assets/pdf.worker-<hash>.js) and in one lazy chunk the
//    page loads only when workers are unavailable (pdf-client.ts mainThreadBuilder). No PDF module is in the static
//    closure of the entry (the dashboard) or of the board page: their size is not touched by the dependency.
//  - The worker bundle has no `eval(` and no `new Function(` (the CSP has no 'unsafe-eval'; a PDF export must not
//    need it).
//  - Its size is recorded on every run (console) and capped. Recorded (this machine, rolldown/Vite 8.3.1):
//      pdf-lib 1.17.1, before wave N ........................ 428,590 B
//      @cantoo/pdf-lib 2.11.1, same code (N6-2) ............. 573,960 B
//      + the vector page pipeline (N6-3/N6-4) ............... ~606,000 B (gzip ~250 KB)
//      + @pdf-lib/fontkit (N6-1, not installed yet) ......... not measured
// About 10 s.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { build, type Rolldown } from 'vite'

const WEB = fileURLToPath(new URL('../../', import.meta.url))
const norm = (id: string) => id.split('\\').join('/')

/** The PDF packages (the fork, its own dependencies, the original, the font engine). */
const PDF_PACKAGE =
  /\/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?(?:@cantoo\/pdf-lib|pdf-lib|@pdf-lib\/[^/]+|culori|fflate|node-html-better-parser|html-entities)\//

/** The worker bundle's budget, bytes (raw): fontkit's arrival is expected to fit under it. */
const WORKER_BUDGET = 1_600_000

test('the PDF library is in the PDF worker (and one lazy chunk), never in the entry or the board page; no eval', async () => {
  const result = await build({
    root: WEB,
    configFile: `${WEB}vite.config.ts`,
    logLevel: 'silent',
    define: { __LOBBY_COMMIT__: JSON.stringify('n6-pdf-worker-test') },
    build: { write: false, emptyOutDir: false },
  })
  const outputs = (Array.isArray(result) ? result : [result]) as Rolldown.RolldownOutput[]
  const all = outputs.flatMap((o) => o.output)
  const chunks = all.filter((o): o is Rolldown.OutputChunk => o.type === 'chunk')
  const assets = all.filter((o): o is Rolldown.OutputAsset => o.type === 'asset')

  // the worker: one bundle of its own, carrying the fork
  const workers = [
    ...assets.filter((a) => /^assets\/pdf\.worker-[\w-]+\.js$/.test(a.fileName)).map((a) => String(a.source)),
    ...chunks.filter((c) => /^assets\/pdf\.worker-[\w-]+\.js$/.test(c.fileName)).map((c) => c.code),
  ]
  assert.equal(workers.length, 1, 'exactly one PDF worker bundle')
  const worker = workers[0] as string
  assert.ok(worker.includes('drawSvg'), 'the worker carries @cantoo/pdf-lib (drawSvg)')
  assert.ok(worker.includes('registerFontkit'), 'and its font engine hook')
  assert.equal(worker.match(/\bnew\s+Function\s*\(/g), null, 'no new Function( in the worker')
  assert.equal(worker.match(/(?<![\w$.])eval\s*\(/g), null, 'no eval( in the worker')
  const gz = gzipSync(worker).length
  console.log(`pdf worker bundle: ${worker.length} B raw, ${gz} B gzip`)
  assert.ok(
    worker.length < WORKER_BUDGET,
    `the worker bundle stays under ${WORKER_BUDGET} B (${worker.length})`,
  )

  // the page: the entry's and the board page's static closures hold no PDF module
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
  const pdfModules = (list: Rolldown.OutputChunk[]) =>
    list.flatMap((c) => c.moduleIds.map(norm).filter((id) => PDF_PACKAGE.test(id)))
  const entry = chunks.find((c) => c.isEntry) as Rolldown.OutputChunk
  assert.ok(entry, 'an entry chunk')
  const board = chunks.find(
    (c) => c.facadeModuleId && /\/src\/canvas\/board\/LobbyBoardPage\.tsx$/.test(norm(c.facadeModuleId)),
  ) as Rolldown.OutputChunk
  assert.ok(board, 'the board page chunk')
  assert.deepEqual(pdfModules(closure(entry)), [], 'no PDF module loads with the entry')
  assert.deepEqual(pdfModules(closure(board)), [], 'no PDF module loads with the board page')

  // the one lazy chunk with the fork: reached only by a dynamic import (pdf-client's no-worker fallback)
  const lazy = chunks.filter((c) => c.moduleIds.some((id) => /@cantoo\/pdf-lib/.test(norm(id))))
  assert.equal(lazy.length, 1, 'one page chunk carries the fork (the no-worker fallback)')
  const lazyName = (lazy[0] as Rolldown.OutputChunk).fileName
  assert.ok(
    chunks.some((c) => c.dynamicImports.includes(lazyName)),
    'the fallback chunk is imported dynamically',
  )
  assert.ok(!chunks.some((c) => c.imports.includes(lazyName)), 'and never statically')
  console.log(
    `page fallback chunk ${lazyName}: ${(lazy[0] as Rolldown.OutputChunk).code.length} B; entry ${entry.code.length} B`,
  )
})
