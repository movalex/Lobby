// OWNER: W8 (wave M, M8-2; landed by the wave M foundation). Dev-auth builds only (the e2e build):
// `window.__lobbyWorkspaceAsk`, so specs can force Ask across boards on (or off) for the board's workspace before the
// feature reads a real context, and ask through the real client (e2e/excalidraw/ai-kit.ts fakeWorkspaceAsk answers
// the request). Never installed in a normal build.
import type { CanvasFeatureContext } from '../../../canvas/api/index.ts'
import { DEV_AUTH_ENABLED } from '../../../lib/identity.ts'
import { askWorkspace, askWorkspaceAvailable, forceWorkspaceAskForTests } from './client.ts'
import type { WorkspaceAskDevHook } from './dev-hook-types.ts'

export function installWorkspaceAskDevHook(ctx: CanvasFeatureContext): () => void {
  if (!DEV_AUTH_ENABLED) return () => {}
  const hook: WorkspaceAskDevHook = {
    force(on) {
      forceWorkspaceAskForTests(on, ctx.workspace.id)
    },
    available: () => askWorkspaceAvailable(),
    async ask(question, acknowledged) {
      try {
        const opts = acknowledged === undefined ? {} : { acknowledged }
        return { ok: true, answer: await askWorkspace(question, opts) }
      } catch (e) {
        const err = e as { code?: unknown; name?: unknown; message?: unknown }
        return {
          ok: false,
          code: typeof err.code === 'string' ? err.code : String(err.name ?? 'Error'),
          message: String(err.message ?? ''),
        }
      }
    },
  }
  window.__lobbyWorkspaceAsk = hook
  return () => {
    if (window.__lobbyWorkspaceAsk === hook) delete window.__lobbyWorkspaceAsk
    forceWorkspaceAskForTests(null)
  }
}
