// OWNER: 3f (workshops; wave N, WS3's file, landed by the wave N foundation as the frozen gate and ids). Emoji
// reactions on sticky notes: `customData.lobby['react:<code>:<uid>'] = true` (canvas-schema reactions.ts;
// CONTRACTS_REV 13, REACTIONS_REV). Reacting is offered only in a room whose `contracts` frame names REACTIONS_REV
// or later, so a web deployed before the sync (or after a sync rollback) never sends a key the room refuses;
// stored reactions render read-only at any revision. WS3 builds the row, the toggle (a skipUndo transact of the
// writer's own key), the names and the CSV column on these.
import { REACTIONS_REV } from '@draftroom/canvas-schema/protocol'
import type { LobbyCanvas } from '../../../canvas/api/index.ts'

/** The selection bar item WS3 registers (registries SelectionBarItemSpec id). */
export const REACTIONS_SELECTION_ITEM_ID = 'reactions'
/** The palette command WS3 registers (contracts usage.ts PALETTE_COMMAND_IDS; pending until then). */
export const REACTIONS_COMMAND_ID = 'reactions.react'

/** Whether this room takes reactions (its contracts revision is REACTIONS_REV or later). Null rev: not known, no. */
export function reactionsRoom(rev: number | null): boolean {
  return rev !== null && rev >= REACTIONS_REV
}

/**
 * Whether this tab may offer reacting: the room takes reactions and the canvas is not read-only (editors, owners
 * and name-only guests who can edit; viewers and commenters see the row read-only). Reactive (both reads are).
 */
export function reactionsOffered(canvas: Pick<LobbyCanvas, 'room' | 'readOnly'>): boolean {
  if (!reactionsRoom(canvas.room.contractsRev())) return false
  return !canvas.readOnly()
}
