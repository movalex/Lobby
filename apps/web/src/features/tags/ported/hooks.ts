// The board's tag rows (every tag with its count) for UI that may stay open while people work: the Tags
// panel, the "Show only" bar, the search panel's tag filter. Counting scans every element, so it runs at
// most every 200 ms while the board changes (a drag changes it every frame) and re-renders only when a row
// actually changed. The port of ../hooks.ts onto the canvas's change stream and lb_doc.

import { useEffect, useState } from 'react'
import { sameRows } from '../tag-core.ts'
import type { BoardTagRow } from './model.ts'
import type { TagsRuntime } from './runtime.ts'

export const ROWS_THROTTLE_MS = 200

export function useTagRows(rt: TagsRuntime): BoardTagRow[] {
  const [rows, setRows] = useState(() => rt.rows.get())
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const update = () => {
      timer = null
      const next = rt.rows.get()
      setRows((prev) => (sameRows(prev, next) ? prev : next))
    }
    const schedule = () => {
      if (timer === null) timer = setTimeout(update, ROWS_THROTTLE_MS)
    }
    const offs = [rt.canvas.on('change', schedule), rt.canvas.on('docChanged', schedule)]
    update()
    return () => {
      for (const off of offs) off()
      if (timer !== null) clearTimeout(timer)
    }
  }, [rt])
  return rows
}
