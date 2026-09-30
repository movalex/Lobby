// The board's tag rows (every tag with its count) for UI that may stay open while people work: the Tags
// panel, the "Show only" bar, the search panel's tag filter, the picker. Counting scans every shape, so
// it runs at most every 200 ms while the document changes (a drag changes it every frame), like
// canvas-ux's board search, and re-renders only when a row actually changed.

import { useEffect, useState } from 'react'
import type { Editor } from 'tldraw'
import type { BoardTagRow } from './model.ts'
import { boardTagRowsOf } from './runtime.ts'
import { sameRows } from './tag-core.ts'

export const ROWS_THROTTLE_MS = 200

export { sameRows } from './tag-core.ts'

export function useTagRows(editor: Editor): BoardTagRow[] {
  const [rows, setRows] = useState(() => boardTagRowsOf(editor).get())
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const update = () => {
      timer = null
      const next = boardTagRowsOf(editor).get()
      setRows((prev) => (sameRows(prev, next) ? prev : next))
    }
    const stop = editor.store.listen(
      () => {
        if (timer === null) timer = setTimeout(update, ROWS_THROTTLE_MS)
      },
      { scope: 'document' },
    )
    update()
    return () => {
      stop()
      if (timer !== null) clearTimeout(timer)
    }
  }, [editor])
  return rows
}
