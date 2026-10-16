// A board's title (CreateBoardInput, and every path that names a new board: a restore's typed title and the title a
// backup's manifest carries). Kept apart so board-backup.ts can use it without importing ./index.ts.

import { z } from 'zod'
import { cleanDisplayText } from './outside.ts'

export const BOARD_TITLE_MAX = 120

/** A board's title as board creation takes it. */
export const BoardTitle = z.string().trim().min(1).max(BOARD_TITLE_MAX)

/**
 * A title that came from a file or another product, made a board title: cleanDisplayText (NUL, control, bidi and
 * zero-width characters removed, spaces folded), clipped to whole characters within BOARD_TITLE_MAX, then BoardTitle;
 * null when nothing is left.
 */
export function cleanBoardTitle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  let out = ''
  for (const ch of cleanDisplayText(raw)) {
    if (out.length + ch.length > BOARD_TITLE_MAX) break
    out += ch
  }
  const checked = BoardTitle.safeParse(out)
  return checked.success ? checked.data : null
}
