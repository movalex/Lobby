// K6-4: cursor chat (apps/api/src/features/workshops/cursor-chat.ts). POST /api/boards/:bid/cursor-chat
// relays a short line to the board's event stream for people who may comment, with the sender from the
// session, under per-person, per-board and per-link caps, and writes nothing to the database.
//
// The refusals matrix: viewer (403), a name-only guest whose link gives view only (403), a revoked grant
// (404), another board / no access / an outsider / a malformed or unknown id (404), signed out (401), an
// archived board (403), bad bodies (400). None of them publishes anything.
import { CURSOR_CHAT_EVENT, CURSOR_CHAT_RATE, CursorChatEvent } from '@draftroom/contracts'
import type { Db, QueryResult } from '@draftroom/db'
import { openTestDb } from '@draftroom/db/testing'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type DeliveredEvent, EventHub } from '../../../src/events/hub.ts'
import { CREATOR_ROUTES } from '../../../src/features/domain-access/guard.ts'
import { GUEST_REFUSED_ROUTES } from '../../../src/features/guests/guard.ts'
import { CURSOR_CHAT_ROUTE, cursorChatSettings } from '../../../src/features/workshops/cursor-chat.ts'
import { type Client, createBoard, createTestApi, DEV_STUDIO, type TestApi } from '../../helpers.ts'
import {
  errorCode,
  type GuestClient,
  guestLink,
  joinAsGuest,
  setupWorld,
  type World,
} from '../guests/support.ts'

let w: World
let heard: DeliveredEvent[]
const defaults = { ...cursorChatSettings }

beforeEach(async () => {
  w = await setupWorld()
  heard = []
  w.events.subscribe(w.board, (e) => heard.push(e))
})
afterEach(async () => {
  Object.assign(cursorChatSettings, defaults)
  await w.api.close()
})

const chat = (
  c: { req: Client['req'] | GuestClient['req'] },
  body: unknown = { text: 'Look at this one' },
  bid?: string,
) => c.req('POST', `/api/boards/${bid ?? w.board}/cursor-chat`, body)
const chats = () =>
  heard.filter((e) => e.type === CURSOR_CHAT_EVENT).map((e) => CursorChatEvent.parse(e.data))
const grant = async (c: Client, role: 'viewer' | 'commenter' | 'editor' | null) => {
  const res =
    role === null
      ? await w.bob.req('DELETE', `/api/boards/${w.board}/members/${c.userId}`)
      : await w.bob.req('PUT', `/api/boards/${w.board}/members/${c.userId}`, { role })
  expect(res.statusCode, res.body).toBe(200)
}

describe('K6-4: who may chat', () => {
  it('the owner, an editor and a commenter: 202, relayed with the session’s identity, whatever the body says', async () => {
    const res = await chat(w.bob, {
      text: 'Love this direction',
      at: { x: 10, y: -20 },
      userId: w.carol.userId,
      name: 'Mallory',
    })
    expect(res.statusCode, res.body).toBe(202)
    expect(res.json()).toEqual({ ok: true })
    expect(chats()).toEqual([
      { userId: w.bob.userId, name: w.bob.me.user.name, text: 'Love this direction', at: { x: 10, y: -20 } },
    ])
    for (const role of ['editor', 'commenter'] as const) {
      await grant(w.carol, role)
      expect((await chat(w.carol, { text: `as ${role}` })).statusCode).toBe(202)
    }
    expect(chats().map((c) => [c.userId, c.text])).toEqual([
      [w.bob.userId, 'Love this direction'],
      [w.carol.userId, 'as editor'],
      [w.carol.userId, 'as commenter'],
    ])
    // the event carries nothing else: no session, no email, no board content
    expect(Object.keys(heard.at(-1)?.data as object).sort()).toEqual(['name', 'text', 'userId'])
  })

  it('a viewer: 403, nothing relayed', async () => {
    await grant(w.carol, 'viewer')
    const res = await chat(w.carol)
    expect(res.statusCode).toBe(403)
    expect(errorCode(res)).toBe('FORBIDDEN')
    expect(chats()).toEqual([])
  })

  it('name-only guests: with comment through their link they chat (as "(guest)"); with view only, 403', async () => {
    const commenter = await joinAsGuest(
      w.api,
      (await guestLink(w.bob, w.board, { role: 'commenter' })).url,
      'Sam',
    )
    const res = await chat(commenter, { text: 'hello from Sam' })
    expect(res.statusCode, res.body).toBe(202)
    expect(chats()).toEqual([expect.objectContaining({ userId: commenter.userId, text: 'hello from Sam' })])
    expect(chats()[0]?.name).toContain('(guest)')
    const viewer = await joinAsGuest(w.api, (await guestLink(w.bob, w.board, { role: 'viewer' })).url, 'Vic')
    const refused = await chat(viewer)
    expect(refused.statusCode).toBe(403)
    expect(chats()).toHaveLength(1)
  })

  it('a revoked grant: 404 (the board is gone for them), nothing relayed', async () => {
    await grant(w.carol, 'commenter')
    expect((await chat(w.carol)).statusCode).toBe(202)
    await grant(w.carol, null)
    const res = await chat(w.carol)
    expect(res.statusCode).toBe(404)
    expect(chats()).toHaveLength(1)
  })

  it('another board, no access, an outsider, an unknown or malformed id: 404, the same answer; signed out: 401', async () => {
    const other = await createBoard(w.alice, DEV_STUDIO, 'Someone else’s')
    const others: DeliveredEvent[] = []
    w.events.subscribe(other, (e) => others.push(e))
    for (const [who, bid] of [
      [w.carol, w.board], // a member with no access to bob's private board
      [w.bob, other], // bob on alice's private board
      [w.erin, w.board], // not in the workspace at all
      [w.bob, 'b-0000000000'],
      [w.bob, 'not-a-board'],
    ] as const) {
      const res = await chat(who, undefined, bid)
      expect(res.statusCode, `${bid}: ${res.body}`).toBe(404)
      expect(errorCode(res)).toBe('NOT_FOUND')
    }
    const anon = await w.api.anon('POST', `/api/boards/${w.board}/cursor-chat`, { text: 'hi' })
    expect(anon.statusCode).toBe(401)
    expect(chats()).toEqual([])
    expect(others).toEqual([])
  })

  it('an archived board is read-only: 403', async () => {
    expect((await w.bob.req('POST', `/api/boards/${w.board}/archive`)).statusCode).toBe(200)
    expect((await chat(w.bob)).statusCode).toBe(403)
    expect(chats()).toEqual([])
  })

  it('a message that is not one: 400 (empty, nothing left after cleaning, too long, not text), nothing relayed', async () => {
    for (const body of [{}, { text: '' }, { text: ' ​‮ ' }, { text: 'a'.repeat(81) }, { text: 7 }]) {
      const res = await chat(w.bob, body)
      expect(res.statusCode, JSON.stringify(body)).toBe(400)
    }
    expect((await chat(w.bob, { text: '  spaced‮   out  ' })).statusCode).toBe(202)
    expect(chats().map((c) => c.text)).toEqual(['spaced out'])
  })

  it('is in neither the creator list nor the guest refusal list: it creates nothing and hands out no access', () => {
    const key = `POST ${CURSOR_CHAT_ROUTE}`
    expect(w.api.app.hasRoute({ method: 'POST', url: CURSOR_CHAT_ROUTE })).toBe(true)
    expect(CREATOR_ROUTES[key]).toBeUndefined()
    expect(GUEST_REFUSED_ROUTES[key]).toBeUndefined()
  })
})

describe('K6-4: the caps (the reactions’ pattern)', () => {
  it(`per person: ${CURSOR_CHAT_RATE.max} per ${CURSOR_CHAT_RATE.windowMs / 1000} s, across boards, then 429 with Retry-After`, async () => {
    const second = await createBoard(w.bob, DEV_STUDIO, 'Second')
    const codes: number[] = []
    for (let i = 0; i < CURSOR_CHAT_RATE.max; i++)
      codes.push((await chat(w.bob, { text: `m${i}` }, i % 2 ? second : w.board)).statusCode)
    expect(codes).toEqual(Array(CURSOR_CHAT_RATE.max).fill(202))
    const refused = await chat(w.bob)
    expect(refused.statusCode).toBe(429)
    expect(errorCode(refused)).toBe('RATE_LIMITED')
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0)
    // someone else is not held up by it
    await grant(w.carol, 'commenter')
    expect((await chat(w.carol)).statusCode).toBe(202)
    w.api.clock.advance(CURSOR_CHAT_RATE.windowMs + 100)
    expect((await chat(w.bob)).statusCode).toBe(202)
  })

  it('per board: past its share everyone waits (a big room cannot flood every stream)', async () => {
    await w.api.close()
    cursorChatSettings.perBoardMax = 3
    w = await setupWorld()
    heard = []
    w.events.subscribe(w.board, (e) => heard.push(e))
    await grant(w.carol, 'commenter')
    expect((await chat(w.bob)).statusCode).toBe(202)
    expect((await chat(w.bob)).statusCode).toBe(202)
    expect((await chat(w.carol)).statusCode).toBe(202)
    const refused = await chat(w.carol)
    expect(refused.statusCode).toBe(429)
    expect(refused.headers['retry-after']).toBeTruthy()
    expect(chats()).toHaveLength(3)
  })
})

/** A Db that records every statement sent through it (also inside transactions). */
function recording(base: Db): { db: Db; statements: string[] } {
  const statements: string[] = []
  const wrap = <Q extends { query: Db['query'] }>(q: Q) => {
    const query = async <T>(sql: string, params?: readonly unknown[]): Promise<QueryResult<T>> => {
      statements.push(sql.replace(/\s+/g, ' ').trim())
      return q.query<T>(sql, params)
    }
    return {
      query,
      one: async <T>(sql: string, params?: readonly unknown[]) => {
        const { rows } = await query<T>(sql, params)
        if (rows.length !== 1) throw new Error(`expected exactly one row, got ${rows.length}`)
        return rows[0] as T
      },
      maybeOne: async <T>(sql: string, params?: readonly unknown[]) => {
        const { rows } = await query<T>(sql, params)
        if (rows.length > 1) throw new Error(`expected at most one row, got ${rows.length}`)
        return (rows[0] ?? null) as T | null
      },
    }
  }
  const db: Db = {
    ...base,
    ...wrap(base),
    exec: (sql) => {
      statements.push(sql)
      return base.exec(sql)
    },
    transaction: (fn) => base.transaction((tx) => fn({ ...tx, ...wrap(tx), exec: tx.exec.bind(tx) })),
    close: () => base.close(),
  }
  return { db, statements }
}

describe('K6-4: never stored', () => {
  let api: TestApi
  let base: Db
  afterEach(async () => {
    await api?.close()
    await base?.close()
  })

  it('a message writes nothing to the database: no INSERT, UPDATE or DELETE of any table', async () => {
    base = await openTestDb()
    const rec = recording(base)
    const events = new EventHub()
    api = await createTestApi({ db: rec.db, deps: { events } })
    await api.login('alice')
    const bob = await api.login('bob')
    const board = await createBoard(bob, DEV_STUDIO, 'Quiet')
    const relayed: DeliveredEvent[] = []
    events.subscribe(board, (e) => relayed.push(e))
    rec.statements.length = 0
    for (let i = 0; i < 3; i++) {
      const res = await bob.req('POST', `/api/boards/${board}/cursor-chat`, { text: `note ${i}` })
      expect(res.statusCode, res.body).toBe(202)
    }
    expect(relayed.filter((e) => e.type === CURSOR_CHAT_EVENT)).toHaveLength(3)
    expect(rec.statements.length).toBeGreaterThan(0) // positive control: the access checks were recorded
    const writes = rec.statements.filter((s) => /^(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|COPY)\b/i.test(s))
    expect(writes).toEqual([])
    expect(rec.statements.some((s) => /FOR (UPDATE|SHARE)/i.test(s))).toBe(false)
  })
})
