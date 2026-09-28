// What canvas-ux's board search panel uses from tags (search by tag): the tag filter control, its state
// and the tag-aware search itself (search.ts). The panel stays canvas-ux's; these are its hooks.

import type { SearchHit } from '@draftroom/board-ops'
import { useId } from 'react'
import { type Atom, atom, type Editor, type TLRecord, useValue } from 'tldraw'
import { useTagRows } from './hooks.ts'
import { boardTags } from './runtime.ts'
import { searchBoardWithTags } from './search.ts'

export { textOfQuery } from './search.ts'

const filters = new WeakMap<Editor, Atom<string | null>>()
/** The search panel's tag filter (a tag key), kept while the panel closes and opens like its query. */
export function searchTag(editor: Editor): Atom<string | null> {
  let a = filters.get(editor)
  if (!a) {
    a = atom<string | null>('dr-search-tag', null)
    filters.set(editor, a)
  }
  return a
}

/** The tag filter, or null when none is set or its tag has gone from the board. */
export function useSearchTag(editor: Editor): string | null {
  const key = useValue('dr-search-tag', () => searchTag(editor).get(), [editor])
  const rows = useTagRows(editor)
  return key !== null && rows.some((r) => r.key === key) ? key : null
}

export function searchWithTags(
  editor: Editor,
  records: readonly TLRecord[],
  query: string,
  opts: { limit: number; tag: string | null },
): SearchHit[] {
  return searchBoardWithTags(records, query, { ...opts, board: boardTags(editor).get() })
}

/** "Tag: Any tag / Research (12) / …" under the type filters; only on boards that have tags. */
export function SearchTagFilter({ editor, onChange }: { editor: Editor; onChange(): void }) {
  const rows = useTagRows(editor)
  const value = useSearchTag(editor)
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
          searchTag(editor).set(e.target.value || null)
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
