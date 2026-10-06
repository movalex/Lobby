// Wave J: the "Shared outside" marker (the board's top bar and its dashboard card) is a server-computed
// flag on the board summary (ShareState.sharedOutside) and on the dashboard's board lists: true while
// an account outside Dark Burn / TPG or a name-only guest can open the board (a grant; owner or admin
// of the workspace; member while the board is not private), or a review, workshop or guest link is
// open. Accounts Lobby cannot confirm (stale or never-checked staff) do not turn it on.

import { ListBoardsWithThumbnailsResponse, ReviewLinkCreated, ShareState } from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type Client, createBoard, createTestApi, DEV_STUDIO, type TestApi } from '../../helpers.ts'
import { guestLink, joinAsGuest } from '../guests/support.ts'

let api: TestApi
let bob: Client
let carol: Client
let pat: Client // outside account
let board: string
let other: string

beforeEach(async () => {
  api = await createTestApi()
  await api.login('alice') // the first login owns Dev Studio
  bob = await api.login('bob')
  carol = await api.login('carol')
  pat = await api.login('pat', 'Pat Client', { email: 'pat@client.example.test' })
  await api.db.query(
    "INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ($1, $2, 'guest', now())",
    [DEV_STUDIO, pat.userId],
  )
  board = await createBoard(bob, DEV_STUDIO, 'Shared one')
  other = await createBoard(bob, DEV_STUDIO, 'Quiet one')
  expect(
    (await bob.req('PUT', `/api/boards/${board}/members/${carol.userId}`, { role: 'viewer' })).statusCode,
  ).toBe(200)
})
afterEach(() => api.close())

const flag = async (c: Client, id: string) => {
  const res = await c.req('GET', `/api/boards/${id}/sharing`)
  expect(res.statusCode, res.body).toBe(200)
  return ShareState.parse(res.json()).sharedOutside
}
const cards = async (c: Client, starred = false) => {
  const res = await c.req('GET', `/api/workspaces/${DEV_STUDIO}/boards${starred ? '/starred' : ''}`)
  expect(res.statusCode, res.body).toBe(200)
  return Object.fromEntries(
    ListBoardsWithThumbnailsResponse.parse(res.json()).boards.map((b) => [b.id, b.sharedOutside]),
  )
}

describe('Shared outside', () => {
  it('is off for staff-only boards, on with an outside grant, off again when it goes', async () => {
    expect(await flag(bob, board)).toBe(false)
    expect(await cards(bob)).toEqual({ [board]: false, [other]: false })
    expect(
      (await bob.req('PUT', `/api/boards/${board}/members/${pat.userId}`, { role: 'viewer' })).statusCode,
    ).toBe(200)
    // everyone who can see the board sees the marker (it names nobody)
    expect(await flag(bob, board)).toBe(true)
    expect(await flag(carol, board)).toBe(true)
    expect(await flag(pat, board)).toBe(true)
    expect(await cards(bob)).toEqual({ [board]: true, [other]: false })
    // the starred list carries it too
    expect((await bob.req('PUT', `/api/boards/${board}/star`)).statusCode).toBe(200)
    expect(await cards(bob, true)).toEqual({ [board]: true })
    expect((await bob.req('DELETE', `/api/boards/${board}/members/${pat.userId}`)).statusCode).toBe(200)
    expect(await flag(bob, board)).toBe(false)
  })

  it('is on while a review, workshop or guest link is open, and while a name-only guest has the board', async () => {
    const link = ReviewLinkCreated.parse(
      (await bob.req('POST', `/api/boards/${other}/review-links`, { role: 'commenter' })).json(),
    )
    expect(await flag(bob, other)).toBe(true)
    expect(
      (await bob.req('POST', `/api/boards/${other}/review-links/${link.id}/revoke`, {})).statusCode,
    ).toBe(200)
    expect(await flag(bob, other)).toBe(false)
    const guests = await guestLink(bob, other, { role: 'viewer' })
    const dana = await joinAsGuest(api, guests.url, 'Dana')
    // revoke the link but keep the people who joined: the guest still has the board
    expect(
      (
        await bob.req('POST', `/api/boards/${other}/review-links/${guests.id}/revoke`, {
          removeAccess: false,
        })
      ).statusCode,
    ).toBe(200)
    expect(await flag(bob, other)).toBe(true)
    expect((await bob.req('DELETE', `/api/boards/${other}/members/${dana.userId}`)).statusCode).toBe(200)
    expect(await flag(bob, other)).toBe(false)
  })

  it('counts an outside workspace member while the board is not private, and an outside admin always', async () => {
    await api.db.query(
      "UPDATE workspace_members SET role = 'member' WHERE workspace_id = $1 AND user_id = $2",
      [DEV_STUDIO, pat.userId],
    )
    expect(await flag(bob, board)).toBe(false) // private: a member without a grant cannot open it
    expect(
      (await bob.req('PATCH', `/api/boards/${board}`, { visibility: 'workspace_view' })).statusCode,
    ).toBe(200)
    expect(await flag(bob, board)).toBe(true)
    await api.db.query(
      "UPDATE workspace_members SET role = 'admin' WHERE workspace_id = $1 AND user_id = $2",
      [DEV_STUDIO, pat.userId],
    )
    expect(await cards(bob)).toEqual({ [board]: true, [other]: true })
  })

  it('stays off for staff whose addresses are only stale (Lobby cannot tell, and they are mostly staff)', async () => {
    await api.db.query("UPDATE users SET identity_checked_at = now() - interval '30 days' WHERE id = $1", [
      carol.userId,
    ])
    expect(await flag(bob, board)).toBe(false)
    // an outside account stays outside however long ago it was checked
    expect(
      (await bob.req('PUT', `/api/boards/${board}/members/${pat.userId}`, { role: 'viewer' })).statusCode,
    ).toBe(200)
    await api.db.query("UPDATE users SET identity_checked_at = now() - interval '30 days' WHERE id = $1", [
      pat.userId,
    ])
    expect(await flag(bob, board)).toBe(true)
  })
})
