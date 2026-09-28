// Feature module: thumbnails (docs/WAVE3-CONTRACTS.md). Captures a small image of the board for the
// dashboard card: an editor's client renders it a few seconds after their changes settle and sends it
// 20 s after they settle (at most every 2 minutes), or when they leave (tab hidden, page closed, back
// to the dashboard). Viewers, commenters and guests never capture or upload; the api refuses them too.
// See scheduler.ts (when), render.ts (what and how), upload.ts (sending).
//
// Nothing here is visible: the overlay only keeps the capture running for the current role, and exposes
// its state on a hidden element (`thumbnail-capture`) for tests and debugging.

import { useEffect, useState } from 'react'
import { can } from '../../lib/permissions.ts'
import type { BoardFeature, FeatureContext } from '../types.ts'
import { startCapture } from './capture.ts'
import type { CaptureStatus } from './scheduler.ts'

/** Editors and owners who are real members of the board's workspace (not guests). */
export function mayCapture(ctx: Pick<FeatureContext, 'role' | 'board' | 'me' | 'workspace'>): boolean {
  const workspaceRole = ctx.me.workspaces.find((w) => w.id === ctx.workspace.id)?.role
  return can(ctx.role, 'edit', ctx.board.status) && workspaceRole !== undefined && workspaceRole !== 'guest'
}

function ThumbnailCapture({ ctx }: { ctx: FeatureContext }) {
  const { editor } = ctx
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
    return startCapture(editor, boardId, { onStatus: (s) => setStatus((prev) => ({ ...prev, ...s })) })
  }, [editor, boardId, enabled])
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

export const thumbnailsFeature: BoardFeature = { id: 'thumbnails', Overlay: ThumbnailCapture }
