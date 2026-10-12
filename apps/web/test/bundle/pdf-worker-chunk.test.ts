// node --test apps/web/test/bundle/pdf-worker-chunk.test.ts
//
// Wave N, N6-1 (the dependency changes: @cantoo/pdf-lib in apps/web; @pdf-lib/fontkit 1.1.1 in wave N.1): the
// production build of the web app (apps/web/vite.config.ts), in memory, once.
//  - The PDF library lives in the PDF worker's own bundle (assets/pdf.worker-<hash>.js) and in one lazy chunk the
//    page loads only when workers are unavailable (pdf-client.ts mainThreadBuilder). No PDF module is in the static
//    closure of the entry (the dashboard) or of the board page: their size is not touched by the dependency.
//  - While workers run, the PDF library never loads on the board's thread: read from the module graph, the only
//    module outside the PDF chunks that imports into them is pdf-client.ts (its no-worker fallback). An
//    exporter.ts that took its title helpers from pdf-build.ts again (not pdf-text.ts) fails here.
//  - The font engine (@pdf-lib/fontkit and its pako 1; Excalidraw's own pako 2 is the board's) is in the worker's bundle
//    and in exactly one page chunk, the no-worker fallback's (with vector/fontkit.ts), reached only by pdf-client.ts's
//    dynamic import: never with the entry or the board page, never statically.
//  - The worker bundle and every page chunk with a PDF package have no `eval(` and no `new Function(` (the CSP has
//    no 'unsafe-eval'; a PDF export must not need it), and no other call of the Function constructor than the one
//    fontkit bundles in the function-bind polyfill, whose `Function.prototype.bind || …` guard never reaches it.
//  - Its size is recorded on every run (console) and capped. Recorded (this machine, rolldown/Vite 8.3.1):
//      pdf-lib 1.17.1, before wave N ........................ 428,590 B
//      @cantoo/pdf-lib 2.11.1, same code (N6-2) ............. 573,960 B
//      + the vector page pipeline (N6-3/N6-4) ............... ~606,000 B (gzip ~250 KB)
//      + @pdf-lib/fontkit 1.1.1 and its adapter (wave N.1) .. 1,224,313 B (gzip 603,000; its fallback chunk 621,365 B)
//  - Every font file the build emits (served at /excalidraw-assets/fonts/) goes through the vector PDF font engine
//    (vector/fontkit.ts) with every glyph in a subset, and comes back with its own outlines and advances.
//  - Wave N.1 (review finding 1): what each served face's unicode-range (as the build's engine registers it) claims
//    and its font file has no glyph for, counted: the vector PDF never lays a character out in a face without its
//    glyph (vector/text-layout.ts re-routes it; vector-fidelity.test.ts proves it on Nunito's and Lilita One's), and
//    this count is the guard that an engine or font change is looked at again.
// About 20 s.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { build, type Plugin, type Rolldown } from 'vite'

const WEB = fileURLToPath(new URL('../../', import.meta.url))
const norm = (id: string) => id.split('\\').join('/')

/** The PDF packages (the fork, its own dependencies, the original, the font engine). */
const PDF_PACKAGE =
  /\/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?(?:@cantoo\/pdf-lib|pdf-lib|@pdf-lib\/[^/]+|culori|fflate|node-html-better-parser|html-entities)\/|\/node_modules\/\.pnpm\/pako@1\.[^/]+\/node_modules\/pako\//

/** The font engine and its one dependency: pako 1 (Excalidraw's pako 2 loads with the board and is not this). */
const FONTKIT_PACKAGE =
  /\/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?@pdf-lib\/fontkit\/|\/node_modules\/\.pnpm\/pako@1\.[^/]+\/node_modules\/pako\//
/** The module that adapts it for the fork (vector/fontkit.ts): the one importer of the engine. */
const FONTKIT_MODULE = /\/src\/features\/present-export\/vector\/fontkit\.ts$/

/** The worker bundle's budget, bytes (raw): fontkit's arrival is expected to fit under it. */
const WORKER_BUDGET = 1_600_000

/** The one module allowed to load the PDF library on the page: pdf-client.ts (mainThreadBuilder, no worker). */
const FALLBACK_IMPORTER = /\/src\/features\/present-export\/pdf-client\.ts$/

const NO_EVAL = (code: string, where: string) => {
  assert.equal(code.match(/\bnew\s+Function\s*\(/g), null, `no new Function( in ${where}`)
  assert.equal(code.match(/(?<![\w$.])eval\s*\(/g), null, `no eval( in ${where}`)
  // a bare Function( call is the same eval: only fontkit's function-bind fallback, behind its native-bind guard
  const calls = [...code.matchAll(/(?<![\w$.])Function\s*\(/g)].map((m) => code.slice(m.index, m.index + 60))
  for (const call of calls)
    assert.match(
      call,
      /^Function\(\s*[`'"]binder[`'"]\s*,/,
      `no Function( call in ${where} but fontkit's bind fallback: ${call}`,
    )
  if (calls.length)
    assert.ok(
      /Function\.prototype\.bind\s*\|\|/.test(code),
      `the bind fallback in ${where} is behind its native-bind guard`,
    )
}

// every dynamic import of the page's module graph (module to module), to tell WHICH module loads the PDF chunk
const dynamicImports: { from: string; to: string }[] = []
let built: Promise<{ chunks: Rolldown.OutputChunk[]; assets: Rolldown.OutputAsset[] }> | null = null
/** The one in-memory production build both tests read. */
function buildOnce() {
  built ??= (async () => {
    const graph: Plugin = {
      name: 'n6-dynamic-imports',
      generateBundle() {
        for (const id of this.getModuleIds())
          for (const to of this.getModuleInfo(id)?.dynamicallyImportedIds ?? [])
            dynamicImports.push({ from: norm(id), to: norm(to) })
      },
    }
    const result = await build({
      root: WEB,
      configFile: `${WEB}vite.config.ts`,
      logLevel: 'silent',
      define: { __LOBBY_COMMIT__: JSON.stringify('n6-pdf-worker-test') },
      plugins: [graph],
      build: { write: false, emptyOutDir: false },
    })
    const outputs = (Array.isArray(result) ? result : [result]) as Rolldown.RolldownOutput[]
    const all = outputs.flatMap((o) => o.output)
    return {
      chunks: all.filter((o): o is Rolldown.OutputChunk => o.type === 'chunk'),
      assets: all.filter((o): o is Rolldown.OutputAsset => o.type === 'asset'),
    }
  })()
  return built
}

test('the PDF library is in the PDF worker (and one lazy chunk), never in the entry or the board page; no eval', async () => {
  const { chunks, assets } = await buildOnce()

  // the worker: one bundle of its own, carrying the fork
  const workers = [
    ...assets.filter((a) => /^assets\/pdf\.worker-[\w-]+\.js$/.test(a.fileName)).map((a) => String(a.source)),
    ...chunks.filter((c) => /^assets\/pdf\.worker-[\w-]+\.js$/.test(c.fileName)).map((c) => c.code),
  ]
  assert.equal(workers.length, 1, 'exactly one PDF worker bundle')
  const worker = workers[0] as string
  // drawSvg's own message: in the fork only (pdf-lib 1.17 has drawSvgPath and registerFontkit too)
  assert.ok(worker.includes('This is not an svg. Ignoring'), 'the worker carries @cantoo/pdf-lib (drawSvg)')
  assert.ok(worker.includes('registerFontkit'), 'and the font engine hook')
  assert.ok(worker.includes('lobby-pdf-faces'), 'and the vector page (the face table it reads)')
  // fontkit's woff2 reader (its probe for the woff2 signature): Lobby's served fonts are read as they are
  assert.ok(worker.includes('wOF2'), 'and the font engine, with its woff2 reader (@pdf-lib/fontkit)')
  NO_EVAL(worker, 'the worker')
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
  // the page's chunks with any PDF package carry the same fork code as the worker: no eval there either
  const pdfChunks = chunks.filter((c) => pdfModules([c]).length > 0)
  assert.ok(pdfChunks.includes(lazy[0] as Rolldown.OutputChunk))
  for (const c of pdfChunks) NO_EVAL(c.code, c.fileName)
  // the font engine on the page: one chunk (the no-worker fallback's, with vector/fontkit.ts), dynamically imported
  // by pdf-client.ts only; nothing of it in the entry's or the board page's closure
  const fontkitModules = (list: Rolldown.OutputChunk[]) =>
    list.flatMap((c) => c.moduleIds.map(norm).filter((id) => FONTKIT_PACKAGE.test(id)))
  assert.deepEqual(fontkitModules(closure(entry)), [], 'no font engine module loads with the entry')
  assert.deepEqual(fontkitModules(closure(board)), [], 'no font engine module loads with the board page')
  const fontkitChunks = chunks.filter((c) => fontkitModules([c]).length > 0)
  assert.equal(fontkitChunks.length, 1, 'one page chunk carries the font engine (the no-worker fallback)')
  const fontkitChunk = fontkitChunks[0] as Rolldown.OutputChunk
  assert.ok(
    fontkitChunk.moduleIds.some((id) => /\/@pdf-lib\/fontkit\//.test(norm(id))) &&
      fontkitChunk.moduleIds.some((id) => FONTKIT_MODULE.test(norm(id))),
    'that chunk is @pdf-lib/fontkit with its adapter (vector/fontkit.ts)',
  )
  assert.ok(!chunks.some((c) => c.imports.includes(fontkitChunk.fileName)), 'never imported statically')
  const fontkitImporters = chunks.filter((c) => c.dynamicImports.includes(fontkitChunk.fileName))
  assert.ok(
    fontkitImporters.length > 0 &&
      fontkitImporters.every((c) => c.moduleIds.some((id) => FALLBACK_IMPORTER.test(norm(id)))),
    `only pdf-client.ts's chunk imports it (found: ${fontkitImporters.map((c) => c.fileName).join(', ')})`,
  )
  // and the PDF library never loads on the board's thread while workers run: of the modules outside the PDF chunks,
  // only pdf-client.ts's no-worker fallback imports into them (exporter.ts takes the titles from pdf-text.ts, and a
  // dynamic import('../pdf-build.ts') there would load the whole fork with every PDF export)
  const inPdfChunk = new Set(pdfChunks.flatMap((c) => c.moduleIds.map(norm)))
  assert.ok(dynamicImports.length > 0, 'the module graph was read')
  const loaders = [
    ...new Set(
      dynamicImports.filter((e) => inPdfChunk.has(e.to) && !inPdfChunk.has(e.from)).map((e) => e.from),
    ),
  ]
  assert.ok(
    loaders.length > 0 && loaders.every((from) => FALLBACK_IMPORTER.test(from)),
    `only pdf-client.ts loads the PDF chunk (found: ${loaders.map((f) => f.replace(/^.*\/src\//, 'src/')).join(', ')})`,
  )
  console.log(
    `page fallback chunk ${lazyName}: ${(lazy[0] as Rolldown.OutputChunk).code.length} B; its font engine chunk ` +
      `${fontkitChunk.fileName}: ${fontkitChunk.code.length} B; entry ${entry.code.length} B`,
  )
})

test('every font file the build serves survives a vector PDF subset (the font engine adapter): every glyph, every advance', async () => {
  // the fonts the excalidraw-assets plugin emits (exactly what /excalidraw-assets/fonts/ serves)
  const { assets } = await buildOnce()
  const fonts = assets.filter((a) => /^excalidraw-assets\/fonts\/[\w-]+\/[\w.-]+\.woff2$/.test(a.fileName))
  assert.ok(fonts.length > 200, `the build emits Lobby's font files (${fonts.length})`)
  const { roundTripFontFile } = await import('../../src/features/present-export/vector/fontkit-roundtrip.ts')
  let glyphs = 0
  const started = Date.now()
  for (const f of fonts) {
    const r = await roundTripFontFile(new Uint8Array(f.source as Uint8Array))
    assert.ok(r.transformed, `${f.fileName} is a woff2 with a transformed glyf`)
    assert.deepEqual(r.problems, [], f.fileName)
    glyphs += r.glyphs
  }
  console.log(
    `served fonts through a subset: ${fonts.length} files, ${glyphs} glyphs, ${Date.now() - started} ms`,
  )
  assert.ok(glyphs > 40_000, `every glyph (${glyphs})`)
})

/** Declared but missing (recorded, wave N.1): code points a served face's range claims, C0/C1 controls aside. */
const DECLARED_BUT_MISSING = 1906

test('every face the build serves: the code points its unicode-range claims and its font has no glyph for', async () => {
  const { chunks, assets } = await buildOnce()
  const FONT = /^excalidraw-assets\/fonts\/([\w-]+\/[\w.-]+\.woff2)$/
  const files = new Map<string, Uint8Array>()
  for (const a of assets) {
    const m = FONT.exec(a.fileName)
    if (m) files.set(m[1] as string, new Uint8Array(a.source as Uint8Array))
  }
  assert.equal(files.size, 233, 'the served font files')
  // the engine's font registrations as the build ships them: {uri:`./fonts/<file>`,descriptors:{unicodeRange:…}},
  // a range either a string or one of the engine's named Google Fonts ranges ({LATIN:`U+…`,…})
  const code = chunks.map((c) => c.code).join('\n')
  const NAMED = /\b(LATIN|LATIN_EXT|CYRILIC_EXT|CYRILIC|VIETNAMESE):([`"'])(U\+[0-9A-Fa-fU, +-]+)\2/g
  const named = new Map<string, string>()
  for (const m of code.matchAll(NAMED)) named.set(m[1] as string, m[3] as string)
  assert.equal(named.size, 5, 'the engine’s Google Fonts ranges')
  const FACE =
    /\{uri:([`"'])\.\/fonts\/([\w-]+\/[\w.-]+\.woff2)\1(?:,descriptors:\{unicodeRange:(?:([`"'])([^`"']*)\3|[\w$]+\.([A-Z_]+)))?/g
  const faces: { file: string; range: string | null }[] = []
  for (const m of code.matchAll(FACE))
    faces.push({ file: m[2] as string, range: m[4] ?? (m[5] ? (named.get(m[5]) ?? null) : null) })
  const registered = faces.filter((f) => !/^Liberation\//.test(f.file))
  // every served file but the UI's Assistant is a registered face; Cascadia and Virgil claim everything
  assert.equal(registered.length, 229, 'the registered faces')
  for (const f of registered) assert.ok(files.has(f.file), `${f.file} is served`)
  assert.deepEqual(
    [...files.keys()].filter((f) => !registered.some((r) => r.file === f)).map((f) => f.split('/')[0]),
    ['Assistant', 'Assistant', 'Assistant', 'Assistant'],
  )
  const whole = registered.filter((f) => !f.range).map((f) => f.file.split('/')[0])
  assert.deepEqual(whole.sort(), ['Cascadia', 'Virgil'])
  const { rawFontkit } = await import('../../src/features/present-export/vector/fontkit-roundtrip.ts')
  const engine = rawFontkit as unknown as {
    create(b: Uint8Array): { hasGlyphForCodePoint(cp: number): boolean }
  }
  let declared = 0
  let missing = 0
  const byFace: string[] = []
  for (const f of registered) {
    if (!f.range) continue
    const font = engine.create(files.get(f.file) as Uint8Array)
    let lacks = 0
    for (const part of f.range.split(',')) {
      const m = /^\s*U\+([0-9A-Fa-f]+)(?:-([0-9A-Fa-f]+))?\s*$/.exec(part)
      assert.ok(m, `${f.file}: a range part ${part}`)
      const lo = Number.parseInt(m[1] as string, 16)
      const hi = m[2] ? Number.parseInt(m[2], 16) : lo
      for (let cp = lo; cp <= hi; cp++) {
        if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) continue
        declared++
        if (!font.hasGlyphForCodePoint(cp)) lacks++
      }
    }
    missing += lacks
    if (lacks) byFace.push(`${f.file.split('/')[0]} ${lacks}`)
  }
  console.log(
    `served faces: ${registered.length} registered (${whole.length} whole-range), ${declared} declared code points, ` +
      `${missing} without a glyph (${byFace.join(', ')})`,
  )
  assert.equal(
    missing,
    DECLARED_BUT_MISSING,
    `declared but missing (${byFace.join(', ')}): look at them again`,
  )
})
