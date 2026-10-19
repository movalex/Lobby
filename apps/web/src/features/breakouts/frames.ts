// OWNER: WS4 (wave V, breakouts). Where the groups work: the frames selected on the board, or "Make N frames" (the
// facilitator's own client creates them in ONE canvas.transact, one undo step, as ordinary frames named "Group 1" …,
// tagged with the create-only `customData.lobby.kind` 'breakout-frame': harmless to every reader since rev 11), placed
// in free space beside what is on the board. Nothing else is written.
import { LIVE_ELEMENT_KINDS } from '@draftroom/contracts'
import type { CanvasElement, LobbyCanvas } from '../../canvas/api/index.ts'
import { obstaclesOf } from '../workshops/ported/vote-board.ts'
import { placeBeside } from '../workshops/results-plan.ts'
import { framesPlan, groupNameOf } from './model.ts'

const isFrame = (el: CanvasElement | undefined): el is CanvasElement =>
  !!el && el.type === 'frame' && !(el as { isDeleted?: boolean }).isDeleted

/** The selected frames, top to bottom then left to right (Group 1 is the top-left one). */
export function selectedFrames(canvas: Pick<LobbyCanvas, 'selection' | 'get'>): CanvasElement[] {
  return canvas.selection
    .map((id) => canvas.get(id))
    .filter(isFrame)
    .sort((a, b) => Math.round(a.y - b.y) || a.x - b.x)
}

/** The groups for the selected frames (their names, else "Group n"). */
export const groupsFromFrames = (frames: readonly CanvasElement[]) =>
  frames.map((f, i) => ({
    name: groupNameOf((f as { name?: string | null }).name, i + 1),
    frameId: `shape:${f.id}`,
  }))

/** A fresh element id (ELEMENT_ID_PATTERN: letters and digits). */
function newElementId(): string {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  return `bk${Array.from(bytes, (b) => (b % 36).toString(36)).join('')}`
}

/** "Make N frames": N empty frames in free space, as one undo step; returns the groups for them. */
export function makeFrames(canvas: LobbyCanvas, n: number): { name: string; frameId: string }[] {
  const plan = framesPlan(n)
  const at = placeBeside({ w: plan.width, h: plan.height }, null, obstaclesOf(canvas))
  const made = plan.frames.map((f) => ({ ...f, id: newElementId() }))
  canvas.transact('breakout frames', (tx) => {
    for (const f of made)
      tx.create('frame', {
        id: f.id,
        x: Math.round(at.x + f.x),
        y: Math.round(at.y + f.y),
        width: f.w,
        height: f.h,
        name: f.name,
        customData: { lobby: { kind: LIVE_ELEMENT_KINDS.breakoutFrame } },
      })
  })
  return made.map((f) => ({ name: f.name, frameId: `shape:${f.id}` }))
}
