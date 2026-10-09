// Wave L (W1, L1-4): the api's copy of Lobby's colour tables (src/features/ai/colors.ts, kept out of the
// engine-loading board-ops/elements import) stays equal to board-ops', name for name.

import {
  noteColorName as boardNoteColorName,
  strokeColorName as boardStrokeColorName,
  LOBBY_COLOR_NAMES,
  LOBBY_PALETTE,
} from '@draftroom/board-ops/elements'
import { AI_COLOR_NAMES } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import { NOTE_FILLS, noteColorName, STROKES, strokeColorName } from '../../../src/features/ai/colors.ts'

describe("the AI index's colour names", () => {
  it('are board-ops’ 13 names with the same note fills and strokes', () => {
    expect([...AI_COLOR_NAMES]).toEqual([...LOBBY_COLOR_NAMES])
    for (const name of LOBBY_COLOR_NAMES) {
      expect(NOTE_FILLS[name], name).toBe(LOBBY_PALETTE[name].noteFill)
      expect(STROKES[name], name).toBe(LOBBY_PALETTE[name].solid)
    }
  })

  it('read every fill and stroke as board-ops does, unknown values as null', () => {
    const values = [
      ...LOBBY_COLOR_NAMES.flatMap((n) => [
        LOBBY_PALETTE[n].noteFill,
        LOBBY_PALETTE[n].solid,
        LOBBY_PALETTE[n].fill,
      ]),
      '#F6C453',
      ' #e03131 ',
      '#123456',
      'transparent',
      null,
      42,
    ]
    for (const v of values) {
      expect(noteColorName(v), String(v)).toBe(boardNoteColorName(v))
      expect(strokeColorName(v), String(v)).toBe(boardStrokeColorName(v))
    }
  })
})
