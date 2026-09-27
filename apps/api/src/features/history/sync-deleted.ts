// api -> sync "Recently deleted" calls (GET /internal/boards/:bid/deleted, POST …/deleted/restore).
// The shared SyncInternalClient (sync-internal.ts) only knows snapshot/seed; tests inject a client
// with these two methods through ApiDeps.syncInternal, which this module picks up.

import { INTERNAL_SECRET_HEADER } from '@draftroom/auth-tickets'
import { ListDeletedResponse, RestoreDeletedResponse } from '@draftroom/contracts'
import { SyncUnavailable } from '../../sync-internal.ts'
import type { FeatureContext } from '../context.ts'

export interface DeletedSyncClient {
  listDeleted(boardId: string, limit?: number): Promise<unknown>
  restoreDeleted(boardId: string, ids: string[]): Promise<unknown>
}

function isDeletedSyncClient(v: unknown): v is DeletedSyncClient {
  const c = v as Partial<DeletedSyncClient> | null
  return typeof c?.listDeleted === 'function' && typeof c?.restoreDeleted === 'function'
}

export function createHttpDeletedSyncClient(opts: {
  baseUrl: string
  secret: string
  timeoutMs?: number
}): DeletedSyncClient {
  const base = opts.baseUrl.replace(/\/+$/, '')
  const call = async (path: string, init: RequestInit = {}) => {
    let res: Response
    try {
      res = await fetch(`${base}${path}`, {
        ...init,
        headers: { ...(init.headers ?? {}), [INTERNAL_SECRET_HEADER]: opts.secret },
        signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
      })
    } catch (e) {
      throw new SyncUnavailable(`sync unreachable: ${(e as Error).name}`)
    }
    if (!res.ok) throw new SyncUnavailable(`${path.split('/').at(-1)} failed with ${res.status}`)
    return res.json() as Promise<unknown>
  }
  return {
    listDeleted: (boardId, limit) =>
      call(`/internal/boards/${encodeURIComponent(boardId)}/deleted${limit ? `?limit=${limit}` : ''}`),
    restoreDeleted: (boardId, ids) =>
      call(`/internal/boards/${encodeURIComponent(boardId)}/deleted/restore`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids }),
      }),
  }
}

export interface DeletedApi {
  list(boardId: string): Promise<ListDeletedResponse>
  restore(boardId: string, ids: string[]): Promise<RestoreDeletedResponse>
}

/** Answers are checked against the contracts: a malformed one is a sync failure, never passed on. */
export function createDeletedApi(ctx: FeatureContext): DeletedApi {
  const client = isDeletedSyncClient(ctx.sync)
    ? ctx.sync
    : createHttpDeletedSyncClient({ baseUrl: ctx.config.syncInternalUrl, secret: ctx.config.internalSecret })
  return {
    async list(boardId) {
      const parsed = ListDeletedResponse.safeParse(await client.listDeleted(boardId))
      if (!parsed.success) throw new SyncUnavailable('malformed recently-deleted list')
      return parsed.data
    },
    async restore(boardId, ids) {
      const parsed = RestoreDeletedResponse.safeParse(await client.restoreDeleted(boardId, ids))
      if (!parsed.success) throw new SyncUnavailable('malformed restore result')
      return parsed.data
    },
  }
}
