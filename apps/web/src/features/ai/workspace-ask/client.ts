// OWNER: W8 (wave M, M8-2; the availability rule, the request and the test hook frozen by the wave M foundation).
// Ask across boards, the web side: POST /api/workspaces/:wid/ai/ask (@draftroom/contracts ai.ts
// WorkspaceAskRequest → WorkspaceAskResponse).
//
// Consumed by W4's Ask panel ('This board / All boards', M4-6) and, through the command registry only, by W3's
// palette ('ai.askWorkspace'). Frozen:
//   askWorkspaceAvailable(): boolean     workspaceAskAllowed(the context the feature set) and no 404 seen for that
//                                        workspace in this tab. The rule (workspaceAskAllowed): a workspace owner,
//                                        admin or member (Me.workspaces; a workspace guest or a name-only guest, who
//                                        has no role there, never), and the workspace's AI on (the board's AiStatus
//                                        settings.workspaceDefault; null settings, for AI off or not configured for
//                                        Lobby and for name-only guests, is off).
//   subscribeWorkspaceAsk(fn): () => void   fn runs whenever the answer may have changed (re-read it then).
//   askWorkspace(question, opts): Promise<WorkspaceAskResult>   rejects WorkspaceAskUnavailableError
//                                        ('unavailable') without a request when not available; a 404 from the api
//                                        (an api without the route, or the route's own 404) turns availability off
//                                        for that workspace in this tab and rejects the same. Other failures reject
//                                        with the api client's ApiError.
//   setWorkspaceAskContext(context | null)   the feature (W8) sets it from its context and the board's AI status in
//                                        onMount, and null in its cleanup.
//
// The foundation sets no context (no AI status is read yet), so on the board page askWorkspaceAvailable() stays
// false and nothing is sent until W8 sets it. Dev-auth builds (e2e) also get window.__lobbyWorkspaceAsk
// (./dev-hook.ts, through e2e/excalidraw/ai-kit.ts forceWorkspaceAsk): it forces availability on or off for the board's
// workspace, so W4's specs can show the switch before W8 lands, and the 404 rule still applies to a forced 'on'.

import { type AiStatus, WorkspaceAskResponse, workspaceAskPath } from '@draftroom/contracts'
import type { WorkspaceRole } from '@draftroom/permissions'
import { api, isApiError } from '../../../api/client.ts'

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

/** What availability is decided from: the board page's workspace, the caller's role there and the board's AI status. */
export interface WorkspaceAskContext {
  workspaceId: string
  /** The caller's role in the workspace (Me.workspaces), or null when they have none (a name-only guest). */
  workspaceRole: WorkspaceRole | null
  /** The board's AI status (GET /api/boards/:bid/ai, or takeOpenState(boardId, 'ai')), null while not known. */
  ai: AiStatus | null
}

const ASKING_ROLES: ReadonlySet<WorkspaceRole> = new Set<WorkspaceRole>(['owner', 'admin', 'member'])

/** The frozen rule, pure: a workspace owner, admin or member, with the workspace's AI on. */
export function workspaceAskAllowed(context: WorkspaceAskContext | null): boolean {
  if (!context?.workspaceId) return false
  if (context.workspaceRole === null || !ASKING_ROLES.has(context.workspaceRole)) return false
  return context.ai?.settings?.workspaceDefault === true
}

let context: WorkspaceAskContext | null = null
/** Dev-auth only (./dev-hook.ts): a forced answer for one workspace. */
let forced: { workspaceId: string; on: boolean } | null = null
/** Workspaces whose ask answered 404 in this tab. */
const missing = new Set<string>()
const listeners = new Set<() => void>()

function changed(): void {
  for (const fn of [...listeners]) {
    try {
      fn()
    } catch {
      // a listener's failure is its own
    }
  }
}

function currentWorkspace(): string | null {
  return forced?.workspaceId ?? context?.workspaceId ?? null
}

export function setWorkspaceAskContext(next: WorkspaceAskContext | null): void {
  context = next ? { ...next } : null
  changed()
}

export function subscribeWorkspaceAsk(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function askWorkspaceAvailable(): boolean {
  const wid = currentWorkspace()
  if (!wid || missing.has(wid)) return false
  if (forced) return forced.on
  return workspaceAskAllowed(context)
}

export async function askWorkspace(
  question: string,
  opts: { acknowledged?: boolean; signal?: AbortSignal } = {},
): Promise<WorkspaceAskResult> {
  const wid = currentWorkspace()
  if (!wid || !askWorkspaceAvailable()) throw new WorkspaceAskUnavailableError()
  const body: { question: string; acknowledged?: boolean } = { question }
  if (opts.acknowledged !== undefined) body.acknowledged = opts.acknowledged
  try {
    return await api.request('POST', workspaceAskPath(wid), {
      body,
      schema: WorkspaceAskResponse,
      signal: opts.signal,
    })
  } catch (e) {
    if (isApiError(e) && e.status === 404) {
      missing.add(wid)
      changed()
      throw new WorkspaceAskUnavailableError()
    }
    throw e
  }
}

/** Dev-auth hook and tests only: force availability for `workspaceId` (null puts the rule back). */
export function forceWorkspaceAskForTests(on: boolean | null, workspaceId?: string): void {
  forced = on === null || !workspaceId ? null : { workspaceId, on }
  changed()
}

/** Tests only: forget the context, a forced answer, the 404s and the listeners. */
export function resetWorkspaceAskForTests(): void {
  context = null
  forced = null
  missing.clear()
  listeners.clear()
}
