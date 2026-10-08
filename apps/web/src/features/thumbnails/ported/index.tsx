// OWNER: 3e (docs/EXCALIDRAW-CONTRACTS.md §7.2). The ported 'thumbnails' feature on the Excalidraw board page:
// board thumbnails for the dashboard card (the port of ../index.tsx). An editor's client renders a small
// image of the board a few seconds after their changes settle (the start view, else the first frame, else
// the content: ../plan.ts), sends it 20 s after they settle (at most every 2 minutes), or when they leave.
// Viewers, commenters and guests never capture or upload; the api refuses them too.
//
// Nothing here is visible: an overlay layer that stays in focus mode keeps the capture running for the
// current role and exposes its state on a hidden element (`thumbnail-capture`) for tests and debugging.
import { useEffect, useState } from 'react'
import type { CanvasFeature, CanvasFeatureContext } from '../../../canvas/api/index.ts'
import { can } from '../../../lib/permissions.ts'
import type { CaptureStatus } from '../scheduler.ts'
import { startCapture } from './capture.ts'

/** Editors and owners who are real members of the board's workspace (not guests). */
export function mayCapture(ctx: Pick<CanvasFeatureContext, 'role' | 'board' | 'me' | 'workspace'>): boolean {
  const workspaceRole = ctx.me.workspaces.find((w) => w.id === ctx.workspace.id)?.role
  return can(ctx.role, 'edit', ctx.board.status) && workspaceRole !== undefined && workspaceRole !== 'guest'
}

function ThumbnailCapture({ ctx }: { ctx: CanvasFeatureContext }) {
  const { canvas, registries, events } = ctx
  const boardId = ctx.board.id
  const enabled = mayCapture(ctx)
  const [status, setStatus] = useState<CaptureStatus>({ state: enabled ? 'idle' : 'off' })
  useEffect(() => {
    if (!enabled) {
      setStatus({ state: 'off' })
      return
    }
    setStatus({ state: 'idle' })
    // Merged: the last version and render time stay readable while later steps run.
    return startCapture(canvas, boardId, {
      menusOpen: () => registries.menusOpen.call(),
      onStatus: (s) => setStatus((prev) => ({ ...prev, ...s })),
      events, // K6-3: someone else's accepted upload
    })
  }, [canvas, registries, boardId, enabled, events])
  return (
    <span
      hidden
      data-testid="thumbnail-capture"
      data-state={status.state}
      data-version={status.version ?? undefined}
      data-render-ms={status.renderMs}
      data-renderer={status.renderer}
    />
  )
}

export const feature: CanvasFeature = {
  id: 'thumbnails',
  overlays: [
    { id: 'thumbnails.capture', layer: 'screen', order: 0, focusMode: 'show', component: ThumbnailCapture },
  ],
}
