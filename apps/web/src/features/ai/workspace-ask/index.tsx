// OWNER: W8 (wave M, M8-2). The 'ai-workspace-ask' feature on the Excalidraw board page: Ask across boards.
// - onMount sets what askWorkspaceAvailable() reads (./client.ts setWorkspaceAskContext): the board's workspace,
//   the caller's role there (Me.workspaces) and the board's AI status, which the AI feature already reads and keeps
//   current (features/ai/ported/runtime.ts aiStatus: its idle first read, the open-state seed, every change of role,
//   board status or AI setting). Nothing is fetched here, so the board's open burst is unchanged; until that status
//   is known, Ask across boards is not offered. The cleanup sets the context back to null.
// - The palette command 'ai.askWorkspace' ("Ask all boards"), offered while askWorkspaceAvailable() and the board's
//   own Ask ('ai.ask') may run: it opens the Ask panel on All boards ('ai.ask' with `scope: 'all'`, and the
//   palette's question when it passes one).
// - Dev-auth builds also get the e2e hook (./dev-hook.ts).
import { type CanvasFeature, type CanvasFeatureContext, commandRunnable } from '../../../canvas/api/index.ts'
import { subscribeValue } from '../../../lib/signals.ts'
import { runCommand } from '../../canvas-ux/ported/commands.ts'
import { aiStatus } from '../ported/runtime.ts'
import { AI_ASK_WORKSPACE_COMMAND_ID, askWorkspaceAvailable, setWorkspaceAskContext } from './client.ts'
import { installWorkspaceAskDevHook } from './dev-hook.ts'

/** The board's Ask (features/ai/ported/public.ts AI_COMMAND_IDS.ask), which holds the This board / All boards switch. */
const ASK_COMMAND_ID = 'ai.ask'

/** The context of this board page, now. */
function contextOf(ctx: CanvasFeatureContext) {
  return {
    workspaceId: ctx.workspace.id,
    workspaceRole: ctx.me.workspaces.find((w) => w.id === ctx.workspace.id)?.role ?? null,
    ai: aiStatus(ctx.canvas).get(),
  }
}

/** The args 'ai.askWorkspace' passes on: All boards, and the question when the caller gave one. */
export function askAllArgs(args: unknown): { scope: 'all'; question?: string } {
  const q =
    typeof args === 'object' && args !== null && typeof (args as { question?: unknown }).question === 'string'
      ? ((args as { question: string }).question.trim() as string)
      : ''
  return q ? { scope: 'all', question: q } : { scope: 'all' }
}

const askRunnable = (ctx: CanvasFeatureContext): boolean => {
  const ask = ctx.registries.commands.get(ASK_COMMAND_ID)
  return !!ask && commandRunnable(ask, ctx)
}

export const feature: CanvasFeature = {
  id: 'ai-workspace-ask',
  commands: [
    {
      id: AI_ASK_WORKSPACE_COMMAND_ID,
      label: 'Ask all boards',
      group: 'AI',
      keywords: ['ai', 'question', 'answer', 'workspace', 'across', 'every board', 'decide'],
      // a viewer may ask, as on the board itself
      readOnlyAllowed: true,
      enabled: (ctx) => askWorkspaceAvailable() && askRunnable(ctx),
      run: (ctx, source, args) => {
        if (!askWorkspaceAvailable()) return
        runCommand(ctx, ASK_COMMAND_ID, source, askAllArgs(args))
      },
    },
  ],
  onMount(ctx) {
    const offHook = installWorkspaceAskDevHook(ctx)
    setWorkspaceAskContext(contextOf(ctx))
    // the AI status changes (it is read once the board is idle, and again on every change): follow it
    const offStatus = subscribeValue(aiStatus(ctx.canvas), () => setWorkspaceAskContext(contextOf(ctx)))
    return () => {
      offStatus()
      offHook()
      setWorkspaceAskContext(null)
    }
  },
}
