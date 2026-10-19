// Wave W (WS3, docs/WAVE-W-CONTRACTS.md §5): the world of the search-inside-files tests. The search index is the real
// one, fed by the search tests' fake sync (support.ts), which here also answers GET /internal/boards/:bid/asset-refs
// like the Excalidraw engine's route (which versions a board's canvas shows, and which only "Recently deleted" could
// bring back). File text reaches the api the way the worker sends it: an extract-text op claimed over
// /api/worker/ops/claim with the worker token, its pages over /text, then /complete (the fake worker of these tests).
// Over PGlite by default, over a real Postgres when DRAFTROOM_TEST_DATABASE_URL is set (scripts/nas-pg-api.sh): the
// same files are the leak matrix on both.

import {
  FILE_TEXT_LIMITS,
  SearchResponse,
  WORKER_CAPABILITIES,
  WORKER_OP_LIMITS,
  WorkerOpClaimed,
} from '@draftroom/contracts'
import { newId } from '@draftroom/db'
import { newId as newAssetId } from '@draftroom/dev-assets'
import type { LightMyRequestResponse } from 'fastify'
import { expect } from 'vitest'
import { fileTextBackfillSettings } from '../../../src/features/search/file-backfill.ts'
import { searchIndexerOf, searchSettings } from '../../../src/features/search/index.ts'
import type { SearchIndexer } from '../../../src/features/search/indexer.ts'
import { type Client, createTestApi, DEV_STUDIO, type TestApi, WORKER_TOKEN } from '../../helpers.ts'
import { type FakeEntry, type FakeSync, fakeSync, touch } from './support.ts'

export interface VersionRef {
  assetId: string
  versionId: string
}

export interface FileSync extends FakeSync {
  /** What the board's canvas shows (`canvas`) and what only "Recently deleted" holds; moves its document clock. */
  setRefs(
    boardId: string,
    canvas: VersionRef[],
    opts?: { deleted?: VersionRef[]; versionsOnly?: string[] },
  ): void
  /** Every assetRefs call (board ids). */
  refsCalls: string[]
  /** When set, assetRefs rejects (the sync server is unreachable). */
  refsFailing: boolean
}

export function fileSync(): FileSync {
  return withAssetRefs(fakeSync())
}

/** Gives a search fake sync (support.ts) the asset-refs answer (in place: an app holding it sees the change). */
export function withAssetRefs(base: FakeSync): FileSync {
  const texts = new Map<string, FakeEntry[]>()
  const refs = new Map<string, { canvas: VersionRef[]; deleted: VersionRef[]; versionsOnly: string[] }>()
  const setText = base.setText.bind(base)
  const f = base as FileSync
  f.refsCalls = []
  f.refsFailing = false
  f.setText = (boardId, entries) => {
    texts.set(boardId, entries)
    setText(boardId, entries)
  }
  f.setRefs = (boardId, canvas, opts = {}) => {
    refs.set(boardId, { canvas, deleted: opts.deleted ?? [], versionsOnly: opts.versionsOnly ?? [] })
    // a canvas change moves the document clock: the board's next text read is a changed answer
    setText(boardId, texts.get(boardId) ?? [])
  }
  f.assetRefs = async (boardId: string) => {
    f.refsCalls.push(boardId)
    if (f.refsFailing) throw new Error('sync unreachable: TimeoutError')
    const r = refs.get(boardId)
    return {
      boardId,
      exists: !!r,
      canvas: r?.canvas ?? [],
      deleted: r?.deleted ?? [],
      unusedAssetRecords: [],
      versionsOnly: { canvas: r?.versionsOnly ?? [], deleted: [] },
    }
  }
  return f
}

export interface FileWorld {
  api: TestApi
  sync: FileSync
  indexer: SearchIndexer
  close(): Promise<void>
}

/** A fresh app with file search on (unless `env` says otherwise), no background pass and no backfill on their own. */
export async function fileWorld(opts: { env?: Record<string, string> } = {}): Promise<FileWorld> {
  const saved = { ...searchSettings }
  const savedBackfill = { ...fileTextBackfillSettings }
  searchSettings.intervalMs = 3_600_000
  searchSettings.waitMs = 10_000
  fileTextBackfillSettings.firstAfterMs = 3_600_000
  const sync = fileSync()
  const api = await createTestApi({
    deps: { syncInternal: sync },
    env: { DRAFTROOM_FILE_SEARCH: 'on', ...opts.env },
  })
  Object.assign(searchSettings, saved)
  Object.assign(fileTextBackfillSettings, savedBackfill)
  const indexer = searchIndexerOf(api.app)
  if (!indexer) throw new Error('search indexer not registered')
  return {
    api,
    sync,
    indexer,
    async close() {
      await indexer.idle()
      await api.close()
    },
  }
}

/** A ready PDF (or `mime`) version uploaded by `by` to `boardId` (rows only: no bytes are needed to search it). */
export async function addPdf(
  api: TestApi,
  boardId: string,
  by: Client,
  name = 'Brief.pdf',
  opts: { workspaceId?: string; mime?: string; status?: string; assetId?: string } = {},
): Promise<VersionRef & { boardId: string; workspaceId: string }> {
  const assetId = opts.assetId ?? newAssetId('ast')
  const versionId = newAssetId('ver')
  const workspaceId = opts.workspaceId ?? DEV_STUDIO
  await api.db.query(
    `INSERT INTO asset_versions (id, asset_id, workspace_id, board_id, name, declared_mime_type, mime_type, kind,
                                 size_bytes, sha256, uploaded_by, status, probe, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $6, 'pdf', 1000, $7, $8, $9, '{"pageCount": 3}'::jsonb, $10, $10)`,
    [
      versionId,
      assetId,
      workspaceId,
      boardId,
      name,
      opts.mime ?? 'application/pdf',
      '0'.repeat(64),
      by.userId,
      opts.status ?? 'ready',
      api.clock.now(),
    ],
  )
  return { assetId, versionId, boardId, workspaceId }
}

/** A worker request (Bearer token only, no cookies), like apps/worker's client. */
export function asWorker(api: TestApi, url: string, body: unknown): Promise<LightMyRequestResponse> {
  return api.app.inject({
    method: 'POST',
    url,
    headers: { authorization: `Bearer ${WORKER_TOKEN}` },
    payload: body as object,
  })
}

export const EXTRACT_CAPS = [WORKER_CAPABILITIES['extract-text']]

/** Queues an extract-text op for the version (as the api's enqueue does); returns its id. */
export async function queueExtract(
  api: TestApi,
  v: { versionId: string; boardId: string; workspaceId: string },
): Promise<string> {
  const id = newId('wop')
  const now = api.clock.now()
  await api.db.query(
    `INSERT INTO worker_ops (id, workspace_id, board_id, kind, source_version_id, params, params_key, run_after,
                             created_at, updated_at)
     VALUES ($1, $2, $3, 'extract-text', $4, $5::jsonb, '-', $6, $6, $6)`,
    [id, v.workspaceId, v.boardId, v.versionId, JSON.stringify({ maxPages: FILE_TEXT_LIMITS.maxPages }), now],
  )
  return id
}

/** Claims the next op as worker `workerId` (extract-text only); the parsed claim, or null on 204. */
export async function claimExtract(api: TestApi, workerId = 'nas-1'): Promise<WorkerOpClaimed | null> {
  const res = await asWorker(api, '/api/worker/ops/claim', { workerId, capabilities: EXTRACT_CAPS })
  if (res.statusCode === 204) return null
  expect(res.statusCode, res.body).toBe(200)
  return WorkerOpClaimed.parse(res.json())
}

/** A batch's JSON bytes at most (the runner's rule: under the api's 256 KiB JSON body limit). */
const BATCH_BYTES = 192 * 1024

/**
 * Sends `pages` (page number → text) in ascending order, in batches of the protocol's size and at most BATCH_BYTES of
 * JSON each, as the runner does (apps/worker/src/ops/extract-text.ts).
 */
export async function sendPages(
  api: TestApi,
  claim: WorkerOpClaimed,
  pages: Readonly<Record<number, string>>,
  workerId = 'nas-1',
): Promise<LightMyRequestResponse[]> {
  const list = Object.entries(pages)
    .map(([p, body]) => ({ page: Number(p), body }))
    .sort((a, b) => a.page - b.page)
  const batches: (typeof list)[] = []
  let cur: typeof list = []
  let bytes = 0
  for (const p of list) {
    const size = Buffer.byteLength(JSON.stringify(p))
    if (cur.length && (cur.length >= WORKER_OP_LIMITS.textPagesPerCall || bytes + size > BATCH_BYTES)) {
      batches.push(cur)
      cur = []
      bytes = 0
    }
    cur.push(p)
    bytes += size
  }
  if (cur.length) batches.push(cur)
  const out: LightMyRequestResponse[] = []
  for (const batch of batches)
    out.push(
      await asWorker(api, `/api/worker/ops/${claim.op.id}/text`, {
        workerId,
        attempt: claim.op.attempt,
        pages: batch,
      }),
    )
  return out
}

export function completeExtract(
  api: TestApi,
  claim: WorkerOpClaimed,
  result: { pages: number; bytes?: number; truncated?: boolean; extractor?: string },
  workerId = 'nas-1',
): Promise<LightMyRequestResponse> {
  return asWorker(api, `/api/worker/ops/${claim.op.id}/complete`, {
    workerId,
    attempt: claim.op.attempt,
    outputs: [],
    result: {
      pages: result.pages,
      bytes: result.bytes ?? 0,
      truncated: result.truncated ?? false,
      extractor: result.extractor ?? FILE_TEXT_LIMITS.extractor,
    },
  })
}

/** The whole fake-worker run for one version: queue, claim, its pages, complete (each step must succeed). */
export async function extract(
  api: TestApi,
  v: { versionId: string; boardId: string; workspaceId: string },
  pages: Readonly<Record<number, string>>,
): Promise<void> {
  const opId = await queueExtract(api, v)
  const c = await claimExtract(api)
  expect(c?.op.id).toBe(opId)
  if (!c) return
  for (const r of await sendPages(api, c, pages)) expect(r.statusCode, r.body).toBe(200)
  const bodies = Object.values(pages)
  const done = await completeExtract(api, c, {
    pages: bodies.length,
    bytes: bodies.reduce((n, b) => n + Buffer.byteLength(b), 0),
  })
  expect(done.statusCode, done.body).toBe(200)
}

/** What the board's canvas shows now, as the sync server would answer, and the canvas edit reported. */
export async function place(
  w: FileWorld,
  boardId: string,
  canvas: VersionRef[],
  opts: { deleted?: VersionRef[]; versionsOnly?: string[] } = {},
): Promise<void> {
  w.sync.setRefs(boardId, canvas, opts)
  await touch(w.api, boardId)
}

type Requester = { req: Client['req'] }

export async function searchFiles(
  c: Requester,
  workspaceId: string,
  q: string,
  extra: Record<string, string> = {},
) {
  const res = await c.req(
    'GET',
    `/api/workspaces/${workspaceId}/search?${new URLSearchParams({ q, ...extra })}`,
  )
  expect(res.statusCode, res.body).toBe(200)
  return SearchResponse.parse(res.json())
}

/** "<boardId> <objectId>" of every FILE hit, sorted. */
export const fileHitsOf = (r: SearchResponse) =>
  r.groups.flatMap((g) => g.hits.filter((h) => h.file).map((h) => `${g.board.id} ${h.objectId}`)).sort()

export const fileObject = (versionId: string, page: number) => `file:${versionId}.p${page}`
