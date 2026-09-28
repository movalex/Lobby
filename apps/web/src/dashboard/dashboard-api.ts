// Dashboard calls added by the dashboard-share feature (stars, starred list, duplicate, import). The
// duplicate/import routes belong to the history feature (packages/contracts/src/history.ts); a 404
// from them most likely means that feature is not deployed, and the UI says so.

import {
  HistoryBoardCreated,
  IMPORT_BODY_LIMIT_BYTES,
  ListBoardsWithThumbnailsResponse,
  StarResponse,
} from '@draftroom/contracts'
import type { ApiClient } from '../api/client.ts'
import type { BoardStatus } from '../lib/permissions.ts'

const enc = encodeURIComponent

export { IMPORT_BODY_LIMIT_BYTES }

export function dashboardApi(api: ApiClient) {
  const r = api.request
  return {
    /** M1's board list, with the `starred` flag the dashboard feature adds and `thumbnailVersion`. */
    listBoards: async (
      workspaceId: string,
      query: { status?: BoardStatus; projectId?: string },
      signal?: AbortSignal,
    ) => {
      const params = new URLSearchParams()
      if (query.status) params.set('status', query.status)
      if (query.projectId) params.set('projectId', query.projectId)
      const qs = params.toString() ? `?${params}` : ''
      return (
        await r('GET', `/api/workspaces/${enc(workspaceId)}/boards${qs}`, {
          schema: ListBoardsWithThumbnailsResponse,
          signal,
        })
      ).boards
    },
    starredBoards: async (workspaceId: string, signal?: AbortSignal) =>
      (
        await r('GET', `/api/workspaces/${enc(workspaceId)}/boards/starred`, {
          schema: ListBoardsWithThumbnailsResponse,
          signal,
        })
      ).boards,
    setStar: (boardId: string, starred: boolean) =>
      r(starred ? 'PUT' : 'DELETE', `/api/boards/${enc(boardId)}/star`, { schema: StarResponse }),
    duplicateBoard: (boardId: string, input: { title?: string; keepSharing?: boolean }) =>
      r('POST', `/api/boards/${enc(boardId)}/duplicate`, { body: input, schema: HistoryBoardCreated }),
    /** `archive` is the parsed BoardArchiveV1 JSON (validated by the server, which treats it as untrusted). */
    importBoard: (workspaceId: string, archive: unknown, query: { title?: string; projectId?: string }) => {
      const params = new URLSearchParams()
      if (query.title) params.set('title', query.title)
      if (query.projectId) params.set('projectId', query.projectId)
      const qs = params.toString() ? `?${params}` : ''
      return r('POST', `/api/workspaces/${enc(workspaceId)}/boards/import${qs}`, {
        body: archive,
        schema: HistoryBoardCreated,
      })
    },
  }
}

export type DashboardApi = ReturnType<typeof dashboardApi>
