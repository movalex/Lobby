// Wave 3e: the ported present-export, sharing and thumbnails features reuse the tldraw features' pure
// modules (slides, pdf, filename, plan, scheduler, upload…), which the lint rule on ported/** cannot see
// into. This walks every RUNTIME import from those ported folders through apps/web/src and fails if any
// path reaches tldraw (or the tldraw-based board-ops entry): the Excalidraw page must not load tldraw
// for these features. `import type` is erased; a mixed `import { type A }` still loads its module.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = fileURLToPath(new URL('../../../', import.meta.url))
const ROOTS = ['features/present-export/ported', 'features/sharing/ported', 'features/thumbnails/ported']
const FORBIDDEN = (spec: string) =>
  spec === 'tldraw' || spec.startsWith('@tldraw/') || spec === '@draftroom/board-ops'

function runtimeSpecs(src: string): string[] {
  const out: string[] = []
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  for (const m of code.matchAll(/^\s*(import|export)\s+([^'";]*?)\s*from\s*'([^']+)'/gm)) {
    const clause = (m[2] ?? '').trim()
    if (/^type\s/.test(clause)) continue // import type / export type: erased
    out.push(m[3] as string)
  }
  for (const m of code.matchAll(/^\s*import\s+'([^']+)'/gm)) out.push(m[1] as string)
  for (const m of code.matchAll(/import\(\s*'([^']+)'\s*\)/g)) out.push(m[1] as string)
  return out
}

function filesIn(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory()
      ? filesIn(join(dir, d.name))
      : /\.tsx?$/.test(d.name) && !/\.test\.tsx?$/.test(d.name)
        ? [join(dir, d.name)]
        : [],
  )
}

describe('ported present-export, sharing and thumbnails', () => {
  it('never load tldraw at run time (through any shared module)', () => {
    const seen = new Set<string>()
    const bad: string[] = []
    const visit = (file: string, via: string[]) => {
      if (seen.has(file)) return
      seen.add(file)
      for (const spec of runtimeSpecs(readFileSync(file, 'utf8'))) {
        if (FORBIDDEN(spec)) bad.push([...via, relative(SRC, file), spec].join(' → '))
        if (!spec.startsWith('.')) continue
        const target = resolve(dirname(file), spec)
        if (/\.(ts|tsx)$/.test(target) && existsSync(target)) visit(target, [...via, relative(SRC, file)])
      }
    }
    for (const root of ROOTS) for (const f of filesIn(join(SRC, root))) visit(f, [])
    expect(seen.size).toBeGreaterThan(10)
    expect(bad).toEqual([])
  })
})
