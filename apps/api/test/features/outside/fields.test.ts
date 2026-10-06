// Wave J (AUTHZ-NO-OUTSIDER-SIGNAL / INV-1 / BRW-1, security audit 2026-10-05): whoever decides on
// access sees, from the server, whether a person is outside Dark Burn / TPG: `outside` (true, false or
// 'unconfirmed', from the stored creator status), the verified email domain and the masked address, on
// access requests, the Share dialog's member list and the workspace member list (owners and admins,
// and with ?boardId= a manager of that board: the Share dialog's picker for a board owner who is a
// plain member). User JSON stays clean, and nobody else gets the fields. canOwn is NOT the signal (a
// name-only guest and a never-checked account both differ from it). A colleague whose addresses are
// merely stale reads outside: false (no tag, no confirm). The board's "External" list goes to everyone
// who can view it, without the domain unless they manage access. The address check answers with the
// server's policy (the exceptions list included) to creators who manage the board only, at most
// ADDRESS_CHECKS_PER_USER times per window.

import {
  AccessRequest,
  AddressCheckResult,
  BoardOutsidePeople,
  ListNotificationsResponse,
  ListShareMembersResponse,
  ListThreadsResponse,
  ListWorkspaceMembersResponse,
  LOBBY_CLIENT_HEADER,
  LOBBY_CLIENT_REV,
  User,
} from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ADDRESS_CHECKS_PER_USER } from '../../../src/features/dashboard/outside.ts'
import { type Client, createBoard, createTestApi, DEV_STUDIO, type TestApi } from '../../helpers.ts'
import { point } from '../comments/fixture.ts'
import { guestLink, joinAsGuest } from '../guests/support.ts'

const EXCEPTION = 'owner@personal.example.test'
const ch = (...codes: number[]) => String.fromCodePoint(...codes)

let api: TestApi
let alice: Client // Dev Studio owner (creator)
let bob: Client // creator member, board owner
let carol: Client // creator member, viewer on the board (not a manager)
let pat: Client // outside account, not in the workspace (asks for access)
let sam: Client // outside account, Dev Studio member with a grant
let oscar: Client // the exceptions-list address: a creator
let board: string

beforeEach(async () => {
  api = await createTestApi({ env: { DRAFTROOM_CREATOR_EMAILS: EXCEPTION } })
  alice = await api.login('alice')
  bob = await api.login('bob')
  carol = await api.login('carol')
  pat = await api.login('pat', 'Pat Client', { email: 'pat@client.example.test' })
  sam = await api.login('sam', 'Sam Vendor', { email: 'sam@vendor.example.test' })
  oscar = await api.login('oscar', 'Oscar', { email: EXCEPTION })
  await api.db.query(
    `INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
     VALUES ($1, $2, 'member', now()), ($1, $3, 'member', now()) ON CONFLICT (workspace_id, user_id) DO NOTHING`,
    [DEV_STUDIO, sam.userId, oscar.userId],
  )
  board = await createBoard(bob, DEV_STUDIO, 'Pitch')
  for (const [c, role] of [
    [carol, 'viewer'],
    [sam, 'commenter'],
    [oscar, 'viewer'],
  ] as const) {
    const res = await bob.req('PUT', `/api/boards/${board}/members/${c.userId}`, { role })
    expect(res.statusCode, res.body).toBe(200)
  }
})
afterEach(() => api.close())

const requests = async (c: Client) => {
  const res = await c.req('GET', `/api/boards/${board}/access-requests`)
  expect(res.statusCode, res.body).toBe(200)
  return (res.json() as { requests: unknown[] }).requests.map((r) => AccessRequest.parse(r))
}
const members = async (c: Client) => {
  const res = await c.req('GET', `/api/boards/${board}/sharing/members`)
  expect(res.statusCode, res.body).toBe(200)
  return ListShareMembersResponse.parse(res.json()).members
}
const wsMembers = async (c: Client, query = '') => {
  const res = await c.req('GET', `/api/workspaces/${DEV_STUDIO}/members${query}`)
  expect(res.statusCode, res.body).toBe(200)
  return ListWorkspaceMembersResponse.parse(res.json()).members
}
const outsideList = async (c: Client) => {
  const res = await c.req('GET', `/api/boards/${board}/sharing/outside`)
  expect(res.statusCode, res.body).toBe(200)
  return BoardOutsidePeople.parse(res.json())
}

describe('access requests', () => {
  it('say who is outside, with the verified domain and the masked address; User stays clean', async () => {
    expect(
      (await pat.req('POST', `/api/boards/${board}/access-requests`, { role: 'editor' })).statusCode,
    ).toBe(202)
    const [req] = await requests(bob)
    expect(req).toMatchObject({
      outside: true,
      emailDomain: 'client.example.test',
      emailHint: 'p•••@client.example.test',
      user: { id: pat.userId, name: 'Pat Client' },
    })
    // The user object is exactly User's five fields: no email, domain or flag inside it.
    const raw = (await bob.req('GET', `/api/boards/${board}/access-requests`)).json() as {
      requests: { user: Record<string, unknown> }[]
    }
    expect(Object.keys(raw.requests[0]?.user ?? {}).sort()).toEqual(Object.keys(User.shape).sort())
    // The full address appears nowhere.
    expect(JSON.stringify(raw)).not.toContain('pat@client.example.test')
  })

  it('a creator requester is not outside; one whose addresses were never checked is unconfirmed', async () => {
    const dave = await api.login('dave')
    await api.db.query('DELETE FROM workspace_members WHERE user_id = $1', [dave.userId])
    const erin = await api.login('erin', 'Erin', { email: 'erin@darkburn.com' })
    await api.db.query('DELETE FROM workspace_members WHERE user_id = $1', [erin.userId])
    for (const c of [dave, erin])
      expect(
        (await c.req('POST', `/api/boards/${board}/access-requests`, { role: 'viewer' })).statusCode,
      ).toBe(202)
    // erin's addresses (darkburn.com, a creator domain) were never confirmed: Lobby cannot tell.
    await api.db.query('UPDATE users SET identity_checked_at = NULL WHERE id = $1', [erin.userId])
    const byId = Object.fromEntries((await requests(bob)).map((r) => [r.user.id, r]))
    expect(byId[dave.userId]).toMatchObject({ outside: false, emailDomain: 'dev.invalid' })
    expect(byId[erin.userId]).toMatchObject({ outside: 'unconfirmed', emailDomain: 'darkburn.com' })
  })

  it('the approve answer carries the fields too, and the message lost its bidi and zero-width characters', async () => {
    const message = `new laptop${ch(0x202e)}, lost${ch(0x200b)} access${ch(0x0007)}`
    await pat.req('POST', `/api/boards/${board}/access-requests`, { role: 'commenter', message })
    const [req] = await requests(bob)
    expect(req?.message).toBe('new laptop, lost access')
    const res = await bob.req('POST', `/api/access-requests/${req?.id}/approve`, {})
    expect(res.statusCode, res.body).toBe(200)
    expect(AccessRequest.parse((res.json() as { request: unknown }).request)).toMatchObject({
      status: 'approved',
      outside: true,
      emailDomain: 'client.example.test',
    })
  })
})

describe('the Share dialog and the workspace member lists', () => {
  it('share members (managers only) mark the outside account, and canOwn is not the signal', async () => {
    const link = await guestLink(bob, board, { role: 'viewer' })
    const dana = await joinAsGuest(api, link.url, 'Dana')
    await api.db.query("UPDATE users SET identity_checked_at = now() - interval '25 hours' WHERE id = $1", [
      carol.userId,
    ])
    const rows = Object.fromEntries((await members(bob)).map((m) => [m.user.id, m]))
    expect(rows[sam.userId]).toMatchObject({
      outside: true,
      emailDomain: 'vendor.example.test',
      canOwn: false,
    })
    expect(rows[bob.userId]).toMatchObject({ outside: false, canOwn: true })
    // The exceptions-list address is a creator, whatever its domain.
    expect(rows[oscar.userId]).toMatchObject({ outside: false, emailDomain: 'personal.example.test' })
    // carol's company address is a day old: still a colleague here (no tag, no confirm; the server
    // refreshes her at PUT), canOwn true.
    expect(rows[carol.userId]).toMatchObject({ outside: false, canOwn: true, emailDomain: 'dev.invalid' })
    // A name-only guest: outside (no address), and canOwn false.
    expect(rows[dana.userId]).toMatchObject({ outside: true, emailDomain: null, canOwn: false })
    // Not a manager: no access to the list at all (as before).
    expect((await carol.req('GET', `/api/boards/${board}/sharing/members`)).statusCode).toBe(403)
  })

  it('workspace members: owners and admins get the fields; members do not, unless they manage ?boardId=', async () => {
    // pat, an outside client, joined ANOTHER board of the workspace (alice's): a workspace guest now,
    // the person bob might pick for his board.
    const other = await createBoard(alice, DEV_STUDIO, 'Other pitch')
    await api.db.query(
      "INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ($1, $2, 'guest', now())",
      [DEV_STUDIO, pat.userId],
    )
    expect(
      (await alice.req('PUT', `/api/boards/${other}/members/${pat.userId}`, { role: 'viewer' })).statusCode,
    ).toBe(200)
    const forAlice = Object.fromEntries((await wsMembers(alice)).map((m) => [m.user.id, m]))
    expect(forAlice[sam.userId]).toMatchObject({ outside: true, emailDomain: 'vendor.example.test' })
    expect(forAlice[bob.userId]).toMatchObject({ outside: false })
    const none = (list: Awaited<ReturnType<typeof wsMembers>>) => {
      for (const m of list) {
        expect(m.outside).toBeUndefined()
        expect(m.emailDomain).toBeUndefined()
        expect(m.emailHint).toBeUndefined()
      }
    }
    none(await wsMembers(bob))
    // bob (a plain member) owns `board`: as its manager, his picker learns who is outside.
    const forBob = Object.fromEntries((await wsMembers(bob, `?boardId=${board}`)).map((m) => [m.user.id, m]))
    expect(forBob[pat.userId]).toMatchObject({
      outside: true,
      emailDomain: 'client.example.test',
      emailHint: 'p•••@client.example.test',
    })
    expect(forBob[sam.userId]).toMatchObject({ outside: true, emailDomain: 'vendor.example.test' })
    expect(forBob[carol.userId]).toMatchObject({ outside: false })
    expect(Object.keys(forBob[pat.userId]?.user ?? {}).sort()).toEqual(Object.keys(User.shape).sort())
    // Not for a board he cannot manage (alice's), nor for nonsense, nor for carol (a viewer of `board`).
    none(await wsMembers(bob, `?boardId=${other}`))
    none(await wsMembers(bob, '?boardId=not-a-board'))
    none(await wsMembers(carol, `?boardId=${board}`))
    // A board of another workspace (bob's personal one) gives nothing here either.
    const personal = await api.db.one<{ id: string }>(
      "SELECT w.id FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.id WHERE m.user_id = $1 AND m.role = 'owner' AND w.id <> $2 LIMIT 1",
      [bob.userId, DEV_STUDIO],
    )
    const elsewhere = await createBoard(bob, personal.id, 'Mine')
    none(await wsMembers(bob, `?boardId=${elsewhere}`))
  })

  it('display names in those lists lose control, bidi and zero-width characters', async () => {
    await api.db.query('UPDATE users SET name = $2 WHERE id = $1', [
      sam.userId,
      `Bo${ch(0x200d)}b${ch(0x202e)}`,
    ])
    const row = (await members(bob)).find((m) => m.user.id === sam.userId)
    expect(row?.user.name).toBe('Bob')
    expect((await wsMembers(alice)).find((m) => m.user.id === sam.userId)?.user.name).toBe('Bob')
    // Everyone's list, not only the managers'.
    expect((await wsMembers(carol)).find((m) => m.user.id === sam.userId)?.user.name).toBe('Bob')
    // A joiner inside an emoji sequence or Persian spelling is part of the name, and stays.
    const persian = `Mi${ch(0x200c)}x ${ch(0x0645, 0x06cc, 0x200c, 0x062e)} ${ch(0x1f469, 0x200d, 0x1f4bb)}`
    await api.db.query('UPDATE users SET name = $2 WHERE id = $1', [sam.userId, persian])
    expect((await members(bob)).find((m) => m.user.id === sam.userId)?.user.name).toBe(
      `Mix ${ch(0x0645, 0x06cc, 0x200c, 0x062e)} ${ch(0x1f469, 0x200d, 0x1f4bb)}`,
    )
  })

  it('names and messages stored before the cleaning are cleaned where an owner reads them: the bell, comments', async () => {
    const raw = `Sam${ch(0x202e)} Vendor${ch(0x200b)}`
    await api.db.query('UPDATE users SET name = $2 WHERE id = $1', [pat.userId, raw])
    expect(
      (await pat.req('POST', `/api/boards/${board}/access-requests`, { role: 'viewer' })).statusCode,
    ).toBe(202)
    // A message stored before the input cleaning (written directly).
    await api.db.query('UPDATE access_requests SET message = $2 WHERE user_id = $1', [
      pat.userId,
      `please${ch(0x202e)} let me in${ch(0x0007)}`,
    ])
    const [req] = await requests(bob)
    expect(req).toMatchObject({ message: 'please let me in', user: { name: 'Sam Vendor' } })
    const bell = await bob.req('GET', '/api/me/notifications', undefined, {
      [LOBBY_CLIENT_HEADER]: String(LOBBY_CLIENT_REV),
    })
    expect(bell.statusCode, bell.body).toBe(200)
    const item = ListNotificationsResponse.parse(bell.json()).notifications.find(
      (n) => n.kind === 'access_request',
    )
    expect(item?.actor?.name).toBe('Sam Vendor')
    expect(item?.accessRequest?.message).toBe('please let me in')
    // A comment author.
    await api.db.query('UPDATE users SET name = $2 WHERE id = $1', [sam.userId, raw])
    const posted = await sam.req('POST', `/api/boards/${board}/threads`, { anchor: point(), body: 'hello' })
    expect(posted.statusCode, posted.body).toBe(201)
    const threads = ListThreadsResponse.parse(
      (await bob.req('GET', `/api/boards/${board}/threads?status=all`)).json(),
    ).threads
    expect(threads[0]?.comments[0]?.author.name).toBe('Sam Vendor')
  })
})

describe('the board’s outside people (everyone who can view it)', () => {
  it('lists the outside accounts; the domain only for people who manage access; no name-only guests', async () => {
    const link = await guestLink(bob, board, { role: 'viewer' })
    await joinAsGuest(api, link.url, 'Dana')
    const forBob = await outsideList(bob)
    expect(forBob.people).toEqual([{ userId: sam.userId, emailDomain: 'vendor.example.test' }])
    expect(forBob.sharedOutside).toBe(true)
    expect(forBob.internalOnly).toBeNull()
    const forCarol = await outsideList(carol)
    expect(forCarol.people).toEqual([{ userId: sam.userId, emailDomain: null }])
    // The outsider sees themselves tagged too; someone who cannot view the board gets 404.
    expect((await outsideList(sam)).people.map((p) => p.userId)).toEqual([sam.userId])
    expect((await pat.req('GET', `/api/boards/${board}/sharing/outside`)).statusCode).toBe(404)
  })
})

describe('the address check (the Share dialog asks before it invites)', () => {
  const check = (c: Client, email: string) =>
    c.req('POST', `/api/boards/${board}/sharing/address-check`, { email })

  it("answers with the server's policy, exceptions list included", async () => {
    const ok = async (email: string) => {
      const res = await check(bob, email)
      expect(res.statusCode, res.body).toBe(200)
      return AddressCheckResult.parse(res.json())
    }
    expect(await ok('Lobby-Test-Ana@DarkBurn.com')).toEqual({
      email: 'lobby-test-ana@darkburn.com',
      outside: false,
      emailDomain: 'darkburn.com',
      internalOnly: null,
    })
    expect(await ok(EXCEPTION)).toMatchObject({ outside: false })
    expect(await ok('x@client.example.test')).toMatchObject({
      outside: true,
      emailDomain: 'client.example.test',
    })
    expect(await ok('y@darkburn.com.evil.test')).toMatchObject({ outside: true })
  })

  it('is for creators who manage the board only', async () => {
    expect((await check(carol, 'x@client.example.test')).statusCode).toBe(403)
    expect((await check(pat, 'x@client.example.test')).statusCode).toBe(404)
    // A pre-existing outside owner manages the board but is no creator (D4).
    await api.db.query("UPDATE board_members SET role = 'owner' WHERE board_id = $1 AND user_id = $2", [
      board,
      sam.userId,
    ])
    const res = await check(sam, 'x@client.example.test')
    expect(res.statusCode).toBe(403)
    expect((res.json() as { error: { code: string } }).error.code).toBe('CREATOR_REQUIRED')
    expect((await check(bob, 'not an address')).statusCode).toBe(400)
  })

  it('is rate limited per caller (no walking a list of addresses against the policy)', async () => {
    for (let i = 0; i < ADDRESS_CHECKS_PER_USER.max; i++)
      expect((await check(bob, `p${i}@client.example.test`)).statusCode).toBe(200)
    const over = await check(bob, 'one-more@client.example.test')
    expect(over.statusCode).toBe(429)
    expect((over.json() as { error: { code: string } }).error.code).toBe('RATE_LIMITED')
    // Per caller: alice (who also manages the board) still checks.
    expect((await check(alice, 'x@client.example.test')).statusCode).toBe(200)
    // Refused callers are not counted, and learn nothing from the limit (carol: 403 as before).
    expect((await check(carol, 'x@client.example.test')).statusCode).toBe(403)
  })
})
