// Wave N (WS7, N7-3): GET /internal/boards/:bid/text?links=1 on the Excalidraw engine, against the REAL sync
// server process (room-internal/text.ts): the board links of the live elements (board cards and any other element
// whose `link` is a Lobby-relative /b/ path), in id order, at most BOARD_TEXT_LINKS_MAX; external links and
// tombstones never count; and without the parameter the answer is byte for byte the wave M one (recorded below from
// the build before this change, 5a8b8bd4), so an older api reads exactly what it read before.

import { BOARD_TEXT_LINKS_MAX, BoardTextLinks } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import { extractElementLinks } from '../../src/room-internal/text.ts'
import { label, rect, text, withLabel } from '../element-room/support/elements.ts'
import { newBoardId, useElementHarness } from '../element-room/support/stack.ts'
import { callInternal } from '../harness/tickets.ts'
import { call, sampleBoard, seed } from './support.ts'

const h = useElementHarness()

type LinksAnswer = {
  boardId: string
  clock: number
  unchanged: boolean
  entries?: unknown[]
  links?: { el: string; to: string; toEl?: string }[]
}

/** A board card as the web places it: a rounded rectangle of kind board-card with its "Board link" label. */
function boardCard(id: string, link: string, x: number) {
  const l = label(`${id}.t`, id, { text: 'Board link', originalText: 'Board link', x: x + 5, y: 5 })
  return [
    withLabel(
      rect(id, { x, link, roundness: { type: 3, value: 10 }, customData: { lobby: { kind: 'board-card' } } }),
      l,
    ),
    l,
  ]
}

/** The fixed board whose wave M answer is recorded below. */
const RECORDED_BOARD = 'b-links-bytes1'
const recordedElements = () => [
  ...sampleBoard(),
  rect('L1', { x: 3000, link: '/b/b-target0001' }),
  rect('L2', { x: 3200, link: 'https://example.com/b/b-target0001' }),
]
/** What the wave M build (5a8b8bd4, before N7-3) answered for RECORDED_BOARD, byte for byte. */
const RECORDED_WAVE_M =
  '{"boardId":"b-links-bytes1","clock":1,"unchanged":false,"entries":[{"id":"shape:F","type":"frame","pageId":"page:page","text":"Ideas"},{"id":"shape:N1","type":"note","pageId":"page:page","text":"first idea"},{"id":"shape:N2","type":"note","pageId":"page:page","text":"second idea"},{"id":"shape:R","type":"geo","pageId":"page:page","text":"box"},{"id":"shape:T","type":"text","pageId":"page:page","text":"free words"}],"truncated":false,"bytes":39}'
const RECORDED_UNCHANGED = '{"boardId":"b-links-bytes1","clock":1,"unchanged":true}'

describe('the text route with ?links=1 (N7-3)', () => {
  it('lists board cards and plain elements with /b/ links, in id order; external links never count', async () => {
    const st = await h.stack()
    const b = newBoardId()
    const els = [
      ...sampleBoard(),
      ...boardCard('C1', '/b/b-target0001', 2000),
      ...boardCard('C2', '/b/b-target0002?el=frame-9', 2400),
      // a plain element (no kind) holding a board link counts too; a free text with one as well
      rect('P1', { x: 2800, link: '/b/b-target0003' }),
      text('P2', { x: 3200, text: 'see', originalText: 'see', link: '/b/b-target0001?el=n.1:x' }),
      // never a board link: external URLs (even to a /b/ path), Lobby paths that are not exactly a board path
      rect('X1', { x: 3600, link: 'https://example.com/b/b-target0001' }),
      rect('X2', { x: 4000, link: '/w/wsp_0123456789' }),
      rect('X3', { x: 4400, link: '/b/b-target0001?el=a,b' }),
      rect('X4', { x: 4800, link: '/b/B-Upper0001' }),
      rect('X5', { x: 5200, link: '/b/b-target0001#frame' }),
    ]
    expect((await seed(st, b, els)).status).toBe(201)
    const res = await call<LinksAnswer>(st, 'GET', `/internal/boards/${b}/text?links=1`)
    expect(res.status).toBe(200)
    expect(res.body.links).toEqual([
      { el: 'C1', to: 'b-target0001' },
      { el: 'C2', to: 'b-target0002', toEl: 'frame-9' },
      { el: 'P1', to: 'b-target0003' },
      { el: 'P2', to: 'b-target0001', toEl: 'n.1:x' },
    ])
    // the answer parses with the contract, and the text part is the same as without the parameter
    expect(BoardTextLinks.safeParse(res.body.links).success).toBe(true)
    const plain = await call<LinksAnswer>(st, 'GET', `/internal/boards/${b}/text`)
    const { links: _, ...withoutLinks } = res.body
    expect(withoutLinks).toEqual(plain.body)
    expect(Object.keys(res.body).at(-1)).toBe('links')
  })

  it('leaves tombstones out: a deleted card is no link any more', async () => {
    const st = await h.stack()
    const b = newBoardId()
    await seed(st, b, [...boardCard('C1', '/b/b-target0001', 0), ...boardCard('C2', '/b/b-target0002', 400)])
    const c = await st.client({ boardId: b, user: 'editor' })
    const v = c.confirmed.get('C1')?.version ?? 1
    await c.push([{ k: 'p', id: 'C1', pv: v, g: { life: { isDeleted: true } } }])
    const res = await call<LinksAnswer>(st, 'GET', `/internal/boards/${b}/text?links=1`)
    expect(res.body.links).toEqual([{ el: 'C2', to: 'b-target0002' }])
  })

  it(`stops at ${BOARD_TEXT_LINKS_MAX} links per board (the first ones in id order)`, async () => {
    const st = await h.stack()
    const b = newBoardId()
    const n = BOARD_TEXT_LINKS_MAX + 15
    const els = Array.from({ length: n }, (_, i) =>
      rect(`L${String(i).padStart(4, '0')}`, {
        x: i * 120,
        link: `/b/b-target${String(i).padStart(4, '0')}`,
      }),
    )
    expect((await seed(st, b, els)).status).toBe(201)
    const res = await call<LinksAnswer>(st, 'GET', `/internal/boards/${b}/text?links=1`)
    expect(res.body.links).toHaveLength(BOARD_TEXT_LINKS_MAX)
    expect(res.body.links?.[0]).toEqual({ el: 'L0000', to: 'b-target0000' })
    expect(res.body.links?.at(-1)?.el).toBe(`L${String(BOARD_TEXT_LINKS_MAX - 1).padStart(4, '0')}`)
  })

  it('an unchanged answer carries no links; an unknown board answers no links; a bad value is refused', async () => {
    const st = await h.stack()
    const b = newBoardId()
    await seed(st, b, boardCard('C1', '/b/b-target0001', 0))
    const first = await call<LinksAnswer>(st, 'GET', `/internal/boards/${b}/text?links=1`)
    const same = await call<LinksAnswer>(
      st,
      'GET',
      `/internal/boards/${b}/text?links=1&since=${first.body.clock}`,
    )
    expect(same.body).toEqual({ boardId: b, clock: first.body.clock, unchanged: true })
    const none = await call<LinksAnswer>(st, 'GET', `/internal/boards/${newBoardId()}/text?links=1`)
    expect(none.body).toMatchObject({ clock: 0, unchanged: false, entries: [], links: [] })
    for (const bad of ['0', 'yes', ''])
      expect((await call(st, 'GET', `/internal/boards/${b}/text?links=${bad}`)).status, bad).toBe(400)
  })

  it('without ?links=1 the answer is the wave M one, byte for byte (an older api reads what it read before)', async () => {
    const st = await h.stack()
    expect((await seed(st, RECORDED_BOARD, recordedElements())).status).toBe(201)
    const res = await callInternal(st.server.url, 'GET', `/internal/boards/${RECORDED_BOARD}/text`, {})
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(RECORDED_WAVE_M)
    const same = await callInternal(
      st.server.url,
      'GET',
      `/internal/boards/${RECORDED_BOARD}/text?since=1`,
      {},
    )
    expect(await same.text()).toBe(RECORDED_UNCHANGED)
    // the same board with ?links=1: the recorded answer with `links` added at the end, nothing else
    const linked = await callInternal(
      st.server.url,
      'GET',
      `/internal/boards/${RECORDED_BOARD}/text?links=1`,
      {},
    )
    expect(await linked.text()).toBe(
      `${RECORDED_WAVE_M.slice(0, -1)},"links":[{"el":"L1","to":"b-target0001"}]}`,
    )
  })
})

describe('extractElementLinks (pure)', () => {
  it('reads exactly the relative board paths of live elements with valid ids, up to the cap', () => {
    const els = [
      { id: 'a', link: '/b/b-board0001' },
      { id: 'b', link: '/b/b-board0001?el=x' },
      { id: 'c', link: '/b/b-board0001', isDeleted: true },
      { id: 'bad id', link: '/b/b-board0001' },
      { id: 'd', link: 'https://lobby.example/b/b-board0001' },
      { id: 'e', link: null },
      { id: 'f', link: 42 },
      { id: 'g', link: '/b/b-board0001?view=1,2,3,4' },
      { link: '/b/b-board0001' },
    ]
    expect(extractElementLinks(els)).toEqual([
      { el: 'a', to: 'b-board0001' },
      { el: 'b', to: 'b-board0001', toEl: 'x' },
    ])
    expect(extractElementLinks(els, 1)).toEqual([{ el: 'a', to: 'b-board0001' }])
    expect(extractElementLinks(els, 0)).toEqual([])
  })
})
