/**
 * OWNER: 3c (people). Following another session's view (their presence `view`, §2.7) and the
 * `followChanged` event. Stubs until 3c lands them.
 */
import type { LobbyCanvasEventMap, LobbyFollow } from '../lobby-canvas.ts'
import { NotImplementedError, notImplemented } from '../owners.ts'
import type { PartDeps } from './types.ts'

export interface FollowPart {
  readonly follow: LobbyFollow
  /** subscribes to `followChanged` */
  onFollowChanged(listener: LobbyCanvasEventMap['followChanged']): () => void
}

export function createFollowPart(_deps: PartDeps): FollowPart {
  return {
    follow: {
      current: notImplemented('3c', 'follow.current'),
      start: notImplemented('3c', 'follow.start'),
      stop: notImplemented('3c', 'follow.stop'),
    },
    onFollowChanged: () => {
      throw new NotImplementedError('3c', 'on:followChanged')
    },
  }
}
