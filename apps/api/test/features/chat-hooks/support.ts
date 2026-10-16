// Shared setup for the chat hook tests (wave R, WS2): one Dev Studio with a person per role, a board, a Slack hook that
// points at the fake receiver (e2e/tests/support/chat-hooks.ts: never the real service), and the delivery loop driven by
// hand (its timer is stopped right away, so a test decides when a pass runs).

import type { ChatHook, ChatHookKind, ChatPrefsResponse } from '@draftroom/contracts'
import { expect } from 'vitest'
import {
  type FakeReceiver,
  slackHookUrl,
  startFakeReceiver,
  teamsHookUrl,
} from '../../../../../e2e/tests/support/chat-hooks.ts'
import type { TickResult } from '../../../src/features/chat-hooks/deliver.ts'
import { chatDeliveryOf } from '../../../src/features/chat-hooks/index.ts'
import { type Client, createBoard, createTestApi, DEV_STUDIO, type TestApi } from '../../helpers.ts'

export const WEBHOOK_SECRET = 'test-webhook-secret-0123456789abcdefghij'
export const OTHER_SECRET = 'test-other-webhook-secret-0123456789abcd'
export { slackHookUrl, startFakeReceiver, teamsHookUrl }

export interface ChatWorld {
  api: TestApi
  receiver: FakeReceiver
  /** the fake Teams Workflows, when asked for */
  teams: FakeReceiver | null
  /** Dev Studio's owner (first login), a creator, the board's owner */
  owner: Client
  /** a member and creator with edit access to the board: the one who is mentioned */
  ben: Client
  /** a workspace ADMIN who is not a creator (an outside address) */
  pat: Client
  /** a workspace member who is not a creator */
  sam: Client
  /** a creator who is not in Dev Studio */
  erin: Client
  boardId: string
  /** a Slack hook of Dev Studio, on the receiver */
  hookId: string
  hookUrl: string
  tick(): Promise<TickResult>
  close(): Promise<void>
}

export async function chatWorld(
  opts: {
    secret?: string | null
    env?: Record<string, string>
    hookName?: string
    /** every log line the api writes (JSON text) */
    logs?: string[]
    /** a second fake receiver standing for Teams Workflows */
    teams?: boolean
  } = {},
): Promise<ChatWorld> {
  const receiver = await startFakeReceiver()
  const teams = opts.teams ? await startFakeReceiver() : null
  const secret = opts.secret === undefined ? WEBHOOK_SECRET : opts.secret
  const logs = opts.logs
  const api = await createTestApi({
    ...(logs
      ? { deps: { logger: { level: 'info' as const, stream: { write: (l: string) => void logs.push(l) } } } }
      : {}),
    env: {
      ...(secret ? { DRAFTROOM_WEBHOOK_SECRET: secret } : {}),
      DRAFTROOM_CHAT_HOOK_TEST_ORIGINS: teams ? `${receiver.origin},${teams.origin}` : receiver.origin,
      ...opts.env,
    },
  })
  chatDeliveryOf(api.app)?.stop()
  const owner = await api.login('owner', 'Olive Owner')
  const ben = await api.login('ben', 'Ben Editor')
  const pat = await api.login('pat', 'Pat Outside', { email: 'pat@client.example.test' })
  const sam = await api.login('sam', 'Sam Member', { email: 'sam@client.example.test' })
  const erin = await api.login('erin', 'Erin Elsewhere')
  await api.db.query('DELETE FROM workspace_members WHERE user_id = $1 AND workspace_id = $2', [
    erin.userId,
    DEV_STUDIO,
  ])
  // outside addresses do not join Dev Studio by themselves: an admin and a member, neither a creator
  await api.db.query(
    `INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
     VALUES ($1, $2, 'admin', now()), ($1, $3, 'member', now())
     ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
    [DEV_STUDIO, pat.userId, sam.userId],
  )
  const boardId = await createBoard(owner, DEV_STUDIO, 'Pitch wall')
  const grant = await owner.req('PUT', `/api/boards/${boardId}/members/${ben.userId}`, { role: 'editor' })
  expect(grant.statusCode).toBe(200)
  const hookUrl = slackHookUrl(receiver.origin)
  const made = await owner.req('POST', `/api/workspaces/${DEV_STUDIO}/chat-hooks`, {
    name: opts.hookName ?? '#lobby-pitches',
    provider: 'slack',
    url: hookUrl,
  })
  if (secret) expect(made.statusCode, made.body).toBe(201)
  const hookId = secret ? (made.json() as ChatHook).id : ''
  return {
    api,
    receiver,
    teams,
    owner,
    ben,
    pat,
    sam,
    erin,
    boardId,
    hookId,
    hookUrl,
    tick: () => {
      const loop = chatDeliveryOf(api.app)
      if (!loop) throw new Error('no delivery loop')
      return loop.tick()
    },
    close: async () => {
      await api.close()
      await receiver.close()
      await teams?.close()
    },
  }
}

/** Opts `c` in to `kinds` for `hookId` in Dev Studio. */
export async function optIn(
  c: Client,
  hookId: string,
  kinds: ChatHookKind[],
  workspaceId = DEV_STUDIO,
): Promise<ChatPrefsResponse> {
  const res = await c.req('PUT', '/api/me/chat-prefs', { workspaceId, prefs: [{ hookId, kinds }] })
  expect(res.statusCode, res.body).toBe(200)
  return res.json() as ChatPrefsResponse
}

export interface DeliveryRow {
  id: string
  hook_id: string
  recipient_id: string
  status: string
  attempts: number
  last_code: string | null
  next_at: Date
}

export async function deliveries(api: TestApi): Promise<DeliveryRow[]> {
  const rows = await api.db.query<DeliveryRow>(
    'SELECT id::text AS id, hook_id, recipient_id, status, attempts, last_code, next_at FROM chat_deliveries ORDER BY id',
  )
  return rows.rows
}

export const statuses = async (api: TestApi) => (await deliveries(api)).map((d) => d.status)

/** The text of a Slack payload's first block (the sentence and its link). */
export const slackText = (body: Record<string, unknown> | null): string => {
  const blocks = (body?.blocks ?? []) as { text?: { text?: string } }[]
  return blocks[0]?.text?.text ?? ''
}
