// PLAN-wave4, the mermaid stub (./mermaid-to-excalidraw-stub.ts, aliased in ../vite.config.ts). The vitest
// projects do not include apps/web/build, so this runs with Node's test runner:
//   node --test apps/web/build/mermaid-to-excalidraw-stub.test.ts
// The bundle side (no Mermaid in the production build) is e2e/excalidraw-builds/prod-build.spec.ts.
import assert from 'node:assert/strict'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE = '@excalidraw/mermaid-to-excalidraw'
/** The engine as the production build bundles it (its `production` condition). */
const engineProd = () =>
  readFileSync(
    path.join(
      realpathSync(path.join(HERE, '..', 'node_modules', '@excalidraw', 'excalidraw')),
      'dist/prod/index.js',
    ),
    'utf8',
  )

test('the web build resolves the converter to the stub, and only the converter itself', async () => {
  const mod = (await import('../vite.config.ts')) as {
    default: { resolve?: { alias?: { find: string | RegExp; replacement: string }[] } }
    MERMAID_STUB: string
  }
  const aliases = mod.default.resolve?.alias ?? []
  const matches = (id: string) =>
    aliases.filter((a) => (typeof a.find === 'string' ? a.find === id : a.find.test(id)))
  const hit = matches(PACKAGE)
  assert.equal(hit.length, 1)
  assert.equal(hit[0]?.replacement, mod.MERMAID_STUB)
  assert.equal(path.resolve(mod.MERMAID_STUB), path.join(HERE, 'mermaid-to-excalidraw-stub.ts'))
  assert.ok(existsSync(mod.MERMAID_STUB))
  for (const other of ['@excalidraw/excalidraw', `${PACKAGE}/dist/index.js`, `${PACKAGE}-x`, 'mermaid'])
    assert.equal(matches(other).length, 0, other)
})

test('the engine imports nothing from the converter but parseMermaidToExcalidraw, which the stub exports', async () => {
  const src = engineProd()
  const statics = [...src.matchAll(/import\{([^}]*)\}from"@excalidraw\/mermaid-to-excalidraw"/g)]
  assert.ok(statics.length > 0, 'the engine no longer imports the converter: drop the alias and the stub')
  const names = new Set(
    statics.flatMap((m) => (m[1] ?? '').split(',').map((s) => s.trim().split(/\s+as\s+/)[0])),
  )
  assert.deepEqual([...names], ['parseMermaidToExcalidraw'])
  // the lazy imports call that member only (the paste path, the text-to-diagram dialog)
  const members = new Set(
    [...src.matchAll(/\.(\w+)\((?=[^)]*\))/g)].map((m) => m[1] as string).filter((n) => /mermaid/i.test(n)),
  )
  assert.deepEqual([...members].sort(), ['parseMermaidToExcalidraw'])
  const stub = (await import('./mermaid-to-excalidraw-stub.ts')) as Record<string, unknown>
  assert.equal(typeof stub.parseMermaidToExcalidraw, 'function')
})

test('a pasted chart definition stays text: the stub rejects, and the engine’s paste path catches that and goes on', async () => {
  const { parseMermaidToExcalidraw } = await import('./mermaid-to-excalidraw-stub.ts')
  await assert.rejects(parseMermaidToExcalidraw('graph LR; A-->B'), /not available/)
  // App.insertClipboardContent: `let c = await import(...); try { … await c.parseMermaidToExcalidraw(text) … }
  // catch (p) { console.warn(…) }`, then the words are pasted as text
  const paste =
    /let (\w+)=await import\("@excalidraw\/mermaid-to-excalidraw"\);try\{[\s\S]{0,200}?await \1\.parseMermaidToExcalidraw\([\s\S]{0,600}?\}catch\(\w+\)\{console\.warn\(`parsing pasted text as mermaid definition failed/
  assert.ok(paste.test(engineProd()), 'the engine no longer catches a failed Mermaid parse in its paste path')
})
