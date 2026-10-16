// OWNER: WS5 (wave T). The board's members by uid, as the assignee lanes name them, kept per canvas so that an export
// (which draws synchronously) names the lanes as the board shows them. Filled by the overlay when a timeline groups by
// assignee; null until then (the lane says "Assigned").
import type { LobbyCanvas } from '../../canvas/api/index.ts'

const known = new WeakMap<LobbyCanvas, ReadonlyMap<string, string>>()

export function setMemberNames(canvas: LobbyCanvas, names: ReadonlyMap<string, string>): void {
  known.set(canvas, names)
}

export const memberNamesOf = (canvas: LobbyCanvas): ReadonlyMap<string, string> | null =>
  known.get(canvas) ?? null
