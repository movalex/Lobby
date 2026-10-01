/**
 * How a server op lands on the server copy a client holds (docs/EXCALIDRAW-MIGRATION.md §2.4.2): a `c` op
 * replaces the copy; a `p` op overlays its groups mechanically (canvas-schema groups.ts `overlayPatch`:
 * the `path` unit whole, `customData.lobby` per key, `boundElements` by id, `lobbyServer` replaced) and
 * sets the server-owned `version`, `versionNonce` and `updated`.
 *
 * NODE-SAFE (CONTRACTS.md).
 */
import { overlayPatch } from '@draftroom/canvas-schema/groups'
import type { ServerOp } from '@draftroom/canvas-schema/protocol'
import type { SceneElement } from '../types.ts'

type ServerPatch = Extract<ServerOp, { k: 'p' }>

export function overlayPatchOp(cur: SceneElement, op: ServerPatch): SceneElement {
  const next = overlayPatch(cur as Readonly<Record<string, unknown>>, {
    g: op.g,
    c: op.c,
    b: op.b,
    lobbyServer: op.lobbyServer,
  }) as Record<string, unknown>
  next.version = op.v
  next.versionNonce = op.vn
  next.updated = op.updated
  return next as SceneElement
}
