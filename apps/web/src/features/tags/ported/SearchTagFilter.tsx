// What 3b's board search panel can use from tags on the new canvas (the port of ../SearchTagFilter.tsx):
// the tag filter control, its state (kept on the runtime while the panel closes and opens, like its
// query) and the tag-aware search itself (./search.ts). The panel stays 3b's; these are its hooks.

import type { ElementSearchHit } from '@draftroom/board-ops/elements'
import { useId } from 'react'
import type { CanvasElement, LobbyCanvas } from '../../../canvas/api/index.ts'
import { useValue } from '../../../lib/signals.ts'
import { tagsOf } from './bridge.ts'
import { useTagRows } from './hooks.ts'
import type { TagsRuntime } from './runtime.ts'
import { searchElementsWithTags } from './search.ts'

export { textOfQuery } from './search.ts'

/** The tag filter, or null when none is set or its tag has gone from the board. */
export function useSearchTag(rt: TagsRuntime): string | null {
  const key = useValue('tags.search-tag', () => rt.searchTag.get(), [rt])
  const rows = useTagRows(rt)
  return key !== null && rows.some((r) => r.key === key) ? key : null
}

/**
 * The tag filter of the board search on `canvas` (null when the tags feature is not mounted, when none is
 * set, or when its tag has gone from the board): for 3b's panel, which has no tags runtime of its own
 * (wave-3 integration).
 */
export function useCanvasSearchTag(canvas: LobbyCanvas): string | null {
  const t = useValue('tags.bridge', () => tagsOf(canvas), [canvas])
  const key = useValue('tags.search-tag-key', () => t?.rt.searchTag.get() ?? null, [t])
  const rows = useValue('tags.search-tag-rows', () => (t && key !== null ? t.rt.rows.get() : null), [t, key])
  return key !== null && rows?.some((r) => r.key === key) ? key : null
}

/**
 * The board search with tags for `canvas` (plain searchElements' results when the tags feature is not
 * mounted). `elements`: what the panel searches (live, visible).
 */
export function searchWithTags(
  canvas: LobbyCanvas,
  elements: Iterable<CanvasElement>,
  query: string,
  opts: { limit: number; tag: string | null },
): ElementSearchHit[] {
  const board = tagsOf(canvas)?.rt.board.get() ?? new Map()
  return searchElementsWithTags(elements, query, { ...opts, board })
}

/** "Tag: Any tag / Research (12) / …" under the type filters; only on boards that have tags. */
export function SearchTagFilter({ canvas, onChange }: { canvas: LobbyCanvas; onChange(): void }) {
  const t = useValue('tags.bridge', () => tagsOf(canvas), [canvas])
  return t ? <Filter rt={t.rt} onChange={onChange} /> : null
}

function Filter({ rt, onChange }: { rt: TagsRuntime; onChange(): void }) {
  const rows = useTagRows(rt)
  const value = useSearchTag(rt)
  const id = useId()
  if (!rows.length) return null
  return (
    <div className="dr-tags-searchfilter">
      <label htmlFor={id} className="dr-tags-searchfilter__label">
        Tag
      </label>
      <select
        id={id}
        className="dr-input dr-tags-searchfilter__select"
        data-testid="search-tag-filter"
        value={value ?? ''}
        onChange={(e) => {
          rt.searchTag.set(e.target.value || null)
          onChange()
        }}
      >
        <option value="">Any tag</option>
        {rows.map((r) => (
          <option key={r.key} value={r.key}>
            {r.name} ({r.count})
          </option>
        ))}
      </select>
    </div>
  )
}
