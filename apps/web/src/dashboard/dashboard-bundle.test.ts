// Wave K (K4-6): a lighter dashboard. The Share dialog (about 43 KB with its sharing code) shipped with the
// dashboard although most visits never open it; it is a lazy chunk now, fetched when someone chooses Share on
// a card. This test reads the source the way the bundler does: from the app's entry it follows every STATIC
// import (a dynamic `import()` starts a new chunk and is not followed), so the dialog must not be reachable
// from the page's initial graph, and the one place that asks for it asks with `import()`. The built chunk is
// checked at run time in e2e/excalidraw/k4-dashboard.spec.ts (no ShareDialog request until Share is chosen).
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** What `file` imports with a static `import … from` / `export … from` (type-only ones skipped). */
function staticImports(file: string): { files: string[]; bare: string[] } {
  const src = readFileSync(file, 'utf8')
  const files: string[] = []
  const bare: string[] = []
  for (const m of src.matchAll(/^\s*(import|export)\s+(type\s+)?([^'";]*?\s+from\s+)?'([^']+)'/gm)) {
    if (m[2]) continue
    const spec = m[4] as string
    if (!spec.startsWith('.')) {
      bare.push(spec)
      continue
    }
    const target = resolve(dirname(file), spec)
    if (/\.(tsx?|jsx?)$/.test(target) && existsSync(target)) files.push(target)
  }
  return { files, bare }
}

/** Every module in the static closure of `entry` (paths relative to src/), and every bare package it imports. */
function closure(entry: string): { files: Set<string>; bare: Set<string> } {
  const seen = new Set<string>()
  const bare = new Set<string>()
  const visit = (file: string) => {
    if (seen.has(file)) return
    seen.add(file)
    const next = staticImports(file)
    for (const b of next.bare) bare.add(b)
    for (const f of next.files) visit(f)
  }
  visit(entry)
  return { files: new Set([...seen].map((f) => f.slice(SRC.length + 1).replaceAll('\\', '/'))), bare }
}

describe('the dashboard’s initial import graph', () => {
  const initial = closure(resolve(SRC, 'main.tsx'))

  it('reaches the dashboard page (the reading is real)', () => {
    expect(initial.files.has('App.tsx')).toBe(true)
    expect(initial.files.has('dashboard/DashboardPage.tsx')).toBe(true)
    expect(initial.files.size).toBeGreaterThan(50)
  })

  it('does not reach the Share dialog', () => {
    expect(initial.files.has('board/ShareDialog.tsx')).toBe(false)
  })

  it('does not reach the template builders either (the picker and the row load them when opened or idle)', () => {
    expect(initial.files.has('dashboard/template-catalog.ts')).toBe(false)
    expect([...initial.bare].filter((b) => b.startsWith('@draftroom/templates'))).toEqual([])
  })

  it('asks for the Share dialog in exactly one place on the dashboard: a lazy import()', () => {
    const page = readFileSync(resolve(SRC, 'dashboard/DashboardPage.tsx'), 'utf8')
    // fix/firefox: owned (lib/stale-chunk.ts ownedImport), so a chunk that is gone gets the boundary's notice
    expect(page).toMatch(/lazy\(\s*ownedImport\(\(\) =>\s*import\('\.\.\/board\/ShareDialog\.tsx'\)/)
    expect(page).not.toMatch(/^import\s[^\n]*ShareDialog[^\n]*from/m)
    expect(page.match(/ShareDialog\.tsx/g)?.length).toBe(1)
  })

  it('leaves the dialog to the board page’s own lazy import too', () => {
    const board = closure(resolve(SRC, 'canvas/board/LobbyBoardPage.tsx'))
    expect(board.files.has('board/ShareDialog.tsx')).toBe(false)
    const source = readFileSync(resolve(SRC, 'canvas/board/LobbyBoardPage.tsx'), 'utf8')
    expect(source).toMatch(/import\('\.\.\/\.\.\/board\/ShareDialog\.tsx'\)/)
  })
})
