import { ListBoardsResponse, ListBoardsWithStarsResponse, StarResponse } from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type Client, createBoard, DEV_STUDIO } from '../../helpers.ts'
import { setupWorld, type World } from './setup.ts'

let w: World
beforeEach(async () => {
  w = await setupWorld()
})
afterEach(() => w.api.close())

const listed = async (c: Client, path = `/api/workspaces/${DEV_STUDIO}/boards`) => {
  const res = await c.req('GET', path)
  expect(res.statusCode, res.body).toBe(200)
  return ListBoardsWithStarsResponse.parse(res.json()).boards
}
const starredIds = async (c: Client, query = '') =>
  (await listed(c, `/api/workspaces/${DEV_STUDIO}/boards/starred${query}`)).map((b) => b.id)

describe('board stars', () => {
  it('star and unstar a board you can view; both are idempotent and per user', async () => {
    const { bob, carol, board } = w
    const put = await bob.req('PUT', `/api/boards/${board}/star`)
    expect(put.statusCode).toBe(200)
    expect(StarResponse.parse(put.json())).toEqual({ boardId: board, starred: true })
    expect((await bob.req('PUT', `/api/boards/${board}/star`)).statusCode).toBe(200)
    expect(await starredIds(bob)).toEqual([board])

    // carol (a member) cannot see bob's private board: same 404 as a board that does not exist.
    const hidden = await carol.req('PUT', `/api/boards/${board}/star`)
    const missing = await carol.req('PUT', '/api/boards/b-0000000000/star')
    expect(hidden.statusCode).toBe(404)
    expect(hidden.body).toBe(missing.body)
    expect(await starredIds(carol)).toEqual([])

    const del = await bob.req('DELETE', `/api/boards/${board}/star`)
    expect(StarResponse.parse(del.json())).toEqual({ boardId: board, starred: false })
    expect((await bob.req('DELETE', `/api/boards/${board}/star`)).statusCode).toBe(200)
    expect(await starredIds(bob)).toEqual([])
  })

  it('the M1 board list carries `starred` for the caller only, and still parses as the M1 shape', async () => {
    const { bob, carol, board } = w
    const other = await createBoard(bob, DEV_STUDIO, 'Other')
    await bob.req('PATCH', `/api/boards/${other}`, { visibility: 'workspace_view' })
    await bob.req('PUT', `/api/boards/${board}/star`)
    await carol.req('PUT', `/api/boards/${other}/star`)

    const res = await bob.req('GET', `/api/workspaces/${DEV_STUDIO}/boards`)
    expect(ListBoardsResponse.safeParse(res.json()).success).toBe(true)
    const flags = Object.fromEntries(
      (res.json().boards as { id: string; starred: boolean }[]).map((b) => [b.id, b.starred]),
    )
    expect(flags).toEqual({ [board]: true, [other]: false })
    const carolFlags = (await listed(carol)).map((b) => [b.id, b.starred])
    expect(carolFlags).toEqual([[other, true]])
  })

  it('the starred list shows only boards the caller can still open, most recently starred first', async () => {
    const { bob, carol, board, api } = w
    const second = await createBoard(bob, DEV_STUDIO, 'Second')
    await bob.req('PUT', `/api/boards/${second}/members/${carol.userId}`, { role: 'viewer' })
    await bob.req('PUT', `/api/boards/${board}/members/${carol.userId}`, { role: 'editor' })
    await carol.req('PUT', `/api/boards/${board}/star`)
    api.clock.advance(1000)
    await carol.req('PUT', `/api/boards/${second}/star`)
    expect(await starredIds(carol)).toEqual([second, board])
    const roles = (await listed(carol, `/api/workspaces/${DEV_STUDIO}/boards/starred`)).map((b) => [
      b.id,
      b.role,
      b.starred,
    ])
    expect(roles).toEqual([
      [second, 'viewer', true],
      [board, 'editor', true],
    ])

    // Access removed: the star stays in the table but is never listed again.
    await bob.req('DELETE', `/api/boards/${second}/members/${carol.userId}`)
    expect(await starredIds(carol)).toEqual([board])
    expect((await carol.req('DELETE', `/api/boards/${second}/star`)).statusCode).toBe(404)

    // Archived boards leave the default (active) starred list and appear under ?status=archived.
    await bob.req('POST', `/api/boards/${board}/archive`)
    expect(await starredIds(carol)).toEqual([])
    expect(await starredIds(carol, '?status=archived')).toEqual([board])
    // Trashed boards are only listed to people who could restore them.
    await bob.req('POST', `/api/boards/${board}/trash`)
    expect(await starredIds(carol, '?status=trashed')).toEqual([])
  })

  it('workspace boundaries: foreign or unknown workspaces are 404; signed out is 401; CSRF applies', async () => {
    const { erin, bob, api, board } = w
    expect((await erin.req('GET', `/api/workspaces/${DEV_STUDIO}/boards/starred`)).statusCode).toBe(404)
    expect((await erin.req('PUT', `/api/boards/${board}/star`)).statusCode).toBe(404)
    expect((await api.anon('GET', `/api/workspaces/${DEV_STUDIO}/boards/starred`)).statusCode).toBe(401)
    expect((await api.anon('PUT', `/api/boards/${board}/star`)).statusCode).toBe(401)
    const crossSite = await bob.req('PUT', `/api/boards/${board}/star`, undefined, {
      origin: 'https://evil.example',
    })
    expect(crossSite.statusCode).toBe(403)
    expect(await starredIds(bob)).toEqual([])
    expect(
      (await bob.req('GET', `/api/workspaces/${DEV_STUDIO}/boards/starred?status=deleted`)).statusCode,
    ).toBe(400)
  })
})
