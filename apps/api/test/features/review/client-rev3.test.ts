// Wave S foundation: LOBBY_CLIENT_REV 3 (packages/contracts client-rev.ts). A tab of the rev-2 build (main 9c359183)
// stays open for days and parses its bell and its chat preferences with its own copy of the contracts, frozen in
// @draftroom/contracts/fixtures/client-rev2: one 'review_status' value in either answer fails the whole answer. So the
// api answers a request that declares revision 2 (or none) without the kind, and a PUT of an older build's chat
// choices keeps the review_status it cannot know. A rev-3 build gets it. Also here: the foundation's other stubs that
// a stale or a new client could reach (a comment spot is refused until WS3 stores it). WS1's real review rows, the
// bell's review facts and the reset are tested in ./review.test.ts and ./chat.test.ts.

import {
  ChatPrefsResponse,
  ListNotificationsResponse,
  LOBBY_CLIENT_HEADER,
  LOBBY_CLIENT_REV,
} from '@draftroom/contracts'
import {
  Rev2ChatPrefsResponse,
  Rev2ListNotificationsResponse,
} from '@draftroom/contracts/fixtures/client-rev2'
import { afterEach, describe, expect, it } from 'vitest'
import { resetForNewVersion } from '../../../src/features/review/hooks.ts'
import type { Client } from '../../helpers.ts'
import { DEV_STUDIO } from '../../helpers.ts'
import { type ChatWorld, chatWorld } from '../chat-hooks/support.ts'

let w: ChatWorld | undefined
afterEach(async () => {
  await w?.close()
  w = undefined
})

const rev = (n: number | null): Record<string, string> =>
  n === null ? {} : { [LOBBY_CLIENT_HEADER]: String(n) }

/** A review item on the board, a status event by `actor`, and a review_status bell row for `recipient`. */
async function reviewNotice(world: ChatWorld, actor: Client, recipient: Client) {
  const db = world.api.db
  await db.query(
    `INSERT INTO review_items (id, workspace_id, board_id, element_id, kind, label, status, status_seq, status_by,
                               status_at, created_by)
     VALUES ('rvi_item000000001', $1, $2, 'frame-1', 'frame', 'Key art B', 'approved', 1, $3, now(), $4)`,
    [DEV_STUDIO, world.boardId, actor.userId, recipient.userId],
  )
  await db.query(
    `INSERT INTO review_events (id, workspace_id, board_id, item_id, kind, status, previous_status, reason, actor_id,
                                actor_name, actor_kind)
     VALUES ('rve_event00000001', $1, $2, 'rvi_item000000001', 'status', 'approved', 'pending', 'set', $3, 'Ben Editor',
             'account')`,
    [DEV_STUDIO, world.boardId, actor.userId],
  )
  await db.query(
    `INSERT INTO notifications (workspace_id, user_id, kind, board_id, actor_id, review_event_id)
     VALUES ($1, $2, 'review_status', $3, $4, 'rve_event00000001')`,
    [DEV_STUDIO, recipient.userId, world.boardId, actor.userId],
  )
}

describe('the bell', () => {
  it('lists review_status only to a rev-3 build; rev 0 to 2 neither list nor count it, and their schema parses', async () => {
    const world = await chatWorld()
    w = world
    expect(LOBBY_CLIENT_REV).toBe(3)
    // an ordinary item next to it, so an older build still has something to parse
    const thread = await world.ben.req('POST', `/api/boards/${world.boardId}/threads`, {
      anchor: { kind: 'point', x: 1, y: 2 },
      body: 'Logo larger?',
    })
    expect(thread.statusCode, thread.body).toBe(201)
    await reviewNotice(world, world.ben, world.owner)
    const bell = async (n: number | null) => {
      const res = await world.owner.req('GET', '/api/me/notifications', undefined, rev(n))
      expect(res.statusCode, res.body).toBe(200)
      return res.json() as unknown
    }
    for (const n of [null, 0, 1, 2]) {
      const body = await bell(n)
      const old = Rev2ListNotificationsResponse.safeParse(body)
      expect(old.success, `rev ${n}`).toBe(true)
      expect(
        old.data?.notifications.map((i) => i.kind),
        `rev ${n}`,
      ).toEqual(['new_comment'])
      expect(old.data?.unreadCount, `rev ${n}`).toBe(1)
    }
    const now = ListNotificationsResponse.parse(await bell(3))
    expect(now.notifications.map((i) => i.kind).sort()).toEqual(['new_comment', 'review_status'])
    expect(now.unreadCount).toBe(2)
    // and what a rev-3 answer would do to the old build: fail whole (the reason for the revision)
    expect(Rev2ListNotificationsResponse.safeParse(await bell(3)).success).toBe(false)
  })
})

describe('chat preferences', () => {
  const PREFS = `/api/me/chat-prefs?workspace=${DEV_STUDIO}`

  it('a rev-3 build sets and reads review_status; an older build reads its choice without it, and parses', async () => {
    const world = await chatWorld()
    w = world
    const put = await world.ben.req(
      'PUT',
      '/api/me/chat-prefs',
      { workspaceId: DEV_STUDIO, prefs: [{ hookId: world.hookId, kinds: ['review_status', 'mention'] }] },
      rev(3),
    )
    expect(put.statusCode, put.body).toBe(200)
    expect(ChatPrefsResponse.parse(put.json()).prefs).toEqual([
      { hookId: world.hookId, kinds: ['mention', 'review_status'] },
    ])
    for (const n of [null, 2]) {
      const body = (await world.ben.req('GET', PREFS, undefined, rev(n))).json()
      const old = Rev2ChatPrefsResponse.safeParse(body)
      expect(old.success, `rev ${n}`).toBe(true)
      expect(old.data?.prefs, `rev ${n}`).toEqual([{ hookId: world.hookId, kinds: ['mention'] }])
    }
    // only review_status chosen: the older build sees no choice for the hook at all
    await world.ben.req(
      'PUT',
      '/api/me/chat-prefs',
      { workspaceId: DEV_STUDIO, prefs: [{ hookId: world.hookId, kinds: ['review_status'] }] },
      rev(3),
    )
    expect(
      Rev2ChatPrefsResponse.parse((await world.ben.req('GET', PREFS, undefined, rev(2))).json()).prefs,
    ).toEqual([])
  })

  it('an older build’s PUT keeps the review_status it cannot know, even when it turns every other kind off', async () => {
    const world = await chatWorld()
    w = world
    const stored = async () =>
      (
        await world.api.db.query<{ kinds: string[] }>(
          'SELECT kinds FROM chat_hook_prefs WHERE user_id = $1 AND hook_id = $2',
          [world.ben.userId, world.hookId],
        )
      ).rows.map((r) => r.kinds)
    await world.ben.req(
      'PUT',
      '/api/me/chat-prefs',
      { workspaceId: DEV_STUDIO, prefs: [{ hookId: world.hookId, kinds: ['mention', 'review_status'] }] },
      rev(3),
    )
    // the stale tab switches "mention" off and "reply" on
    const put = await world.ben.req(
      'PUT',
      '/api/me/chat-prefs',
      { workspaceId: DEV_STUDIO, prefs: [{ hookId: world.hookId, kinds: ['reply'] }] },
      rev(2),
    )
    expect(put.statusCode, put.body).toBe(200)
    expect(Rev2ChatPrefsResponse.parse(put.json()).prefs).toEqual([
      { hookId: world.hookId, kinds: ['reply'] },
    ])
    expect(await stored()).toEqual([['reply', 'review_status']])
    // then everything off (the hook left out): the row stays with review_status only
    await world.ben.req('PUT', '/api/me/chat-prefs', { workspaceId: DEV_STUDIO, prefs: [] }, rev(2))
    expect(await stored()).toEqual([['review_status']])
    // a rev-3 build can turn it off
    await world.ben.req('PUT', '/api/me/chat-prefs', { workspaceId: DEV_STUDIO, prefs: [] }, rev(3))
    expect(await stored()).toEqual([])
  })
})

describe('the other foundation stubs', () => {
  it('a thread with a spot is refused (400 INVALID_ANCHOR) until WS3 stores it; nothing is written', async () => {
    const world = await chatWorld()
    w = world
    const res = await world.ben.req('POST', `/api/boards/${world.boardId}/threads`, {
      anchor: {
        kind: 'asset',
        shapeId: 'shape:card-1',
        assetId: 'ast_0123456789abcdefghij',
        versionId: 'ver_0123456789abcdefghij',
        timeMs: 12_400,
      },
      body: 'Here',
      spot: { u: 0.5, v: 0.5 },
    })
    expect(res.statusCode, res.body).toBe(400)
    expect((res.json() as { error: { code: string } }).error.code).toBe('INVALID_ANCHOR')
    expect((await world.api.db.one<{ n: number }>('SELECT count(*)::int AS n FROM comment_threads')).n).toBe(
      0,
    )
  })

  it('the new-version review reset leaves alone an item that is not about the asset (a frame: no asset)', async () => {
    const world = await chatWorld()
    w = world
    await reviewNotice(world, world.ben, world.owner)
    const items = await resetForNewVersion(world.api.db, {
      workspaceId: DEV_STUDIO,
      assetId: 'ast_0123456789abcdefghij',
      versionId: 'ver_0123456789abcdefghij',
      actorId: world.ben.userId,
    })
    expect(items).toEqual([])
    expect(await world.api.db.one('SELECT status FROM review_items')).toEqual({ status: 'approved' })
  })
})
