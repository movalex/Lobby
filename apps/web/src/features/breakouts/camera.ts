// OWNER: WS4 (wave V, breakouts). The camera moves of breakouts, through the workshops feature's camera helpers (import
// only): "Go to my frame" (on start, when moved, and from the chip), a facilitator's "Join group", and following the
// facilitator after a group summon (the workshops "Gather everyone" follow, with R2-04's readable camera on a phone).
// Nothing here writes to the board or changes presence; a click on the canvas ends a follow as for any summon.
import type { SummonScreen } from '@draftroom/contracts'
import type { LobbyCanvas } from '../../canvas/api/index.ts'
import { followSidOf } from '../workshops/follow.ts'
import {
  readableFollowCamera,
  startFollowing,
  stopFollowing,
  zoomToBounds,
} from '../workshops/ported/camera.ts'
import { frameElementId } from './model.ts'

const live = (canvas: Pick<LobbyCanvas, 'get'>, id: string) => {
  const el = canvas.get(id) as { isDeleted?: boolean } | undefined
  return !!el && !el.isDeleted
}

/** Whether the group's frame is still on the board. */
export const frameExists = (canvas: Pick<LobbyCanvas, 'get'>, frameRef: string): boolean =>
  live(canvas, frameElementId(frameRef))

/** Fits the camera to a group's frame (never closer than 100%); false when the frame is gone. */
export function goToFrame(canvas: LobbyCanvas, frameRef: string, opts: { animate?: boolean } = {}): boolean {
  const id = frameElementId(frameRef)
  if (!live(canvas, id)) return false
  const b = canvas.bounds(id)
  if (!b) return false
  stopFollowing(canvas)
  zoomToBounds(canvas, b, { inset: 48, maxZoom: 1, ...(opts.animate === false ? { animate: false } : {}) })
  return true
}

/** The session to follow for a Lobby user id: a streaming tab first (../workshops/follow.ts), else any of theirs. */
export function sessionOf(canvas: LobbyCanvas, userId: string): string | null {
  return (
    followSidOf(canvas.presence.peers(), userId) ??
    canvas.collaborators().find((c) => c.uid === userId)?.sid ??
    null
  )
}

const RETRIES = 10
const RETRY_MS = 300

/**
 * Follows `userId`'s view (a group summon). Their presence may come a moment after the event, so it is looked for a
 * few times. Calls `done(true)` once following, `done(false)` when they never show up here. Returns a cancel.
 */
export function followPerson(
  canvas: LobbyCanvas,
  userId: string,
  screen: SummonScreen | undefined,
  done: (following: boolean) => void,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let cancelled = false
  const attempt = (n: number) => {
    if (cancelled) return
    const sid = sessionOf(canvas, userId)
    if (sid) {
      done(startFollowing(canvas, sid, { camera: readableFollowCamera(screen) }))
      return
    }
    if (n >= RETRIES) return done(false)
    timer = setTimeout(() => attempt(n + 1), RETRY_MS)
  }
  attempt(0)
  return () => {
    cancelled = true
    if (timer) clearTimeout(timer)
  }
}
