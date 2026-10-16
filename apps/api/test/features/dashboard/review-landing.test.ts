// Wave S (WS4): a review link can open straight into the board's review page (0037 invitations.landing). The
// creation, the pending list, accepting and the name-only join all say where the link lands; a link made without
// the choice (or by an older web) carries no `landing` at all, exactly as before wave S.
import {
  GuestJoined,
  ListInvitationsResponse,
  ReviewLinkCreated,
  reviewLandingPath,
} from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { joinAsGuest, setupWorld, tokenOf, type World } from '../guests/support.ts'

let w: World
beforeEach(async () => {
  w = await setupWorld()
})
afterEach(() => w.api.close())

const create = async (body: Record<string, unknown>) => {
  const res = await w.bob.req('POST', `/api/boards/${w.board}/review-links`, { allowGuests: true, ...body })
  expect(res.statusCode, res.body).toBe(201)
  return { raw: res.json() as Record<string, unknown>, link: ReviewLinkCreated.parse(res.json()) }
}

const listed = async () =>
  ListInvitationsResponse.parse((await w.bob.req('GET', `/api/boards/${w.board}/invitations`)).json())
    .invitations

describe('a review link that lands on the review page', () => {
  it('is created with landing "review", listed with it, and the stored value is the choice', async () => {
    const { link } = await create({ role: 'commenter', landing: 'review' })
    expect(link.landing).toBe('review')
    expect(reviewLandingPath(w.board, link.landing)).toBe(`/b/${w.board}?view=review`)
    expect((await listed()).find((i) => i.id === link.id)).toMatchObject({ kind: 'review', landing: 'review' })
    const row = await w.api.db.one<{ landing: string }>('SELECT landing FROM invitations WHERE id = $1', [
      link.id,
    ])
    expect(row.landing).toBe('review')
  })

  it('a link made without the choice stores the board and says nothing (an older answer exactly)', async () => {
    const { raw, link } = await create({ role: 'commenter' })
    expect('landing' in raw).toBe(false)
    expect(link.landing).toBeUndefined()
    expect((await listed()).find((i) => i.id === link.id)?.landing).toBeUndefined()
    const row = await w.api.db.one<{ landing: string }>('SELECT landing FROM invitations WHERE id = $1', [
      link.id,
    ])
    expect(row.landing).toBe('board')
    // an explicit "board" is the same thing
    const { raw: explicit } = await create({ role: 'viewer', landing: 'board' })
    expect('landing' in explicit).toBe(false)
  })

  it('refuses a landing that is neither (400), and a review landing is allowed for every link role', async () => {
    const bad = await w.bob.req('POST', `/api/boards/${w.board}/review-links`, { landing: 'elsewhere' })
    expect(bad.statusCode).toBe(400)
    for (const role of ['viewer', 'commenter'] as const) {
      const { link } = await create({ role, landing: 'review' })
      expect(link.landing).toBe('review')
    }
  })

  it('accepting it as an account answers with the landing; a plain link does not', async () => {
    const { link } = await create({ role: 'commenter', landing: 'review' })
    const plain = (await create({ role: 'commenter' })).link
    const res = await w.carol.req('POST', `/api/invitations/${tokenOf(link.url)}/accept`)
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json()).toEqual({
      workspaceId: expect.any(String),
      boardId: w.board,
      landing: 'review',
    })
    // accepting again (a no-op for the same account) still says where it lands
    const again = await w.carol.req('POST', `/api/invitations/${tokenOf(link.url)}/accept`)
    expect(again.json()).toMatchObject({ boardId: w.board, landing: 'review' })
    const other = await w.erin.req('POST', `/api/invitations/${tokenOf(plain.url)}/accept`)
    expect(other.statusCode, other.body).toBe(200)
    expect('landing' in (other.json() as object)).toBe(false)
  })

  it('a name-only guest joining it is told, with the same session; a plain link says nothing', async () => {
    const { link } = await create({ role: 'commenter', landing: 'review' })
    const sam = await joinAsGuest(w.api, link.url, 'Sam')
    expect(GuestJoined.parse(sam.joined).landing).toBe('review')
    expect(sam.joined.boardId).toBe(w.board)

    const plain = (await create({ role: 'commenter' })).link
    const ana = await joinAsGuest(w.api, plain.url, 'Ana')
    expect('landing' in ana.joined).toBe(false)
  })
})
