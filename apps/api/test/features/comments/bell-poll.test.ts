// Wave M, M5-3 (CAP-BELL-POLL): the bell poll was 79% of all api traffic, four queries a minute per visible tab
// for nothing new. GET /api/me/notifications?since=<seq> answers 204 after one indexed read when the caller's
// newest notification is still the one the client holds; otherwise the list as without `since`, plus `seq`. The
// list and its unread count are one statement now.
import { ListNotificationsResponse } from '@draftroom/contracts'
import type { Db } from '@draftroom/db'
import { openTestDb } from '@draftroom/db/testing'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventHub } from '../../../src/events/hub.ts'
import { type Client, createBoard, createTestApi, DEV_STUDIO, type TestApi } from '../../helpers.ts'
import { countQueries, isSessionLookup, type QueryCounter } from '../../query-count.ts'
import { guestLink, joinAsGuest } from '../guests/support.ts'
import { createThread, mention } from './fixture.ts'

let base: Db
let counter: QueryCounter
let api: TestApi
let owner: Client
let alice: Client
let bob: Client
let board: string

beforeEach(async () => {
  base = await openTestDb()
  counter = countQueries(base)
  api = await createTestApi({ db: counter.db, deps: { events: new EventHub() } })
  owner = await api.login('owner', 'Olive Owner')
  alice = await api.login('alice', 'Alice Able')
  bob = await api.login('bob', 'Bob Baker')
  board = await createBoard(owner, DEV_STUDIO, 'Bell board')
  for (const c of [alice, bob])
    expect(
      (await owner.req('PUT', `/api/boards/${board}/members/${c.userId}`, { role: 'editor' })).statusCode,
    ).toBe(200)
})
afterEach(async () => {
  await api.close()
  await base.close()
})

const bell = (c: Client, query = '') => c.req('GET', `/api/me/notifications${query}`)
const listOf = (res: { json(): unknown }) => ListNotificationsResponse.parse(res.json())
/** Alice gets one more notification: the owner mentions her in a new thread. */
const mentionAlice = (text = 'Look') => createThread(owner, board, `${text} ${mention(alice)}`)

describe('GET /api/me/notifications?since (the bell poll)', () => {
  it('since equal to the newest seq answers 204, no body, after one query besides the session lookup', async () => {
    await mentionAlice()
    const first = await bell(alice, '?since=0')
    expect(first.statusCode).toBe(200)
    const { seq } = listOf(first)
    expect(seq).toBeGreaterThan(0)
    counter.reset()
    const res = await bell(alice, `?since=${seq}`)
    expect(res.statusCode).toBe(204)
    expect(res.body).toBe('')
    const own = counter.statements.filter((s) => !isSessionLookup(s))
    expect(counter.statements.filter(isSessionLookup)).toHaveLength(1)
    expect(own.map((s) => s.sql)).toEqual([
      'SELECT max(seq)::text AS seq FROM notifications WHERE user_id = $1',
    ])
    expect(counter.transactions).toBe(0)
  })

  it('a newer item gives 200 with the same body as without since, plus the new seq', async () => {
    await mentionAlice('one')
    const { seq: before } = listOf(await bell(alice, '?since=0'))
    await mentionAlice('two')
    const res = await bell(alice, `?since=${before}`)
    expect(res.statusCode).toBe(200)
    const withSince = listOf(res)
    expect(withSince.seq).toBeGreaterThan(before ?? 0)
    const plain = await bell(alice)
    expect(plain.statusCode).toBe(200)
    // the body without since is exactly today's: no seq in it
    expect(Object.keys(plain.json() as object).sort()).toEqual(['notifications', 'unreadCount'])
    const { seq: _seq, ...rest } = withSince
    expect(rest).toEqual(plain.json())
    expect(rest.notifications).toHaveLength(2)
    expect(rest.unreadCount).toBe(2)
    // and then nothing new again
    expect((await bell(alice, `?since=${withSince.seq}`)).statusCode).toBe(204)
  })

  it('another person’s notifications never count', async () => {
    await mentionAlice()
    const { seq } = listOf(await bell(alice, '?since=0'))
    // bob gets three, alice none
    for (let i = 0; i < 3; i++) await createThread(owner, board, `For bob ${i} ${mention(bob)}`)
    expect((await bell(alice, `?since=${seq}`)).statusCode).toBe(204)
    expect(listOf(await bell(bob, `?since=${seq}`)).notifications).toHaveLength(3)
  })

  it('a removed notification (the newest one gone) is not "nothing new": the list comes back', async () => {
    const t = await mentionAlice()
    const { seq } = listOf(await bell(alice, '?since=0'))
    await base.query('DELETE FROM notifications WHERE thread_id = $1', [t.id])
    const res = await bell(alice, `?since=${seq}`)
    expect(res.statusCode).toBe(200)
    expect(listOf(res)).toEqual({ notifications: [], unreadCount: 0, seq: 0 })
    // nothing at all, and the client says it holds nothing: 204
    expect((await bell(alice, '?since=0')).statusCode).toBe(204)
  })

  it('reading notifications elsewhere does not change the seq (the client asks for the whole list then)', async () => {
    await mentionAlice()
    const { seq } = listOf(await bell(alice, '?since=0'))
    expect((await alice.req('POST', '/api/me/notifications/read', { all: true })).statusCode).toBe(204)
    expect((await bell(alice, `?since=${seq}`)).statusCode).toBe(204)
    expect(listOf(await bell(alice)).unreadCount).toBe(0)
  })

  it('needs a session, and a well-formed since', async () => {
    expect((await api.anon('GET', '/api/me/notifications?since=0')).statusCode).toBe(401)
    for (const bad of ['-1', 'abc', '1.5', '9'.repeat(16), ''])
      expect((await bell(alice, `?since=${bad}`)).statusCode, bad).toBe(400)
  })

  it('a name-only guest polls their own bell the same way (no new route, no other rows)', async () => {
    const link = await guestLink(owner, board, { role: 'editor' })
    const sam = await joinAsGuest(api, link.url, 'Sam')
    await mentionAlice()
    const first = await sam.req('GET', '/api/me/notifications?since=0')
    // Sam has none: the newest is 0, so "since 0" is nothing new
    expect(first.statusCode).toBe(204)
    const plain = await sam.req('GET', '/api/me/notifications')
    expect(plain.statusCode).toBe(200)
    expect(listOf(plain)).toEqual({ notifications: [], unreadCount: 0 })
  })

  it('the unread=1 list keeps its meaning with since', async () => {
    await mentionAlice('one')
    await mentionAlice('two')
    const all = listOf(await bell(alice))
    const newest = all.notifications[0]?.id as string
    await alice.req('POST', '/api/me/notifications/read', { ids: [newest] })
    const unread = listOf(await bell(alice, '?unread=1&since=0'))
    expect(unread.notifications.map((n) => n.id)).not.toContain(newest)
    expect(unread.notifications).toHaveLength(1)
    expect(unread.unreadCount).toBe(1)
  })
})

describe('the list and its unread count are one statement (M5-3)', () => {
  it('a full bell read costs the session lookup, the creator check and one list statement', async () => {
    await mentionAlice('one')
    await mentionAlice('two')
    counter.reset()
    const res = await bell(alice)
    expect(res.statusCode).toBe(200)
    const own = counter.statements.filter((s) => !isSessionLookup(s))
    expect(own).toHaveLength(2)
    expect(own.filter((s) => /^WITH picked AS/.test(s.sql))).toHaveLength(1)
    expect(listOf(res).unreadCount).toBe(2)
  })

  it('the count covers unread items older than the listed ones, the list stops at 100', async () => {
    // 105 unread mentions (one real one, copied): the list shows 100, the count says 105
    await mentionAlice()
    for (let i = 0; i < 104; i++)
      await base.query(
        `INSERT INTO notifications (workspace_id, user_id, kind, board_id, thread_id, comment_id, actor_id)
         SELECT workspace_id, user_id, kind, board_id, thread_id, comment_id, actor_id
           FROM notifications WHERE user_id = $1 LIMIT 1`,
        [alice.userId],
      )
    const list = listOf(await bell(alice))
    expect(list.notifications).toHaveLength(100)
    expect(list.unreadCount).toBe(105)
    // read the newest 100: the 5 older unread ones are still counted, though the list's 100 are all read
    await alice.req('POST', '/api/me/notifications/read', { ids: list.notifications.map((n) => n.id) })
    const after = listOf(await bell(alice))
    expect(after.unreadCount).toBe(5)
    expect(after.notifications.filter((n) => n.readAt === null)).toHaveLength(0)
    const unreadOnly = listOf(await bell(alice, '?unread=1'))
    expect(unreadOnly.notifications).toHaveLength(5)
    expect(unreadOnly.unreadCount).toBe(5)
  })
})
