// OWNER: W8 (wave M, M8-2; a stub landed by the wave M foundation). Ask across boards, the web side:
// POST /api/workspaces/:wid/ai/ask (@draftroom/contracts ai.ts WorkspaceAskRequest → WorkspaceAskResponse).
//
// Consumed by W4's Ask panel ('This board / All boards', M4-6) and, through the command registry only, by W3's
// palette ('ai.askWorkspace'). Frozen signatures:
//   askWorkspaceAvailable(): boolean           a member who is not a guest, with the workspace's AI on, on an api
//                                              that has the route (W8 decides from the feature's context)
//   askWorkspace(question): Promise<WorkspaceAskResult>   rejects with WorkspaceAskUnavailableError ('unavailable')
//                                              when it is not available (and on an api without the route: 404)
//
// The stub: never available, and every ask rejects 'unavailable' without a request. So the switch stays hidden
// and nothing changes until W8 implements it.

import type { WorkspaceAskResponse } from '@draftroom/contracts'

/** What an ask answers: the contract's response (citations name boards and element ids for elementsLink). */
export type WorkspaceAskResult = WorkspaceAskResponse

/** The palette command W8 registers (contracts usage.ts PALETTE_COMMAND_IDS). */
export const AI_ASK_WORKSPACE_COMMAND_ID = 'ai.askWorkspace'

export class WorkspaceAskUnavailableError extends Error {
  readonly code = 'unavailable' as const
  constructor() {
    super('unavailable')
    this.name = 'WorkspaceAskUnavailableError'
  }
}

export function askWorkspaceAvailable(): boolean {
  return false
}

export async function askWorkspace(
  _question: string,
  _opts: { acknowledged?: boolean; signal?: AbortSignal } = {},
): Promise<WorkspaceAskResult> {
  throw new WorkspaceAskUnavailableError()
}
