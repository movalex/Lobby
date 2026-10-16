// The chat outbox under real concurrency (wave R, WS2; docs/WAVE-R-CONTRACTS.md §4.4): PGlite has one connection, so
// FOR UPDATE SKIP LOCKED, the unique (hook, notification) key and the workspace row lock only show their worth on a real
// Postgres. Set DRAFTROOM_TEST_DATABASE_URL (a database these tests may create schemas in; packages/db/src/testing.ts)
// to run them; skipped otherwise. Every message goes to the fake receiver, never to Slack or Teams.
//
//   - two api processes' delivery loops, run at the same time over one outbox, send each message exactly once;
//   - the same notification queued by ten transactions at once gives one row per hook;
//   - twenty-five hooks added at once leave exactly twenty (the workspace row lock), the rest answer 409;
//   - a person's choices changed while their membership is removed never answer 5xx;
//   - a row claimed by a process that died is taken back after its lease and sent once.

import { CHAT_DELIVERY, CHAT_HOOK_LIMITS } from '@draftroom/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { chatDeliveryOf, enqueueChatDeliveries } from '../../../src/features/chat-hooks/index.ts'
import { createTestApi, DEV_STUDIO, type TestApi } from '../../helpers.ts'
import { createThread, mention } from '../comments/fixture.ts'
import {
  type ChatWorld,
  chatWorld,
  deliveries,
  slackHookUrl,
  WEBHOOK_SECRET,
} from './support.ts'

const PG_URL = process.env.DRAFTROOM_TEST_DATABASE_URL ?? ''
const ROUNDS = Number(process.env.DRAFTROOM_PG_STRESS_ITER ?? 3)
const HOOKS = `/api/workspaces/${DEV_STUDIO}/chat-hooks`

let w: ChatWorld | undefined
const extra: TestApi[] = []
afterEach(async () => {
  for (const a of extra.splice(0)) await a.close()
  await w?.close()
  w = undefined
})

/** A second api process over the same database, its loop stopped (the test runs its passes). */
async function secondProcess(world: ChatWorld): Promise<TestApi> {
  const api = await createTestApi({
    db: world.api.db,
    env: { DRAFTROOM_WEBHOOK_SECRET: WEBHOOK_SECRET, DRAFTROOM_CHAT_HOOK_TEST_ORIGINS: world.receiver.origin },
  })
  chatDeliveryOf(api.app)?.stop()
  extra.push(api)
  return api
}

describe.skipIf(!PG_URL)('chat notifications on real Postgres (DRAFTROOM_TEST_DATABASE_URL)', () => {
  it('two delivery loops at once send every message exactly once', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      w = await chatWorld()
      const other = await secondProcess(w)
      // one more hook per row so the 1-a-second pacing of a hook does not slow the round
      const hookIds = [w.hookId]
      for (let i = 1; i < CHAT_HOOK_LIMITS.hooksPerWorkspace; i++) {
        const made = await w.owner.req('POST', HOOKS, {
          name: `#h${i}`,
          provider: 'slack',
          url: slackHookUrl(w.receiver.origin, `hook${String(i).padStart(2, '0')}ABCDEF`),
        })
        expect(made.statusCode).toBe(201)
        hookIds.push(made.json().id as string)
      }
      const put = await w.ben.req('PUT', '/api/me/chat-prefs', {
        workspaceId: DEV_STUDIO,
        prefs: hookIds.map((hookId) => ({ hookId, kinds: ['mention'] })),
      })
      expect(put.statusCode).toBe(200)
      await w.api.db.query("UPDATE boards SET visibility = 'workspace_edit' WHERE id = $1", [w.boardId])
      await createThread(w.owner, w.boardId, `One ${mention(w.ben)}`)
      await createThread(w.owner, w.boardId, `Two ${mention(w.ben)}`)
      const queued = await deliveries(w.api)
      expect(queued).toHaveLength(hookIds.length * 2)

      const mine = chatDeliveryOf(w.api.app)
      const theirs = chatDeliveryOf(other.app)
      if (!mine || !theirs) throw new Error('no loops')
      // four passes, two at a time, until nothing is left
      for (let pass = 0; pass < 4; pass++) await Promise.all([mine.tick(), theirs.tick()])

      const rows = await deliveries(w.api)
      expect(rows.map((r) => r.status)).toEqual(rows.map(() => 'sent'))
      expect(rows.every((r) => r.attempts === 1)).toBe(true)
      expect(w.receiver.posts).toHaveLength(hookIds.length * 2)
      // each hook got each of the two messages once
      const perPath = new Map<string, number>()
      for (const p of w.receiver.posts) perPath.set(p.path, (perPath.get(p.path) ?? 0) + 1)
      expect([...perPath.values()].every((n) => n === 2)).toBe(true)
      await w.close()
      w = undefined
    }
  }, 180_000)

  it('the same notification queued by ten transactions at once gives one row per hook', async () => {
    w = await chatWorld()
    await w.ben.req('PUT', '/api/me/chat-prefs', {
      workspaceId: DEV_STUDIO,
      prefs: [{ hookId: w.hookId, kinds: ['mention'] }],
    })
    const note = await w.api.db.one<{ id: string }>(
      `INSERT INTO notifications (workspace_id, user_id, kind, board_id, actor_id)
       VALUES ($1, $2, 'access_request', $3, $4) RETURNING id`,
      [DEV_STUDIO, w.ben.userId, w.boardId, w.owner.userId],
    )
    await w.api.db.query(
      "UPDATE chat_hook_prefs SET kinds = ARRAY['mention', 'access_request'] WHERE user_id = $1",
      [w.ben.userId],
    )
    const db = w.api.db
    await Promise.all(
      Array.from({ length: 10 }, () => db.transaction((tx) => enqueueChatDeliveries(tx, [note.id]))),
    )
    expect(await deliveries(w.api)).toHaveLength(1)
  })

  it(`${CHAT_HOOK_LIMITS.hooksPerWorkspace + 5} hooks added at once leave exactly ${CHAT_HOOK_LIMITS.hooksPerWorkspace}`, async () => {
    w = await chatWorld()
    const world = w
    const results = await Promise.all(
      Array.from({ length: CHAT_HOOK_LIMITS.hooksPerWorkspace + 5 }, (_, i) =>
        world.owner.req('POST', HOOKS, {
          name: `#race${i}`,
          provider: 'slack',
          url: slackHookUrl(world.receiver.origin, `race${String(i).padStart(2, '0')}ABCDEF`),
        }),
      ),
    )
    const codes = results.map((r) => r.statusCode)
    expect(codes.filter((c) => c >= 500)).toEqual([])
    const n = await world.api.db.one<{ n: number }>('SELECT count(*)::int AS n FROM chat_hooks')
    expect(n.n).toBe(CHAT_HOOK_LIMITS.hooksPerWorkspace)
    expect(codes.filter((c) => c === 409)).toHaveLength(5)
  })

  it('changing a person’s choices while their membership is removed never answers 5xx', async () => {
    w = await chatWorld()
    const world = w
    for (let i = 0; i < ROUNDS * 3; i++) {
      await world.api.db.query(
        `INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ($1, $2, 'member', now())
         ON CONFLICT DO NOTHING`,
        [DEV_STUDIO, world.ben.userId],
      )
      const [put] = await Promise.all([
        world.ben.req('PUT', '/api/me/chat-prefs', {
          workspaceId: DEV_STUDIO,
          prefs: [{ hookId: world.hookId, kinds: ['mention', 'reply'] }],
        }),
        world.api.db.query('DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [
          DEV_STUDIO,
          world.ben.userId,
        ]),
      ])
      expect([200, 404]).toContain(put.statusCode)
    }
    const left = await world.api.db.one<{ n: number }>('SELECT count(*)::int AS n FROM chat_hook_prefs')
    expect(left.n).toBe(0)
  })

  it('a row claimed by a process that died is taken back after its lease and sent once, by whichever loop sees it first', async () => {
    w = await chatWorld()
    const other = await secondProcess(w)
    await w.ben.req('PUT', '/api/me/chat-prefs', {
      workspaceId: DEV_STUDIO,
      prefs: [{ hookId: w.hookId, kinds: ['mention'] }],
    })
    await w.api.db.query("UPDATE boards SET visibility = 'workspace_edit' WHERE id = $1", [w.boardId])
    await createThread(w.owner, w.boardId, `Hello ${mention(w.ben)}`)
    await w.api.db.query(
      "UPDATE chat_deliveries SET status = 'sending', attempts = 1, lease_until = now() - interval '1 second'",
    )
    const mine = chatDeliveryOf(w.api.app)
    const theirs = chatDeliveryOf(other.app)
    if (!mine || !theirs) throw new Error('no loops')
    await Promise.all([mine.tick(), theirs.tick()])
    await Promise.all([mine.tick(), theirs.tick()])
    expect(w.receiver.posts).toHaveLength(1)
    expect((await deliveries(w.api)).map((r) => r.status)).toEqual(['sent'])
    expect(CHAT_DELIVERY.leaseMs).toBeGreaterThan(CHAT_HOOK_LIMITS.requestTimeoutMs)
  }, 60_000)
})
