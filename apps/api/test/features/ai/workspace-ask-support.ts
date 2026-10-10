// Wave M (M8-2, owner W8): the world of the Ask across boards tests. The search index is the real one (fed by the
// search tests' fake sync, which serves each board's canvas text like GET /internal/boards/:bid/text), OpenAI is
// the local fake (fake-openai.ts: every prompt is captured), and the api's log lines are kept for the
// "counts only" checks.
//
// Dev Studio: alice owns it (a workspace owner sees every board), bob, carol and dave are members, erin is not.
// bob owns every board below; carol and dave reach only what is shared with them.

import { WorkspaceAskResponse } from '@draftroom/contracts'
import type { Db } from '@draftroom/db'
import type { LightMyRequestResponse } from 'fastify'
import { expect } from 'vitest'
import { searchIndexerOf, searchSettings } from '../../../src/features/search/index.ts'
import type { SearchIndexer } from '../../../src/features/search/indexer.ts'
import { type Client, createBoard, createTestApi, DEV_STUDIO, type TestApi } from '../../helpers.ts'
import { type FakeSync, fakeSync, note } from '../search/support.ts'
import { type FakeOpenAi, startFakeOpenAi } from './fake-openai.ts'
import { TEST_KEY } from './support.ts'

export interface AskWorld {
  api: TestApi
  sync: FakeSync
  openai: FakeOpenAi
  indexer: SearchIndexer
  /** Every JSON log line of the api since the world was made (or `logs.length = 0`). */
  logs: Record<string, unknown>[]
  alice: Client
  bob: Client
  carol: Client
  dave: Client
  erin: Client
  close(): Promise<void>
}

export async function askWorld(
  opts: { env?: Record<string, string>; key?: string | null } = {},
): Promise<AskWorld> {
  const openai = await startFakeOpenAi()
  const sync = fakeSync()
  const logs: Record<string, unknown>[] = []
  const saved = { ...searchSettings }
  // No background pass on its own (tests index through the indexer), and an ask waits for its own refreshes.
  searchSettings.intervalMs = 3_600_000
  searchSettings.waitMs = 10_000
  const env: Record<string, string> = {
    OPENAI_BASE_URL: openai.url,
    OPENAI_MODEL: 'gpt-5.4-mini',
    ...(opts.key === null ? {} : { OPENAI_API_KEY: opts.key ?? TEST_KEY }),
    ...opts.env,
  }
  const api = await createTestApi({
    deps: {
      syncInternal: sync,
      logger: { level: 'info', stream: { write: (l: string) => void logs.push(JSON.parse(l)) } },
    },
    env,
  })
  Object.assign(searchSettings, saved)
  const indexer = searchIndexerOf(api.app)
  if (!indexer) throw new Error('search indexer not registered')
  const alice = await api.login('alice')
  const bob = await api.login('bob')
  const carol = await api.login('carol')
  const dave = await api.login('dave')
  const erin = await api.login('erin')
  await api.db.query('DELETE FROM workspace_members WHERE user_id = $1 AND workspace_id = $2', [
    erin.userId,
    DEV_STUDIO,
  ])
  return {
    api,
    sync,
    openai,
    indexer,
    logs,
    alice,
    bob,
    carol,
    dave,
    erin,
    async close() {
      await indexer.idle()
      await api.close()
      await openai.close()
    },
  }
}

/** bob's new board with these note texts (element ids `<prefix>-1`, `<prefix>-2` …), shared as `visibility`. */
export async function boardWith(
  w: AskWorld,
  title: string,
  texts: readonly string[],
  opts: { prefix?: string; visibility?: 'private' | 'workspace_view' | 'workspace_edit' } = {},
): Promise<{ id: string; elementIds: string[] }> {
  const id = await createBoard(w.bob, DEV_STUDIO, title)
  if (opts.visibility && opts.visibility !== 'private') {
    const res = await w.bob.req('PATCH', `/api/boards/${id}`, { visibility: opts.visibility })
    expect(res.statusCode, res.body).toBe(200)
  }
  const prefix = opts.prefix ?? id
  const elementIds = texts.map((_, i) => `${prefix}-${i + 1}`)
  w.sync.setText(
    id,
    texts.map((t, i) => note(elementIds[i] as string, t)),
  )
  return { id, elementIds }
}

export async function grantOn(w: AskWorld, boardId: string, who: Client, role: string) {
  const res = await w.bob.req('PUT', `/api/boards/${boardId}/members/${who.userId}`, { role })
  expect(res.statusCode, res.body).toBe(200)
}

/** Every board's canvas text into the index (background passes until nothing is stale). */
export async function indexAll(w: AskWorld): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const r = await w.indexer.runPass()
    if (r.looked === 0) return
  }
  throw new Error('the index never settled')
}

export const askUrl = (workspaceId = DEV_STUDIO) => `/api/workspaces/${workspaceId}/ai/ask`

export function askRaw(c: { req: Client['req'] }, question: string, extra: Record<string, unknown> = {}) {
  return c.req('POST', askUrl(), { question, acknowledged: true, ...extra })
}

/** A successful ask, parsed with the contract. */
export async function ask(
  c: { req: Client['req'] },
  question: string,
  extra: Record<string, unknown> = {},
): Promise<WorkspaceAskResponse> {
  const res: LightMyRequestResponse = await askRaw(c, question, extra)
  expect(res.statusCode, res.body).toBe(200)
  return WorkspaceAskResponse.parse(res.json())
}

/** The user message of the n-th OpenAI request (from 0). */
export const promptOf = (w: AskWorld, n = 0): string =>
  w.openai.requests[n]?.body.messages?.find((m) => m.role === 'user')?.content ?? ''

/** The JSON lines between <<<BOARDS and BOARDS>>> of a prompt. */
export function boardsOf(prompt: string): { id: string; title: string }[] {
  const start = prompt.indexOf('<<<BOARDS\n')
  const end = prompt.indexOf('\nBOARDS>>>')
  if (start < 0 || end < 0) return []
  return prompt
    .slice(start + '<<<BOARDS\n'.length, end)
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { id: string; title: string })
}

/** Records every SQL statement the app sends through `db` (outside and inside transactions). */
export function spyStatements(db: Db): { statements: string[]; restore(): void } {
  const statements: string[] = []
  const target = db as unknown as Record<string, unknown>
  const saved = new Map<string, unknown>()
  type Fn = (...a: unknown[]) => unknown
  const recorded = (fn: Fn | undefined, self: unknown) => (sql: string, p?: unknown) => {
    statements.push(sql)
    return fn?.call(self, sql, p)
  }
  for (const k of ['query', 'one', 'maybeOne', 'transaction'] as const) {
    const fn = target[k] as Fn
    saved.set(k, fn)
    target[k] =
      k === 'transaction'
        ? (cb: (tx: unknown) => unknown) =>
            fn.call(db, (tx: Record<string, Fn>) =>
              cb({
                ...tx,
                query: recorded(tx.query, tx),
                one: recorded(tx.one, tx),
                maybeOne: recorded(tx.maybeOne, tx),
              }),
            )
        : recorded(fn, db)
  }
  return {
    statements,
    restore() {
      for (const [k, fn] of saved) target[k] = fn
    },
  }
}
