// Canvas overlay for tags (a child of <Tldraw>):
//  - the tag colours as CSS custom properties (one stylesheet, from the note palette, both themes);
//  - "Show only #tag": one stylesheet rule that dims every shape whose `data-dr-tags` (ShapeWrapper.tsx)
//    lacks the tag, plus the bar that says so and clears it. Nothing runs per frame or per shape.

import { useEffect, useLayoutEffect } from 'react'
import { useEditor, useValue } from 'tldraw'
import { NOTE_PALETTE } from '../canvas-ux/palette.ts'
import type { FeatureContext } from '../types.ts'
import { plural } from './copy.ts'
import { useTagRows } from './hooks.ts'
import { FilterIcon } from './icons.tsx'
import { useIsolated } from './isolate.ts'
import type { BoardTagRow } from './model.ts'
import { setTagsCtx, tagFilter } from './runtime.ts'

/** Tag colours: `--dr-tag-fill` / `--dr-tag-ink` on anything with `data-dr-tag-color`. */
export function tagColorCss(): string {
  const out: string[] = []
  const rule = (sel: string, v: { fill: string; text: string }) =>
    `${sel}{--dr-tag-fill:${v.fill};--dr-tag-ink:${v.text}}`
  for (const sw of NOTE_PALETTE) {
    const el = `[data-dr-tag-color="${sw.name}"]`
    // Panels and menus follow the app theme; on the canvas, tldraw's own light/dark wins (same weight,
    // later rule).
    out.push(rule(el, sw.light))
    out.push(rule(`:root[data-theme="dark"] ${el}`, sw.dark))
    out.push(rule(`.tl-container.tl-theme__light ${el}`, sw.light))
    out.push(rule(`.tl-container.tl-theme__dark ${el}`, sw.dark))
  }
  return out.join('\n')
}
const TAG_COLOR_CSS = tagColorCss()

/**
 * The "Show only" rule: everything on the canvas without the tag fades. Suspended while presenting
 * (present-export's html[data-dr-presenting]): slides show the whole board, and the bar hides too.
 */
export function tagFilterCss(key: string): string {
  const esc = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(key) : key.replace(/["\\]/g, '\\$&')
  return `html:not([data-dr-presenting]) .tl-container .tl-shapes .tl-shape:not([data-dr-tags~="${esc}"]){opacity:0.14 !important}`
}

export function TagsOverlay({ ctx }: { ctx: FeatureContext }) {
  const editor = useEditor()
  useLayoutEffect(() => {
    setTagsCtx(editor, ctx)
  })
  const filter = useValue('dr-tag-filter', () => tagFilter(editor).get(), [editor])
  return (
    <div className="dr-tags-overlay" data-testid="tags-overlay">
      <style data-testid="tag-colors">{TAG_COLOR_CSS}</style>
      {filter && <FilterBar filterKey={filter} />}
    </div>
  )
}

function FilterBar({ filterKey }: { filterKey: string }) {
  const editor = useEditor()
  // Only while a filter is on (the count needs the rows: throttled, see hooks.ts).
  const row = useTagRows(editor).find((r) => r.key === filterKey) ?? null
  // The tag is gone (deleted everywhere, perhaps by someone else): nothing left to show only.
  useEffect(() => {
    if (!row && tagFilter(editor).get() === filterKey) tagFilter(editor).set(null)
  }, [editor, row, filterKey])
  return row ? <FilterBarView row={row} /> : null
}

function FilterBarView({ row }: { row: BoardTagRow }) {
  const editor = useEditor()
  const ref = useIsolated<HTMLDivElement>()
  return (
    <>
      <style data-testid="tag-filter-style" data-tag-key={row.key}>
        {tagFilterCss(row.key)}
      </style>
      <div
        ref={ref}
        className="dr-tags-filterbar"
        role="status"
        data-testid="tag-filter-bar"
        data-tag-key={row.key}
      >
        <span className="dr-tags-filterbar__icon" aria-hidden="true">
          <FilterIcon size={15} />
        </span>
        <span className="dr-tags-filterbar__text">
          {/* On a phone the funnel and the pill say it; screen readers still hear the words. */}
          <span className="dr-tags-filterbar__label">Showing only</span>{' '}
          <span className="dr-tag-pill" data-dr-tag-color={row.color} title={row.name}>
            {row.name}
          </span>
          <span className="dr-tags-filterbar__count"> · {plural(row.count, 'item')}</span>
        </span>
        <button
          type="button"
          className="dr-btn dr-btn--sm dr-tags-filterbar__clear"
          data-testid="tag-filter-clear"
          onClick={() => {
            tagFilter(editor).set(null)
            editor.focus()
          }}
        >
          Show all
        </button>
      </div>
    </>
  )
}
