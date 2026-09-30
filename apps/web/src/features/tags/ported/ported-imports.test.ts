// Wave 3d: the ported mind map and tags reuse the tldraw features' pure modules (the tree model, the
// layout, the outline, the tag rules, the picker placement…), which the lint rule on ported/** cannot see
// into. This walks every RUNTIME import from both ported folders through apps/web/src and fails if any path
// reaches tldraw or a package entry that loads it (`@draftroom/board-ops` and `@draftroom/canvas-schema`
// roots; their `elements`, `custom-data` and `doc` subpaths are tldraw-free): the Excalidraw page must not
// load tldraw for these features. `import type` is erased; a mixed `import { type A }` still loads its
// module. (The same walk as 3e's present-export/ported/ported-imports.test.ts.)
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = fileURLToPath(new URL('../../../', import.meta.url))
const ROOTS = ['features/mindmap/ported', 'features/tags/ported']
const FORBIDDEN = (spec: string) =>
  spec === 'tldraw' ||
  spec.startsWith('@tldraw/') ||
  spec === '@draftroom/board-ops' ||
  spec === '@draftroom/canvas-schema'

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

describe('ported mind map and tags', () => {
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
    expect(seen.size).toBeGreaterThan(20)
    expect(bad).toEqual([])
  })
})
