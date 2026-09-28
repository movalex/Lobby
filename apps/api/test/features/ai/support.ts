// Shared setup for the ai-assist API tests (docs/WAVE4-CONTRACTS.md §4). The sync server is a fake that
// serves each board's records as its snapshot; OpenAI is a local fake (fake-openai.ts) reached through
// OPENAI_BASE_URL, so no test ever calls the real API.

import { draftroomSchema } from '@draftroom/canvas-schema'
import type { LightMyRequestResponse } from 'fastify'
import { expect } from 'vitest'
import { aiSettings } from '../../../src/features/ai/index.ts'
import type { RoomSnapshotJson, SyncInternalClient } from '../../../src/sync-internal.ts'
import { SyncUnavailable } from '../../../src/sync-internal.ts'
import { type Client, createBoard, createTestApi, DEV_STUDIO, type TestApi } from '../../helpers.ts'
import { type FakeOpenAi, startFakeOpenAi } from './fake-openai.ts'

export const TEST_KEY = 'sk-test-fake-key-0123456789abcdef'
export const SCHEMA = draftroomSchema.serialize()

export interface AiSync extends SyncInternalClient {
  setBoard(boardId: string, shapes: readonly object[]): void
  unavailable: boolean
  snapshots: string[]
}

const baseRecords = () => [
  { id: 'document:document', typeName: 'document', gridSize: 10, name: '', meta: {} },
  { id: 'page:main', typeName: 'page', name: 'Page 1', index: 'a1', meta: {} },
]

export function aiSync(): AiSync {
  const boards = new Map<string, RoomSnapshotJson>()
  const s: AiSync = {
    unavailable: false,
    snapshots: [],
    setBoard(boardId, shapes) {
      boards.set(boardId, {
        documentClock: 1,
        schema: SCHEMA,
        documents: [...baseRecords(), ...shapes].map((state) => ({
          state: state as unknown as Record<string, unknown>,
          lastChangedClock: 1,
        })),
      })
    },
    async snapshot(boardId) {
      if (s.unavailable) throw new SyncUnavailable('sync unreachable: test')
      s.snapshots.push(boardId)
      return structuredClone(
        boards.get(boardId) ?? {
          documentClock: 0,
          schema: SCHEMA,
          documents: baseRecords().map((state) => ({ state, lastChangedClock: 0 })),
        },
      )
    },
    async seed() {
      return { records: 0 }
    },
  }
  return s
}

export interface AiWorld {
  api: TestApi
  sync: AiSync
  openai: FakeOpenAi
  /** Dev Studio owner (first login): owns every Dev Studio board through the workspace. */
  alice: Client
  /** Editor grant on `board`. */
  bob: Client
  /** Commenter grant on `board`. */
  carol: Client
  /** Viewer grant on `board`. */
  dave: Client
  /** Not a member of Dev Studio. */
  erin: Client
  board: string
  close(): Promise<void>
}

export async function aiWorld(
  opts: { env?: Record<string, string>; key?: string | null; inFlight?: typeof aiSettings.inFlight } = {},
): Promise<AiWorld> {
  const openai = await startFakeOpenAi()
  const sync = aiSync()
  const saved = structuredClone(aiSettings.inFlight)
  if (opts.inFlight) aiSettings.inFlight = opts.inFlight
  const env: Record<string, string> = {
    OPENAI_BASE_URL: openai.url,
    OPENAI_MODEL: 'gpt-5.4-mini',
    ...(opts.key === null ? {} : { OPENAI_API_KEY: opts.key ?? TEST_KEY }),
    ...opts.env,
  }
  const api = await createTestApi({ deps: { syncInternal: sync }, env })
  aiSettings.inFlight = saved
  const alice = await api.login('alice')
  const bob = await api.login('bob')
  const carol = await api.login('carol')
  const dave = await api.login('dave')
  const erin = await api.login('erin')
  await api.db.query('DELETE FROM workspace_members WHERE user_id = $1 AND workspace_id = $2', [
    erin.userId,
    DEV_STUDIO,
  ])
  const board = await createBoard(alice, DEV_STUDIO, 'Launch brainstorm')
  await grant(alice, board, bob, 'editor')
  await grant(alice, board, carol, 'commenter')
  await grant(alice, board, dave, 'viewer')
  return {
    api,
    sync,
    openai,
    alice,
    bob,
    carol,
    dave,
    erin,
    board,
    async close() {
      await api.close()
      await openai.close()
    },
  }
}

export async function grant(owner: Client, boardId: string, who: Client, role: string) {
  const res = await owner.req('PUT', `/api/boards/${boardId}/members/${who.userId}`, { role })
  expect(res.statusCode, res.body).toBe(200)
}

export const statusUrl = (boardId: string) => `/api/boards/${boardId}/ai`
export const runUrl = (boardId: string) => `/api/boards/${boardId}/ai/run`

type Requester = { req: Client['req'] }

export function run(c: Requester, boardId: string, body: Record<string, unknown>) {
  return c.req('POST', runUrl(boardId), { acknowledged: true, ...body })
}

export function expectError(res: LightMyRequestResponse, status: number, code: string) {
  expect(res.statusCode, res.body).toBe(status)
  expect((res.json() as { error: { code: string } }).error.code).toBe(code)
}

/** Every ai_usage row, oldest first. */
export async function usageRows(api: TestApi) {
  return (
    await api.db.query<{
      workspace_id: string
      user_id: string
      action: string
      status: string
      reserved_tokens: number
      charged_tokens: number
      input_tokens: number | null
      output_tokens: number | null
    }>(
      `SELECT workspace_id, user_id, action, status, reserved_tokens, charged_tokens, input_tokens,
              output_tokens FROM ai_usage ORDER BY id`,
    )
  ).rows
}
