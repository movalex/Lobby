// Wave N (WS7, N7-2): GET /api/boards/:bid/board-cards: card faces without leaks. A face shows a target's title,
// frame name and thumbnail route only to a caller who can view the target now; a missing, a forbidden and a trashed
// target answer the one `unavailable` face, byte for byte; a name-only guest gets only `unavailable` faces; nothing
// about a target is read before its access check passed.

import { BOARD_CARDS_MAX_IDS } from '@draftroom/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { BOARD_LINKS_LIMITS } from '../../../src/features/board-links/index.ts'
import { GUEST_REFUSED_ROUTES } from '../../../src/features/guests/guard.ts'
import { createBoard, DEV_STUDIO } from '../../helpers.ts'
import { cards, cardsRaw, type LinksWorld, linksWorld, MISSING, spyQueries } from './support.ts'

let w: LinksWorld
beforeAll(async () => {
  w = await linksWorld()
  // D's frame is in the search index (its name is what a ?el= card face shows)
  w.sync.setText(w.b.D, [
    { id: 'shape:frame-1', type: 'frame', text: 'Q3 goals' },
    { id: 'shape:note-1', type: 'note', text: 'not a frame' },
  ])
  expect(await w.indexer.refreshCanvas(w.b.D)).toBe('indexed')
})
afterAll(() => w.close())

describe('board-cards: faces for a viewer of the board', () => {
  it('a viewable target: its title, the frame name for ?el= of a frame, and the same-origin thumbnail route', async () => {
    const { b } = w
    const got = await cards(w.carol, b.A, [b.D, `${b.D}:frame-1`, `${b.D}:note-1`, `${b.D}:gone-1`])
    const ok = { state: 'ok', title: 'Design D', thumbnailPath: `/api/boards/${b.D}/thumbnail` }
    expect(got.cards).toEqual({
      [b.D]: { ...ok, frameName: null },
      [`${b.D}:frame-1`]: { ...ok, frameName: 'Q3 goals' },
      // an element that is not a frame, or one the index does not hold: no frame name, the board's face
      [`${b.D}:note-1`]: { ...ok, frameName: null },
      [`${b.D}:gone-1`]: { ...ok, frameName: null },
    })
  })

  it('missing, forbidden and trashed targets give identical unavailable bodies (404 semantics)', async () => {
    const { b } = w
    const ids = [MISSING, b.B, b.C, `${b.B}:frame-1`, `${MISSING}:frame-1`]
    const got = await cards(w.carol, b.A, ids)
    for (const id of ids) expect(got.cards[id], id).toEqual({ state: 'unavailable' })
    // byte for byte: each one alone answers the same bytes as any other alone
    const bodies = new Set<string>()
    for (const id of [MISSING, b.B, b.C]) {
      const res = await cardsRaw(w.carol, b.A, [id])
      expect(res.statusCode).toBe(200)
      bodies.add(res.body.replace(id, '<id>'))
    }
    expect([...bodies]).toEqual(['{"cards":{"<id>":{"state":"unavailable"}}}'])
    // a trashed board is unavailable even to its owner (nobody can open it)
    expect((await cards(w.bob, b.A, [b.C])).cards[b.C]).toEqual({ state: 'unavailable' })
    // and bob, who can view B, sees its face where carol could not
    expect((await cards(w.bob, b.A, [b.B])).cards[b.B]).toMatchObject({ state: 'ok', title: 'Secret B' })
  })

  it('nothing about a target the caller cannot view is read before (or after) its access check', async () => {
    const { b } = w
    const spy = spyQueries(w)
    try {
      await cards(w.carol, b.A, [`${b.B}:frame-1`, `${b.D}:frame-1`])
    } finally {
      spy.stop()
    }
    // B (forbidden) is named by exactly one query: the access check of every target at once
    const aboutB = spy.naming(b.B)
    expect(aboutB).toHaveLength(1)
    expect(aboutB[0]?.sql).toContain('AS p(board_id, user_id)')
    // D (viewable) passed it, and only then was its frame name read
    const aboutD = spy.naming(b.D)
    expect(aboutD.map((q) => (q.sql.includes('board_search_entries') ? 'frames' : 'access'))).toEqual([
      'access',
      'frames',
    ])
    const accessAt = spy.seen.indexOf(aboutB[0] as (typeof spy.seen)[number])
    const framesAt = spy.seen.findIndex((q) => q.sql.includes('board_search_entries'))
    expect(framesAt).toBeGreaterThan(accessAt)
  })

  it(`at most ${BOARD_CARDS_MAX_IDS} targets (the ${BOARD_CARDS_MAX_IDS + 1}st is a 400); malformed ids are a 400`, async () => {
    const { b } = w
    const ids = Array.from(
      { length: BOARD_CARDS_MAX_IDS + 1 },
      (_, i) => `b-many${String(i).padStart(6, '0')}`,
    )
    expect((await cardsRaw(w.carol, b.A, ids.slice(0, BOARD_CARDS_MAX_IDS))).statusCode).toBe(200)
    const over = await cardsRaw(w.carol, b.A, ids)
    expect(over.statusCode, over.body).toBe(400)
    // the same id twice counts once
    expect(
      (await cardsRaw(w.carol, b.A, [...ids.slice(0, BOARD_CARDS_MAX_IDS), ids[0] as string])).statusCode,
    ).toBe(200)
    for (const bad of [['Not A Board'], ['b-ok0000001:has space'], ['']])
      expect((await cardsRaw(w.carol, b.A, bad)).statusCode, bad.join()).toBe(400)
    expect((await w.carol.req('GET', `/api/boards/${b.A}/board-cards`)).statusCode).toBe(400)
    expect((await w.carol.req('GET', `/api/boards/${b.A}/board-cards?ids=${b.D}&x=1`)).statusCode).toBe(400)
  })

  it('the caller must view the board the cards are on (404 otherwise, before any target is looked at)', async () => {
    const { b } = w
    const spy = spyQueries(w)
    let res: Awaited<ReturnType<typeof cardsRaw>>
    try {
      res = await cardsRaw(w.carol, b.B, [b.D])
    } finally {
      spy.stop()
    }
    expect(res.statusCode).toBe(404)
    expect(spy.naming(b.D)).toEqual([])
    expect((await cardsRaw(w.erin, b.A, [b.D])).statusCode).toBe(404)
    expect((await w.api.anon('GET', `/api/boards/${b.A}/board-cards?ids=${b.D}`)).statusCode).toBe(401)
  })
})

describe('board-cards: name-only guests', () => {
  it('get only unavailable faces, even of a board they can open, and no target is looked up for them', async () => {
    const { b } = w
    // there is no guest refusal row for this route: the guest gets an answer, with nothing in it
    expect(GUEST_REFUSED_ROUTES['GET /api/boards/:bid/board-cards']).toBeUndefined()
    const spy = spyQueries(w)
    let got: Awaited<ReturnType<typeof cards>>
    try {
      got = await cards(w.sam, b.A, [b.A, b.D, `${b.D}:frame-1`, b.B, MISSING])
    } finally {
      spy.stop()
    }
    for (const face of Object.values(got.cards)) expect(face).toEqual({ state: 'unavailable' })
    expect(Object.keys(got.cards)).toHaveLength(5)
    for (const id of [b.D, b.B, MISSING]) expect(spy.naming(id), id).toEqual([])
    // a board the guest has no link to: 404, like anyone
    expect((await cardsRaw(w.sam, b.D, [b.A])).statusCode).toBe(404)
  })
})

describe('board-cards: the rate limit', () => {
  it(`answers 429 after ${BOARD_LINKS_LIMITS.cardsPerUserPerMinute} calls a minute per person`, async () => {
    const dave = await w.api.login('dave')
    const own = await createBoard(w.alice, DEV_STUDIO, 'Dave limit')
    const res = await w.alice.req('PUT', `/api/boards/${own}/members/${dave.userId}`, { role: 'viewer' })
    expect(res.statusCode).toBe(200)
    for (let i = 0; i < BOARD_LINKS_LIMITS.cardsPerUserPerMinute; i++)
      expect((await cardsRaw(dave, own, [own])).statusCode).toBe(200)
    expect((await cardsRaw(dave, own, [own])).statusCode).toBe(429)
    // another person is not affected
    expect((await cardsRaw(w.alice, own, [own])).statusCode).toBe(200)
    w.api.clock.advance(61_000)
    expect((await cardsRaw(dave, own, [own])).statusCode).toBe(200)
  })
})
