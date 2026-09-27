// "Gather everyone": who should follow whom when a summon event arrives. tldraw's follow API
// (`editor.startFollowingUser(TLUserId)`) follows a collaborator's PRESENCE, whose `userId` is the
// tldraw user id (`user:<draftroom id>`, see BoardPage's users store), so the summoner has to be
// found among the live collaborators first.

import type { WorkshopSummonEvent } from '@draftroom/contracts'

const bare = (id: string) => (id.startsWith('user:') ? id.slice('user:'.length) : id)

/** Whether this browser should start following for `event` (never the summoner's own tabs). */
export function summonApplies(event: WorkshopSummonEvent, selfUserId: string): boolean {
  if (event.userId === selfUserId) return false
  return event.targetUserId === null || event.targetUserId === selfUserId
}

/** The presence user id to follow for a Draftroom user id, or null when they are not connected here. */
export function followIdFor<T extends string>(
  collaborators: readonly { userId: T; lastActivityTimestamp?: number | null }[],
  userId: string,
): T | null {
  let best: { userId: T; lastActivityTimestamp?: number | null } | null = null
  for (const c of collaborators) {
    if (bare(c.userId) !== userId) continue
    if (!best || (c.lastActivityTimestamp ?? 0) > (best.lastActivityTimestamp ?? 0)) best = c
  }
  return best ? best.userId : null
}

/**
 * A click counts as "moving" (which ends following, FAC-02): a primary-button press on the canvas.
 * Wheel, pinch, pan and camera moves already stop following inside tldraw (Editor.setCamera,
 * wheel/pinch handlers); a plain click does not, so we add it.
 */
export function isCanvasPress(info: { type: string; name: string; button?: number }): boolean {
  return info.type === 'pointer' && info.name === 'pointer_down' && (info.button ?? 0) === 0
}
