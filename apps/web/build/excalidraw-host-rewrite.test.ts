// Unit tests of the host-rewrite plugin's pure parts. The vitest projects do not include apps/web/build,
// so this runs with Node's test runner:  node --test apps/web/build/excalidraw-host-rewrite.test.ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  BLOCKED_HOST,
  engineDependencyTree,
  hostsInLiteral,
  literalRanges,
  packageOfId,
  rewriteLiteral,
  rewriteModule,
} from './excalidraw-host-rewrite.ts'

test('URL hosts in literals are rewritten, namespaces and local hosts are not', () => {
  assert.equal(rewriteLiteral('"https://esm.sh/@excalidraw/x"'), `"https://${BLOCKED_HOST}/@excalidraw/x"`)
  assert.equal(rewriteLiteral('"https://docs.example.org/a"'), `"https://${BLOCKED_HOST}/a"`)
  assert.equal(rewriteLiteral('"http://www.w3.org/2000/svg"'), '"http://www.w3.org/2000/svg"')
  assert.equal(rewriteLiteral('"http://localhost:5173/x"'), '"http://localhost:5173/x"')
  assert.equal(rewriteLiteral('".//index.js"'), '".//index.js"')
  // a regex source: escaped slashes and dots
  assert.equal(
    rewriteLiteral(String.raw`/^https?:\/\/(?:www\.)?youtube\.com\/watch/`),
    String.raw`/^https?:\/\/(?:www\.)?blocked\.invalid\/watch/`,
  )
})

test('listed hosts are rewritten outside URLs too, raw or escaped, with host boundaries', () => {
  assert.equal(rewriteLiteral('"player.vimeo.com"'), `"${BLOCKED_HOST}"`)
  assert.equal(rewriteLiteral(String.raw`/(?:twitter|x)\.com/`), String.raw`/(?:twitter|x)\.com/`)
  assert.equal(rewriteLiteral(String.raw`/x\.com\/status/`), String.raw`/blocked\.invalid\/status/`)
  assert.equal(rewriteLiteral('"box.com"'), '"box.com"')
  assert.equal(rewriteLiteral('"mygithub.com"'), '"mygithub.com"')
})

test('only literals are touched: code and comments stay as they are', () => {
  const code = [
    '/*! @license MIT https://github.com/x/y */',
    'const x = { com: 1 }; x.com; // see https://github.com/a/b',
    'const u = "https://json.excalidraw.com/api/v2/";',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: JS source under test
    'const t = `https://oss-ai.excalidraw.com/${path}`;',
    "import y from './lib/index.js';",
  ].join('\n')
  const out = rewriteModule('m.js', code)
  assert.ok(out.code.includes('/*! @license MIT https://github.com/x/y */'))
  assert.ok(out.code.includes('x.com; // see https://github.com/a/b'))
  assert.ok(out.code.includes(`"https://${BLOCKED_HOST}/api/v2/"`))
  assert.ok(out.code.includes(`\`https://${BLOCKED_HOST}/\${path}\``))
  assert.ok(out.code.includes("'./lib/index.js'"))
  assert.deepEqual(out.left, [])
  assert.equal(out.counts.url['json.excalidraw.com'], 1)
})

test('offsets of a module with non-ASCII text are string offsets', () => {
  const code = 'const a = "…✓ 白板"; const b = "https://esm.sh/x";'
  const ranges = literalRanges('m.js', code)
  assert.ok(ranges)
  assert.equal(code.slice(...(ranges[1] as [number, number])), '"https://esm.sh/x"')
  assert.ok(rewriteModule('m.js', code).code.endsWith(`"https://${BLOCKED_HOST}/x";`))
})

test('a bare hostname literal that is not listed is reported as left over', () => {
  assert.deepEqual(
    hostsInLiteral('"cdn.somewhere.io"').map((h) => h.host),
    ['cdn.somewhere.io'],
  )
  assert.deepEqual(hostsInLiteral('"index.js"'), [])
})

test("the embed allowlist's bare Set entries val.town and *.simplepdf.eu are rewritten; .town and .eu count as hosts", () => {
  // the removal's prod-build spec found `val.town` in the board chunk: neither host was listed, and the
  // bare-host check knew neither TLD, so the build did not report them either
  assert.equal(rewriteLiteral('"val.town"'), `"${BLOCKED_HOST}"`)
  assert.equal(rewriteLiteral('"*.simplepdf.eu"'), `"${BLOCKED_HOST}"`)
  assert.equal(rewriteLiteral('`*.simplepdf.eu`'), `\`${BLOCKED_HOST}\``)
  assert.deepEqual(hostsInLiteral(rewriteLiteral('["val.town","*.simplepdf.eu"]')), [])
  // a wildcard entry whose host is not rewritten is not rewritten by a shorter listed host (`x.com`)
  assert.equal(rewriteLiteral('"*.example-x.com"'), '"*.example-x.com"')
  assert.deepEqual(
    hostsInLiteral('"cdn.somewhere.town"').map((h) => h.host),
    ['cdn.somewhere.town'],
  )
  assert.deepEqual(
    hostsInLiteral('"*.somewhere.eu"').map((h) => [h.host, h.kind]),
    [['somewhere.eu', 'bare']],
  )
})

test('package of a module id (pnpm and plain layouts)', () => {
  assert.equal(
    packageOfId(
      'C:/r/node_modules/.pnpm/@excalidraw+excalidraw@0.18/node_modules/@excalidraw/excalidraw/dist/prod/index.js',
    ),
    '@excalidraw/excalidraw',
  )
  assert.equal(packageOfId('/r/node_modules/.pnpm/katex@0.16.0/node_modules/katex/dist/katex.mjs'), 'katex')
  assert.equal(packageOfId('/r/apps/web/src/main.tsx'), null)
})

test("the engine's dependency tree contains the engine and its dependencies, not React", () => {
  const tree = engineDependencyTree(
    '@excalidraw/excalidraw',
    new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
  )
  for (const p of ['@excalidraw/excalidraw', '@excalidraw/element', 'roughjs', 'mermaid', 'katex'])
    assert.ok(tree.has(p), p)
  assert.equal(tree.has('react'), false)
  assert.equal(tree.has('tldraw'), false)
})

test('the font fallback base becomes the same-origin asset base (dev and minified forms)', async () => {
  const { patchFontFallback } = await import('./excalidraw-host-rewrite.ts')
  const dev =
    // biome-ignore lint/suspicious/noTemplateCurlyInString: JS source under test
    '__publicField(_ExcalidrawFontFace, "ASSETS_FALLBACK_URL", `https://esm.sh/${define_import_meta_env_default.PKG_NAME ? `${define_import_meta_env_default.PKG_NAME}@${define_import_meta_env_default.PKG_VERSION}` : "@excalidraw/excalidraw"}/dist/prod/`);'
  const min =
    // biome-ignore lint/suspicious/noTemplateCurlyInString: JS source under test
    '_(z,"ASSETS_FALLBACK_URL",`https://esm.sh/${T.PKG_NAME?`${T.PKG_NAME}@${T.PKG_VERSION}`:`@excalidraw/excalidraw`}/dist/prod/`);'
  for (const code of [dev, min]) {
    const out = patchFontFallback(code)
    assert.equal(out.patched, 1)
    assert.ok(!out.code.includes('esm.sh'))
    assert.ok(out.code.includes('globalThis.location?.origin'))
    assert.ok(out.code.includes('/excalidraw-assets/`'))
    assert.deepEqual(rewriteModule('m.js', code).left, [])
  }
})
