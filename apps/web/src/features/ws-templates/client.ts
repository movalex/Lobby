// OWNER: W8 (wave M, M8-4). The web client of workspace templates (@draftroom/contracts ws-templates.ts): list,
// save, remove and start a board from one. Used by the board's "Save as workspace template" (./index.tsx) and by
// the dashboard's template picker (dashboard/TemplateGallery.tsx, its Workspace tab), so it imports nothing of the
// canvas.
//
// Downgrade (an api from before wave M, without the routes): the list answers 404, and that turns workspace
// templates off for that workspace in this tab: the picker hides its Workspace tab and the board command hides.
// A 404 from save, remove or use is the route's own answer (the board or the template is gone), never a latch.

import {
  type AddWorkspaceTemplateInput,
  HistoryBoardCreated,
  ListWorkspaceTemplatesResponse,
  type UseWorkspaceTemplateInput,
  WorkspaceTemplate,
  wsTemplatePath,
  wsTemplatesPath,
  wsTemplateUsePath,
} from '@draftroom/contracts'
import { type ApiClient, api as defaultApi, isApiError } from '../../api/client.ts'

/** The api has no workspace templates (or this caller none in that workspace): the entry points hide. */
export class WsTemplatesUnavailableError extends Error {
  readonly code = 'unavailable' as const
  constructor() {
    super('Workspace templates are not available here.')
    this.name = 'WsTemplatesUnavailableError'
  }
}

type Requester = Pick<ApiClient, 'request'>

/** Workspaces whose template list answered 404 in this tab. */
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

/** Whether a list of this workspace answered 404 in this tab (templates are off for it). */
export const wsTemplatesMissing = (workspaceId: string): boolean => missing.has(workspaceId)

/** fn runs when a workspace is found to have no templates route (re-read wsTemplatesMissing then). */
export function subscribeWsTemplates(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/**
 * The workspace's templates, newest first. A 404 (an api without the route, or no longer a member) latches
 * templates off for the workspace and rejects WsTemplatesUnavailableError; a 403 (a workspace guest) rejects the
 * same without the latch. Other failures are the api client's ApiError.
 */
export async function listWsTemplates(
  workspaceId: string,
  opts: { api?: Requester; signal?: AbortSignal } = {},
): Promise<WorkspaceTemplate[]> {
  if (missing.has(workspaceId)) throw new WsTemplatesUnavailableError()
  try {
    const r = await (opts.api ?? defaultApi).request('GET', wsTemplatesPath(workspaceId), {
      schema: ListWorkspaceTemplatesResponse,
      signal: opts.signal,
    })
    return r.templates
  } catch (e) {
    if (isApiError(e) && e.status === 404) {
      missing.add(workspaceId)
      changed()
      throw new WsTemplatesUnavailableError()
    }
    if (isApiError(e) && e.status === 403) throw new WsTemplatesUnavailableError()
    throw e
  }
}

/** Saves (or renames) `boardId` as a template of the workspace. */
export function saveWsTemplate(
  workspaceId: string,
  input: AddWorkspaceTemplateInput,
  opts: { api?: Requester } = {},
): Promise<WorkspaceTemplate> {
  return (opts.api ?? defaultApi).request('POST', wsTemplatesPath(workspaceId), {
    body: input,
    schema: WorkspaceTemplate,
  })
}

/** Removes the template (the board itself stays as it is). A template already gone counts as removed. */
export async function removeWsTemplate(
  workspaceId: string,
  boardId: string,
  opts: { api?: Requester } = {},
): Promise<void> {
  try {
    await (opts.api ?? defaultApi).request('DELETE', wsTemplatePath(workspaceId, boardId), { schema: null })
  } catch (e) {
    if (isApiError(e) && e.status === 404) return
    throw e
  }
}

/** A new private board from a copy of the template; the caller then opens it. */
export function startFromWsTemplate(
  workspaceId: string,
  boardId: string,
  input: UseWorkspaceTemplateInput,
  opts: { api?: Requester } = {},
): Promise<HistoryBoardCreated> {
  return (opts.api ?? defaultApi).request('POST', wsTemplateUsePath(workspaceId, boardId), {
    body: input,
    schema: HistoryBoardCreated,
  })
}

/** Tests only. */
export function resetWsTemplatesForTests(): void {
  missing.clear()
  listeners.clear()
}
