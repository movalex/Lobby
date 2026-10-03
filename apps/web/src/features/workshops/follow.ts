// "Gather everyone": who should follow whom when a summon event arrives. tldraw's follow API
// (its startFollowingUser(TLUserId)) follows a collaborator's PRESENCE, whose `userId` is the
// tldraw user id (`user:<draftroom id>`, see BoardPage's users store), so the summoner has to be
// found among the live collaborators first.

import type { WorkshopSummonEvent } from '@draftroom/contracts'
import type { RemoteCursor } from '../../canvas/api/index.ts'

const bare = (id: string) => (id.startsWith('user:') ? id.slice('user:'.length) : id)

/** Whether this browser should start following for `event` (never the summoner's own tabs). */
export function summonApplies(event: WorkshopSummonEvent, selfUserId: string): boolean {
  if (event.userId === selfUserId) return false
  return event.targetUserId === null || event.targetUserId === selfUserId
}

/**
 * The session to follow for a Lobby user id among the room's peers: a tab whose presence streams and is
 * not idle first, then an idle streaming one, and a follower the room does not stream (`streaming: false`,
 * past the cursor cap: no view to follow) last (CR-3C-1); ties keep the first. Null when the user has none.
 */
export function followSidOf(peers: readonly RemoteCursor[], userId: string): string | null {
  const rank = (p: RemoteCursor) => (p.streaming === false ? 0 : p.idle ? 1 : 2)
  let best: RemoteCursor | null = null
  for (const p of peers) {
    if (p.uid !== userId) continue
    if (!best || rank(p) > rank(best)) best = p
  }
  return best ? best.sid : null
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

/**
 * R2-04: the zoom a gathered follower never drops below, unless the leader is further out themselves.
 * tldraw fits the leader's whole viewport into the follower's screen, so a 390 px phone following a
 * 1440 px desktop at 44% landed at 11%, with notes 28 px wide.
 */
export const READABLE_FOLLOW_ZOOM = 0.5
/** Only a follower who would see the board at less than this share of the leader's zoom is changed. */
export const NARROW_FOLLOW_RATIO = 0.6

export interface FollowViewport {
  x: number
  y: number
  w: number
  h: number
}

/**
 * R2-04: the page area a follower should see while gathered. `fitted` is tldraw's (the leader's whole
 * viewport, fitted into `screen`); `leader` is the leader's presence (camera and screen size). When the
 * follower's screen is much narrower than the leader's (a phone following a desktop), it is centred
 * on the leader's view centre at the leader's zoom (at most READABLE_FOLLOW_ZOOM) instead. Null keeps
 * tldraw's view.
 */
export function readableFollowViewport(
  fitted: FollowViewport,
  leader: { camera: { x: number; y: number; z: number }; screenBounds: { w: number; h: number } },
  screen: { w: number; h: number },
): FollowViewport | null {
  const lz = leader.camera.z
  if (!(lz > 0) || !(fitted.w > 0) || !(screen.w > 0) || !(screen.h > 0)) return null
  const fitZ = screen.w / fitted.w
  const target = Math.min(lz, READABLE_FOLLOW_ZOOM)
  if (fitZ >= target * NARROW_FOLLOW_RATIO) return null
  const cx = -leader.camera.x + leader.screenBounds.w / lz / 2
  const cy = -leader.camera.y + leader.screenBounds.h / lz / 2
  const w = screen.w / target
  const h = screen.h / target
  return { x: cx - w / 2, y: cy - h / 2, w, h }
}
