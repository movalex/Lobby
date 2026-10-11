// OWNER: 3f (workshops; wave N, WS3). The frozen gate of the reaction row (./note-reactions.ts).
import { REACTIONS_REV } from '@draftroom/canvas-schema/protocol'
import { PALETTE_COMMAND_IDS, PENDING_PALETTE_COMMAND_IDS } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import {
  REACTIONS_COMMAND_ID,
  REACTIONS_SELECTION_ITEM_ID,
  reactionsOffered,
  reactionsRoom,
} from './note-reactions.ts'

const canvasAt = (rev: number | null, readOnly = false) => ({
  room: { contractsRev: () => rev },
  readOnly: () => readOnly,
})

describe('reactions are offered only where the room takes them', () => {
  it('a room below 13 (the deployed rev 12), an unknown revision: not offered', () => {
    expect(REACTIONS_REV).toBe(13)
    for (const rev of [null, 10, 11, 12]) {
      expect(reactionsRoom(rev), String(rev)).toBe(false)
      expect(reactionsOffered(canvasAt(rev)), String(rev)).toBe(false)
    }
  })

  it('a rev-13 room: offered to a tab that can edit, never to a read-only one (viewers, commenters)', () => {
    expect(reactionsOffered(canvasAt(13))).toBe(true)
    expect(reactionsOffered(canvasAt(14))).toBe(true)
    expect(reactionsOffered(canvasAt(13, true))).toBe(false)
  })

  it('the frozen ids: the selection bar item and the palette command (pending until WS3 registers it)', () => {
    expect(REACTIONS_SELECTION_ITEM_ID).toBe('reactions')
    expect(PALETTE_COMMAND_IDS as readonly string[]).toContain(REACTIONS_COMMAND_ID)
    expect(PENDING_PALETTE_COMMAND_IDS as readonly string[]).toContain(REACTIONS_COMMAND_ID)
  })
})
