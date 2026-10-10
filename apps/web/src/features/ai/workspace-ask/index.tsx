// OWNER: W8 (wave M, M8-2; registered by the wave M foundation). The 'ai-workspace-ask' feature on the Excalidraw
// board page: Ask across boards. W8 adds the palette command 'ai.askWorkspace' (./client.ts
// AI_ASK_WORKSPACE_COMMAND_ID) and, in onMount, sets what askWorkspaceAvailable() reads (setWorkspaceAskContext from
// ctx.workspace, the caller's Me.workspaces role and the board's AI status; null again in the cleanup).
// The foundation's onMount sets no context, so the switch stays hidden and nothing is sent; it installs only the
// dev-auth hook (./dev-hook.ts, never in a normal build). No command, panel or key yet.
import type { CanvasFeature } from '../../../canvas/api/index.ts'
import { setWorkspaceAskContext } from './client.ts'
import { installWorkspaceAskDevHook } from './dev-hook.ts'

export const feature: CanvasFeature = {
  id: 'ai-workspace-ask',
  onMount(ctx) {
    const offHook = installWorkspaceAskDevHook(ctx)
    return () => {
      offHook()
      setWorkspaceAskContext(null)
    }
  },
}
