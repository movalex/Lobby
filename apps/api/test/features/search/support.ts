// Shared setup for the search API tests (docs/WAVE4-CONTRACTS.md "search"). The sync server is a fake
// that serves each board's text from memory with a document clock, like
// GET /internal/boards/:bid/text; canvas edits are reported to the api through its real
// /internal/boards/:bid/touched route, as the sync server's touch reporter does.

import { INTERNAL_SECRET_HEADER } from '@draftroom/auth-tickets'
import { SearchResponse } from '@draftroom/contracts'
import type { LightMyRequestResponse } from 'fastify'
import { expect } from 'vitest'
import { searchIndexerOf, searchSettings } from '../../../src/features/search/index.ts'
import type { SearchIndexer } from '../../../src/features/search/indexer.ts'
import type { SyncInternalClient } from '../../../src/sync-internal.ts'
import { type Client, createTestApi, INTERNAL_SECRET, type TestApi } from '../../helpers.ts'

export interface FakeEntry {
  id: string
  type: string
  text: string
  pageId?: string
}

export interface FakeLink {
  el: string
  to: string
  toEl?: string
}

export interface FakeSync extends SyncInternalClient {
  /** Replaces a board's canvas text (and moves its document clock). */
  setText(boardId: string, entries: FakeEntry[]): void
  /**
   * Wave N (N7-4): replaces a board's board links (and moves its document clock). They are answered only when
   * asked for (`links`) and `linksSupported` is on: off, the fake is a sync older than wave N, which ignores
   * the parameter.
   */
  setLinks(boardId: string, links: FakeLink[]): void
  /** Wave N: whether this fake answers `links` when asked (a wave N sync); off by default (an older sync). */
  linksSupported: boolean
  /** Every boardText call with its options (wave N: whether it asked for links). */
  asked: { boardId: string; since: number | undefined; links: boolean }[]
  /** Every boardText call: [boardId, since]. */
  calls: [string, number | undefined][]
  /** When set, boardText rejects (the sync server is unreachable). */
  failing: boolean
  /** When set, boardText waits for it. */
  gate: Promise<void> | null
}

export function fakeSync(): FakeSync {
  const boards = new Map<string, { clock: number; entries: FakeEntry[]; links: FakeLink[] }>()
  let clock = 0
  const f: FakeSync = {
    calls: [],
    asked: [],
    linksSupported: false,
    failing: false,
    gate: null,
    setText(boardId, entries) {
      boards.set(boardId, { clock: ++clock, entries, links: boards.get(boardId)?.links ?? [] })
    },
    setLinks(boardId, links) {
      boards.set(boardId, { clock: ++clock, entries: boards.get(boardId)?.entries ?? [], links })
    },
    async snapshot() {
      return { documents: [] }
    },
    async seed() {
      return { records: 0 }
    },
    async boardText(boardId, opts = {}) {
      f.calls.push([boardId, opts.since])
      f.asked.push({ boardId, since: opts.since, links: opts.links === true })
      if (f.gate) await f.gate
      if (f.failing) throw new Error('sync unreachable: TimeoutError')
      const b = boards.get(boardId) ?? { clock: 0, entries: [], links: [] }
      if (opts.since !== undefined && opts.since === b.clock)
        return { boardId, clock: b.clock, unchanged: true }
      const entries = b.entries.map((e) => ({
        id: e.id,
        type: e.type,
        pageId: e.pageId ?? 'page:page',
        text: e.text,
      }))
      return {
        boardId,
        clock: b.clock,
        unchanged: false,
        truncated: false,
        bytes: entries.reduce((n, e) => n + Buffer.byteLength(e.text), 0),
        entries,
        ...(opts.links && f.linksSupported ? { links: b.links } : {}),
      }
    },
  }
  return f
}

export interface SearchWorld {
  api: TestApi
  sync: FakeSync
  indexer: SearchIndexer
  close(): Promise<void>
}

/**
 * A fresh app whose background indexer never runs on its own (tests run passes through the indexer),
 * and whose searches wait for their own refreshes.
 */
export async function searchWorld(opts: { waitMs?: number } = {}): Promise<SearchWorld> {
  const saved = { ...searchSettings }
  searchSettings.intervalMs = 3_600_000
  searchSettings.waitMs = opts.waitMs ?? 10_000
  const sync = fakeSync()
  const api = await createTestApi({ deps: { syncInternal: sync } })
  Object.assign(searchSettings, saved)
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

/** What the sync server's touch reporter does after a canvas write (`at` defaults to now). */
export async function touch(api: TestApi, boardId: string, atMs?: number): Promise<void> {
  const at = atMs ?? api.clock.now().getTime()
  const res = await api.app.inject({
    method: 'GET',
    url: `/internal/boards/${boardId}/touched?at=${at}`,
    headers: { [INTERNAL_SECRET_HEADER]: INTERNAL_SECRET },
  })
  expect(res.statusCode, res.body).toBe(204)
}

type Requester = { req: Client['req'] }

export function searchUrl(workspaceId: string, q: string, extra: Record<string, string> = {}): string {
  return `/api/workspaces/${workspaceId}/search?${new URLSearchParams({ q, ...extra })}`
}

export async function searchRaw(
  c: Requester,
  workspaceId: string,
  q: string,
  extra: Record<string, string> = {},
): Promise<LightMyRequestResponse> {
  return c.req('GET', searchUrl(workspaceId, q, extra))
}

/** A successful search, parsed with the contract. */
export async function search(
  c: Requester,
  workspaceId: string,
  q: string,
  extra: Record<string, string> = {},
): Promise<SearchResponse> {
  const res = await searchRaw(c, workspaceId, q, extra)
  expect(res.statusCode, res.body).toBe(200)
  return SearchResponse.parse(res.json())
}

/** Board ids of a response, sorted. */
export const boardsOf = (r: SearchResponse) => r.groups.map((g) => g.board.id).sort()

/** "<boardId> <objectId>" of every hit, sorted. */
export const hitsOf = (r: SearchResponse) =>
  r.groups.flatMap((g) => g.hits.map((h) => `${g.board.id} ${h.objectId}`)).sort()

/** The snippet as text with [brackets] around marked words. */
export const marked = (h: SearchResponse['groups'][number]['hits'][number]) =>
  `${h.cutStart ? '…' : ''}${h.snippet.map((p) => (p.hit ? `[${p.text}]` : p.text)).join('')}${h.cutEnd ? '…' : ''}`

export const note = (id: string, text: string): FakeEntry => ({ id: `shape:${id}`, type: 'note', text })
