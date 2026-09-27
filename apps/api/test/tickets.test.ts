import { TICKET_TTL_MS, verifyTicket } from '@draftroom/auth-tickets'
import { InternalAccessResponse, TicketResponse } from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type Client,
  createBoard,
  createTestApi,
  DEV_STUDIO,
  INTERNAL_SECRET,
  type TestApi,
  TICKET_SECRET,
} from './helpers.ts'

let api: TestApi
let alice: Client // Dev Studio owner
let bob: Client
let carol: Client
let boardId: string

beforeEach(async () => {
  api = await createTestApi()
  alice = await api.login('alice')
  bob = await api.login('bob', 'Bob B')
  carol = await api.login('carol')
  boardId = await createBoard(bob, DEV_STUDIO, 'Live')
})
afterEach(() => api.close())

async function ticket(c: Client, bid = boardId) {
  const res = await c.req('POST', `/api/boards/${bid}/ticket`)
  return { res, body: res.statusCode === 200 ? TicketResponse.parse(res.json()) : null }
}

const access = async (bid: string, uid: string, secret: string | null = INTERNAL_SECRET) => {
  const res = await api.app.inject({
    method: 'GET',
    url: `/internal/access?boardId=${bid}&userId=${uid}`,
    headers: secret === null ? {} : { 'x-draftroom-internal': secret },
  })
  return res
}
const roleFor = async (uid: string, bid = boardId) => {
  const res = await access(bid, uid)
  expect(res.statusCode, res.body).toBe(200)
  return InternalAccessResponse.parse(res.json()).role
}

describe('board tickets', () => {
  it('signs bid/uid/name/color/role for 60 s, verifiable with the ticket secret', async () => {
    const { res, body } = await ticket(bob)
    expect(res.statusCode).toBe(200)
    expect(body?.role).toBe('owner')
    expect(body?.user).toEqual({ id: bob.userId, name: 'Bob B', color: bob.me.user.color })
    const verified = verifyTicket(TICKET_SECRET, body?.ticket, { boardId })
    expect(verified.ok).toBe(true)
    if (!verified.ok) return
    expect(verified.claims).toMatchObject({ bid: boardId, uid: bob.userId, name: 'Bob B', role: 'owner' })
    expect(verified.claims.exp - verified.claims.iat).toBe(TICKET_TTL_MS)
    expect(body?.expiresAt).toBe(verified.claims.exp)
    // Bound to its board and to our secret.
    expect(verifyTicket(TICKET_SECRET, body?.ticket, { boardId: 'b-othersboard' }).ok).toBe(false)
    expect(verifyTicket(INTERNAL_SECRET, body?.ticket, { boardId }).ok).toBe(false)
  })

  it('carries the caller role from the permission rules', async () => {
    await bob.req('PUT', `/api/boards/${boardId}/members/${carol.userId}`, { role: 'commenter' })
    expect((await ticket(carol)).body?.role).toBe('commenter')
    expect((await ticket(alice)).body?.role).toBe('owner') // workspace owner
  })

  it('is 404 without access, for unknown boards and without a session 401', async () => {
    expect((await ticket(carol)).res.statusCode).toBe(404)
    expect((await ticket(carol, 'b-0000000000')).res.statusCode).toBe(404)
    expect((await api.anon('POST', `/api/boards/${boardId}/ticket`)).statusCode).toBe(401)
  })

  it('archived boards cap every ticket at viewer; trashed boards get none, owners included', async () => {
    await bob.req('PUT', `/api/boards/${boardId}/members/${carol.userId}`, { role: 'editor' })
    await bob.req('POST', `/api/boards/${boardId}/archive`)
    expect((await ticket(bob)).body?.role).toBe('viewer')
    expect((await ticket(carol)).body?.role).toBe('viewer')
    await bob.req('POST', `/api/boards/${boardId}/trash`)
    expect((await ticket(bob)).res.statusCode).toBe(404)
    expect((await ticket(alice)).res.statusCode).toBe(404)
    await bob.req('POST', `/api/boards/${boardId}/restore`)
    expect((await ticket(carol)).body?.role).toBe('editor')
  })
})

describe('GET /internal/access', () => {
  it('rejects a missing or wrong internal secret', async () => {
    expect((await access(boardId, bob.userId, null)).statusCode).toBe(401)
    expect((await access(boardId, bob.userId, 'x'.repeat(INTERNAL_SECRET.length))).statusCode).toBe(401)
    expect((await access(boardId, bob.userId, TICKET_SECRET)).statusCode).toBe(401)
    // A browser session is not an internal credential.
    const withCookie = await api.app.inject({
      method: 'GET',
      url: `/internal/access?boardId=${boardId}&userId=${bob.userId}`,
      headers: { cookie: bob.cookie },
    })
    expect(withCookie.statusCode).toBe(401)
  })

  it('answers the same role as the ticket route, and follows grants, visibility and status', async () => {
    expect(await roleFor(bob.userId)).toBe('owner')
    expect(await roleFor(carol.userId)).toBeNull()
    await bob.req('PATCH', `/api/boards/${boardId}`, { visibility: 'workspace_view' })
    expect(await roleFor(carol.userId)).toBe('viewer')
    await bob.req('PUT', `/api/boards/${boardId}/members/${carol.userId}`, { role: 'editor' })
    expect(await roleFor(carol.userId)).toBe((await ticket(carol)).body?.role ?? 'missing')
    await bob.req('POST', `/api/boards/${boardId}/archive`)
    expect(await roleFor(carol.userId)).toBe('viewer')
    expect(await roleFor(bob.userId)).toBe('viewer')
    await bob.req('POST', `/api/boards/${boardId}/trash`)
    expect(await roleFor(bob.userId)).toBeNull()
    await bob.req('POST', `/api/boards/${boardId}/restore`)
    await bob.req('DELETE', `/api/boards/${boardId}/members/${carol.userId}`)
    expect(await roleFor(carol.userId)).toBe('viewer') // still workspace_view
  })

  it('is null for unknown boards/users and 400 for malformed ids', async () => {
    expect(await roleFor('usr_00000000000000000000')).toBeNull()
    expect(await roleFor(bob.userId, 'b-0000000000')).toBeNull()
    expect((await access('Not_A_Board!', bob.userId)).statusCode).toBe(400)
    expect((await access(boardId, 'alice')).statusCode).toBe(400)
  })
})
