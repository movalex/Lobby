// Typed calls for the history routes (docs/FEATURES-M2-CONTRACTS.md "history") through the app's
// ApiClient.request (same-origin JSON, responses validated against @draftroom/contracts).

import {
  BoardSnapshot,
  HistoryBoardCreated,
  ListDeletedResponse,
  ListSnapshotsResponse,
  RestoreDeletedResponse,
} from '@draftroom/contracts'
import { type ApiClient, ApiError, errorFromResponse } from '../../api/client.ts'

const enc = encodeURIComponent

export function historyApi(client: ApiClient) {
  const { request } = client
  return {
    listSnapshots: async (boardId: string, signal?: AbortSignal) =>
      (
        await request('GET', `/api/boards/${enc(boardId)}/snapshots`, {
          schema: ListSnapshotsResponse,
          signal,
        })
      ).snapshots,
    saveSnapshot: (boardId: string, name: string) =>
      request('POST', `/api/boards/${enc(boardId)}/snapshots`, { body: { name }, schema: BoardSnapshot }),
    restoreAsNew: (snapshotId: string, title?: string) =>
      request('POST', `/api/snapshots/${enc(snapshotId)}/restore-as-new`, {
        body: title ? { title } : {},
        schema: HistoryBoardCreated,
      }),
    duplicate: (boardId: string, opts: { title?: string; keepSharing?: boolean } = {}) =>
      request('POST', `/api/boards/${enc(boardId)}/duplicate`, { body: opts, schema: HistoryBoardCreated }),
    listDeleted: (boardId: string, signal?: AbortSignal) =>
      request('GET', `/api/boards/${enc(boardId)}/deleted`, { schema: ListDeletedResponse, signal }),
    restoreDeleted: (boardId: string, ids: string[]) =>
      request('POST', `/api/boards/${enc(boardId)}/deleted/restore`, {
        body: { ids },
        schema: RestoreDeletedResponse,
      }),
  }
}

export type HistoryApi = ReturnType<typeof historyApi>

/**
 * The board archive as a file (GET /api/boards/:bid/export). Fetched as a Blob: the response is a
 * download, not something to parse and re-serialize.
 */
export async function fetchBoardArchive(boardId: string, fetchImpl: typeof fetch = fetch): Promise<Blob> {
  let res: Response
  try {
    res = await fetchImpl(`/api/boards/${enc(boardId)}/export`, {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { accept: 'application/json' },
    })
  } catch {
    throw new ApiError('network', 0, 'NETWORK', "Can't reach Draftroom. Check your connection and try again.")
  }
  if (!res.ok) throw await errorFromResponse(res)
  return res.blob()
}

/** Hands a Blob to the browser as a download. */
export function saveBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.rel = 'noopener'
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}
