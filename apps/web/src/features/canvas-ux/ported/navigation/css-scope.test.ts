// W5-09 (docs/research/excalidraw/REVIEW-W5-EARLY.md): the ported navigation's `.dr-nav` rules
// (flex-direction: column-reverse) overrode the dashboard sidebar's `.dr-nav` once a board had been
// visited, because a page's stylesheets stay loaded after an in-app navigation, so the sidebar read Trash,
// Archived, All boards, Recent. The check here: no rule of a ported stylesheet (`**/ported/**/*.css`,
// loaded with the Excalidraw board page) may select only by class names a shared stylesheet (the dashboard,
// the tldraw board, styles.css) also uses, unless it is scoped to the board page by a `[data-lobby-…]`
// attribute or a class only the ported stylesheets use. Such a rule restyles the shared element on every
// page visited after a board. (A build check of the same rule belongs to the wave-4 integration; this one
// runs with `pnpm test`.)
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = fileURLToPath(new URL('../../../../', import.meta.url))

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return cssFiles(p)
    return p.endsWith('.css') ? [p] : []
  })
}

/** Every selector of every style rule (comments removed; at-rule preludes and keyframe steps left out). */
export function selectorsOf(css: string): string[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const out: string[] = []
  for (const m of text.matchAll(/([^{};]+)\{/g)) {
    const prelude = (m[1] ?? '').trim()
    if (!prelude || prelude.startsWith('@')) continue
    // split on top-level commas only (not inside :is(), :not(), :has())
    let depth = 0
    let start = 0
    for (let i = 0; i < prelude.length; i++) {
      const ch = prelude[i]
      if (ch === '(') depth++
      else if (ch === ')') depth--
      else if (ch === ',' && depth === 0) {
        out.push(prelude.slice(start, i).trim())
        start = i + 1
      }
    }
    out.push(prelude.slice(start).trim())
  }
  return out.filter(Boolean)
}

export const classesOf = (selector: string): string[] =>
  [...selector.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)].map((m) => m[1] as string)

/**
 * The selectors of `ported` that would restyle an element of a shared stylesheet: every class in it is one
 * a shared stylesheet uses, and nothing in it scopes it to the board page (`[data-lobby-…]`).
 */
export function collisions(ported: readonly string[], shared: ReadonlySet<string>): string[] {
  return ported.filter((sel) => {
    if (sel.includes('[data-lobby')) return false
    const cls = classesOf(sel)
    return cls.length > 0 && cls.every((c) => shared.has(c))
  })
}

describe('ported stylesheets keep to the board page (W5-09)', () => {
  it('finds the collision W5-09 shipped with, and leaves scoped rules alone', () => {
    const shared = new Set(['dr-nav', 'dr-nav__item', 'dr-ai-panel', 'dr-tag-chip'])
    const css = `
      /* .dr-nav { comment } */
      .dr-nav { flex-direction: column-reverse; }
      .dr-nav__item:hover:not(:disabled), .dr-cnav__btn { color: red; }
      [data-lobby-board-canvas] .dr-ai-panel { top: 0; }
      .dr-tags-scene .dr-tag-chip { opacity: 0; }
      @media (max-width: 600px) { .dr-nav__item { gap: 0; } }
      @keyframes spin { from { opacity: 0; } to { opacity: 1; } }
    `
    expect(collisions(selectorsOf(css), shared)).toEqual([
      '.dr-nav',
      '.dr-nav__item:hover:not(:disabled)',
      '.dr-nav__item',
    ])
  })

  it('no ported stylesheet selects only by a shared stylesheet’s class names', () => {
    const files = cssFiles(SRC).map((f) => ({ f, rel: relative(SRC, f).split('\\').join('/') }))
    const ported = files.filter(({ rel }) => rel.includes('/ported/'))
    const shared = new Set<string>()
    for (const { f, rel } of files) {
      if (rel.includes('/ported/')) continue
      for (const sel of selectorsOf(readFileSync(f, 'utf8'))) for (const c of classesOf(sel)) shared.add(c)
    }
    expect(ported.length).toBeGreaterThan(0)
    const found = ported.flatMap(({ f, rel }) =>
      collisions(selectorsOf(readFileSync(f, 'utf8')), shared).map((sel) => `${rel}: ${sel}`),
    )
    expect(found).toEqual([])
  })
})
