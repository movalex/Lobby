/**
 * Wave O (WO-PAN): the element patch's A1/A4, A2 and C in the PRODUCTION build of @excalidraw/element, loaded as the
 * sync server loads it (`node src/server.ts`: packages/canvas-schema/src/engine/raw.ts imports the package, Node
 * resolves its exports' `default`, dist/prod), and with the `production` condition the web build resolves. Vitest
 * itself loads dist/dev for the package, so each run is a child `node` (pan/prod-check.ts), which compares every
 * speed-up with the engine's own unpatched answer and prints what it found.
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { ProdCheck } from './pan/prod-check.ts'

const SCRIPT = fileURLToPath(new URL('./pan/prod-check.ts', import.meta.url))

const run = (args: string[]): ProdCheck => {
  const out = execFileSync(process.execPath, [...args, SCRIPT], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  return JSON.parse(out.trim().split('\n').at(-1) as string) as ProdCheck
}

describe.each([
  ['the sync server’s load (no condition: the exports’ default)', []],
  ['the production condition (the web build’s)', ['--conditions=production']],
])('the production build of @excalidraw/element, %s', (_, args) => {
  const r = run(args)

  it('is dist/prod of the one patched copy, the module the server’s import holds', () => {
    expect(r.conditions).toEqual(args)
    expect(r.resolved.replace(/\\/g, '/')).toMatch(/\/@excalidraw\/element\/dist\/prod\/index\.js$/)
    expect(r.resolvedFromSync).toBe(r.resolved)
    expect(r.sameInstance).toBe(true)
    expect(r.patched).toBe(true)
  })

  it('A1 / A4: isElementInViewportAt answers as isElementInViewport (10k board, corpus, edges, offsets)', () => {
    expect(r.checks.A1.sample).toEqual([])
    expect(r.checks.A1.mismatches).toBe(0)
    expect(r.checks.A1.compared).toBeGreaterThan(500_000)
    expect(r.visibleA1).toBeGreaterThan(10_000)
  })

  it('A2: a bound text’s cached bounds are the uncached computation after every change of its container', () => {
    expect(r.checks.A2.sample).toEqual([])
    expect(r.checks.A2.mismatches).toBe(0)
    expect(r.checks.A2.compared).toBeGreaterThanOrEqual(15)
    // and the cache serves a label (the speed-up is on in this build)
    expect(r.cacheHitA2).toBe(true)
  })

  it('C: shouldApplyFrameClip answers as the engine’s three tests, groups too (board, edge sweep)', () => {
    expect(r.checks.C.sample).toEqual([])
    expect(r.checks.C.mismatches).toBe(0)
    expect(r.checks.C.compared).toBeGreaterThan(5_000)
    expect(r.fastC).toBeGreaterThan(4_000)
  })
})
