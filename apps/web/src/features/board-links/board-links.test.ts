// Wave N (WS7): the web side of links between boards. The frozen board link rules (moved here from the foundation's
// wave-n-stubs.test.ts), the client against the api's routes (404 of an older api, refusals, the network, the
// 50-target split), the face and "Linked from" stores, the pasted relative path, how a click opens a link, and the
// feature's commands.
import {
  BOARD_CARD_KIND,
  BOARD_CARDS_MAX_IDS,
  type BoardCardsAnswer,
  BoardCardsAnswer as BoardCardsAnswerSchema,
  PALETTE_COMMAND_IDS,
  PENDING_PALETTE_COMMAND_IDS,
} from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { navigate } from '../../lib/routing.ts'
import { CANVAS_FEATURES } from '../canvas-registry.ts'
import { backlinkPath, createBacklinksStore } from './backlinks.ts'
import { backlinks, boardCards, unavailableCards } from './client.ts'
import { createFaceStore, FACE_TTL_MS } from './faces.ts'
import { feature, relativeBoardPath, relativeBoardPathHandler } from './index.tsx'
import {
  BOARD_LINKS_BACKLINKS_COMMAND_ID,
  BOARD_LINKS_INSERT_COMMAND_ID,
  boardCardOf,
  boardLinkOf,
  boardPathOfUrl,
  isBoardCard,
} from './model.ts'
import { boardLinkHandlers, openBoardPath, openWay } from './open.ts'

// the router: a plain click on a link to another board goes through it (here only recorded)
vi.mock('../../lib/routing.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/routing.ts')>()),
  navigate: vi.fn(),
}))

// ---- a fetch stub ---------------------------------------------------------------------------------------------

type Answer = { status: number; body?: unknown } | Error
const g = globalThis as { fetch?: unknown }
let fetchBefore: unknown
let requests: { url: string; init: RequestInit }[] = []
let answer: (url: string) => Answer = () => ({ status: 404, body: { error: { code: 'NOT_FOUND' } } })
beforeEach(() => {
  requests = []
  fetchBefore = g.fetch
  g.fetch = async (url: string, init: RequestInit) => {
    requests.push({ url, init })
    const a = answer(url)
    if (a instanceof Error) throw a
    return new Response(a.body === undefined ? null : JSON.stringify(a.body), {
      status: a.status,
      headers: { 'content-type': 'application/json' },
    })
  }
})
afterEach(() => {
  g.fetch = fetchBefore
})

const B = 'b-board00001'

describe('board link rules (frozen by the foundation)', () => {
  const ORIGIN = 'https://lobby.example'
  it('boardLinkOf reads the relative board path only; isBoardCard needs the kind too', () => {
    expect(boardLinkOf({ link: '/b/b-two0000001' })).toEqual({ boardId: 'b-two0000001', elementId: null })
    expect(boardLinkOf({ link: '/b/b-two0000001?el=frame-1' })).toEqual({
      boardId: 'b-two0000001',
      elementId: 'frame-1',
    })
    expect(boardLinkOf({ link: `${ORIGIN}/b/b-two0000001` })).toBeNull()
    expect(boardLinkOf({ link: null })).toBeNull()
    const card = { link: '/b/b-two0000001', customData: { lobby: { kind: BOARD_CARD_KIND } } }
    expect(isBoardCard(card)).toBe(true)
    expect(isBoardCard({ ...card, link: 'https://example.com' })).toBe(false)
    expect(isBoardCard({ link: '/b/b-two0000001', customData: { lobby: { kind: 'link-card' } } })).toBe(false)
  })

  it('boardPathOfUrl: a same-origin board URL becomes the stored path; anything else is not a board card', () => {
    expect(boardPathOfUrl(`${ORIGIN}/b/b-two0000001`, ORIGIN)).toBe('/b/b-two0000001')
    expect(boardPathOfUrl(`${ORIGIN}/b/b-two0000001?el=frame-1`, ORIGIN)).toBe('/b/b-two0000001?el=frame-1')
    expect(boardPathOfUrl('/b/b-two0000001', ORIGIN)).toBe('/b/b-two0000001')
    for (const bad of [
      'https://evil.example/b/b-two0000001',
      `${ORIGIN}/w/wsp_0123456789`,
      `${ORIGIN}/b/b-two0000001/x`,
      `${ORIGIN}/b/b-two0000001?el=a,b`,
      `${ORIGIN}/b/b-two0000001?el=a&el=b`,
      `${ORIGIN}/b/b-two0000001?view=1,2,3,4`,
      `${ORIGIN}/b/b-two0000001#x`,
      'javascript:alert(1)',
      'not a url at all',
    ])
      expect(boardPathOfUrl(bad, ORIGIN), bad).toBeNull()
  })

  it('boardCardOf: the stored path and the board-cards target of a card, nothing for anything else', () => {
    const card = (link: string) => ({ link, customData: { lobby: { kind: BOARD_CARD_KIND } } })
    expect(boardCardOf(card('/b/b-two0000001'))).toEqual({
      path: '/b/b-two0000001',
      target: 'b-two0000001',
      boardId: 'b-two0000001',
      elementId: null,
    })
    expect(boardCardOf(card('/b/b-two0000001?el=n.1:x'))?.target).toBe('b-two0000001:n.1:x')
    expect(boardCardOf({ link: '/b/b-two0000001' })).toBeNull()
    expect(boardCardOf(card('https://lobby.example/b/b-two0000001'))).toBeNull()
  })
})

describe('the client', () => {
  it('boardCards asks the route (same origin, no cache) and keeps the answered faces', async () => {
    const ok = {
      state: 'ok',
      title: 'Design',
      frameName: null,
      thumbnailPath: `/api/boards/b-two0000001/thumbnail`,
    }
    answer = () => ({
      status: 200,
      body: { cards: { 'b-two0000001': ok, 'b-three00001': { state: 'unavailable' } } },
    })
    const got = await boardCards(B, ['b-two0000001', 'b-three00001', 'not a target'])
    // a target that is no card target is never sent, and stays unavailable
    expect(got).toEqual({
      cards: {
        'b-two0000001': ok,
        'b-three00001': { state: 'unavailable' },
        'not a target': { state: 'unavailable' },
      },
    })
    expect(BoardCardsAnswerSchema.parse(await boardCards(B, ['b-two0000001'])).cards).toEqual({
      'b-two0000001': ok,
    })
    expect(requests).toHaveLength(2)
    expect(requests[0]?.url).toBe(`/api/boards/${B}/board-cards?ids=b-two0000001,b-three00001`)
    expect(requests[0]?.init).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store' })
  })

  it(`splits more than ${BOARD_CARDS_MAX_IDS} targets, and never sends one twice`, async () => {
    answer = () => ({ status: 200, body: { cards: {} } })
    const targets = Array.from(
      { length: BOARD_CARDS_MAX_IDS + 7 },
      (_, i) => `b-many${String(i).padStart(6, '0')}`,
    )
    const got = await boardCards(B, [...targets, targets[0] as string])
    expect(requests).toHaveLength(2)
    expect(Object.keys(got.cards)).toHaveLength(targets.length)
    for (const f of Object.values(got.cards)) expect(f).toEqual({ state: 'unavailable' })
  })

  it('an older api (404), a refusal, a bad body or the network: every face unavailable, backlinks null; never throws', async () => {
    for (const a of [
      { status: 404, body: { error: { code: 'NOT_FOUND' } } },
      { status: 403, body: { error: { code: 'GUEST_ACCOUNT_REQUIRED' } } },
      { status: 429, body: {} },
      { status: 200, body: { cards: { x: 1 }, backlinks: 'no' } },
      new TypeError('Failed to fetch'),
    ] as Answer[]) {
      answer = () => a
      expect(await boardCards(B, ['b-two0000001'])).toEqual(unavailableCards(['b-two0000001']))
      expect(await backlinks(B)).toBeNull()
    }
  })

  it('backlinks parses the answer', async () => {
    const list = [{ boardId: 'b-two0000001', title: 'Roadmap', elementId: 'card-1' }]
    answer = () => ({ status: 200, body: { backlinks: list } })
    expect(await backlinks(B)).toEqual({ backlinks: list })
    expect(requests[0]?.url).toBe(`/api/boards/${B}/backlinks`)
  })
})

describe('the face store', () => {
  it('batches the faces cards want, keeps them for the TTL, asks again after it', async () => {
    let t = 0
    const asked: string[][] = []
    const timers: (() => void)[] = []
    const store = createFaceStore(B, {
      now: () => t,
      schedule: (fn) => timers.push(fn),
      fetchFaces: async (_b, targets): Promise<BoardCardsAnswer> => {
        asked.push([...targets])
        return { cards: Object.fromEntries(targets.map((x) => [x, { state: 'unavailable' as const }])) }
      },
    })
    store.want(['a01'])
    store.want(['a02', 'a01'])
    expect(store.face('a01')).toBeNull()
    expect(timers).toHaveLength(1)
    timers.shift()?.()
    await new Promise((r) => setTimeout(r, 0))
    expect(asked).toEqual([['a01', 'a02']])
    expect(store.face('a01')).toEqual({ state: 'unavailable' })
    // fresh: nothing asked
    store.want(['a01'])
    expect(timers).toHaveLength(0)
    // stale: asked again (the old face stays shown meanwhile)
    t += FACE_TTL_MS + 1
    store.want(['a01'])
    expect(store.face('a01')).toEqual({ state: 'unavailable' })
    timers.shift()?.()
    await new Promise((r) => setTimeout(r, 0))
    expect(asked).toEqual([['a01', 'a02'], ['a01']])
  })
})

describe('the "Linked from" store', () => {
  it('asks once per TTL (or when forced); a null answer keeps the section hidden', async () => {
    let t = 0
    let n = 0
    let next: { backlinks: { boardId: string; title: string; elementId: string }[] } | null = null
    const store = createBacklinksStore(B, {
      now: () => t,
      fetch: async () => {
        n++
        return next
      },
    })
    expect(await store.refresh()).toBeNull()
    expect(store.state.get().list).toBeNull()
    next = { backlinks: [{ boardId: 'b-two0000001', title: 'Roadmap', elementId: 'card-1' }] }
    expect(await store.refresh()).toBeNull() // within the TTL: not asked again
    expect(n).toBe(1)
    expect(await store.refresh({ force: true })).toHaveLength(1)
    t += 10 * 60_000
    await store.refresh()
    expect(n).toBe(3)
    expect(backlinkPath({ boardId: 'b-two0000001', elementId: 'card-1' })).toBe('/b/b-two0000001?el=card-1')
  })
})

describe('pasting a relative board path, and opening a link', () => {
  it('only exactly a board path is taken (a URL goes to the link cards)', () => {
    expect(relativeBoardPath(' /b/b-two0000001 ')).toBe('/b/b-two0000001')
    expect(relativeBoardPath('/b/b-two0000001?el=frame-1')).toBe('/b/b-two0000001?el=frame-1')
    for (const t of [
      'b/b-two0000001',
      '/b/b-two0000001 and more',
      '/b/b-two0000001?el=a,b',
      'https://x/b/b-two0000001',
    ])
      expect(relativeBoardPath(t), t).toBeNull()
    expect(relativeBoardPathHandler.kinds).toEqual(['text'])
    // before the bulk paste (50)
    expect(relativeBoardPathHandler.priority).toBeGreaterThan(50)
  })

  it('a plain click opens here; Ctrl, Cmd, Shift and a middle click open a new tab; others nothing', () => {
    const e = (
      o: Partial<{ button: number; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }>,
    ) => ({
      button: 0,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      ...o,
    })
    expect(openWay(e({}))).toBe('here')
    expect(openWay(e({ ctrlKey: true }))).toBe('tab')
    expect(openWay(e({ metaKey: true }))).toBe('tab')
    expect(openWay(e({ shiftKey: true }))).toBe('tab')
    expect(openWay(e({ button: 1 }))).toBe('tab')
    expect(openWay(e({ button: 2 }))).toBeNull()
    expect(openWay(e({ altKey: true }))).toBeNull()
  })

  it('a link to the board this page shows is applied in place; one to another board goes through the router', () => {
    const shown: (string | null)[] = []
    const from = { boardId: 'b-here000001', show: (el: string | null) => shown.push(el) }
    vi.mocked(navigate).mockClear()
    openBoardPath('/b/b-here000001?el=frame-1', 'here', from)
    openBoardPath('/b/b-here000001', 'here', from)
    expect(shown).toEqual(['frame-1', null])
    expect(navigate).not.toHaveBeenCalled()
    openBoardPath('/b/b-there00001?el=frame-1', 'here', from)
    openBoardPath('/b/b-here000001?el=frame-1', 'here')
    expect(vi.mocked(navigate).mock.calls).toEqual([
      ['/b/b-there00001?el=frame-1'],
      ['/b/b-here000001?el=frame-1'],
    ])
    expect(shown).toHaveLength(2)
    // never anything but a Lobby-relative board path
    openBoardPath('//evil.example/b/b-here000001', 'here', from)
    openBoardPath('/w/wsp_0123456789', 'here', from)
    expect(navigate).toHaveBeenCalledTimes(2)
    expect(shown).toHaveLength(2)
  })

  it('the link handlers: a plain click opens (in place for this board); an Alt click only stops the download', () => {
    const shown: (string | null)[] = []
    const from = { boardId: 'b-here000001', show: (el: string | null) => shown.push(el) }
    const click = (o: Partial<{ button: number; altKey: boolean }>) => {
      const ev = {
        button: 0,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        altKey: false,
        ...o,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      }
      boardLinkHandlers('/b/b-here000001?el=frame-1', { from }).onClick(ev)
      return ev
    }
    vi.mocked(navigate).mockClear()
    const plain = click({})
    expect(plain.preventDefault).toHaveBeenCalled()
    expect(shown).toEqual(['frame-1'])
    const alt = click({ altKey: true })
    expect(alt.preventDefault).toHaveBeenCalled()
    expect(alt.stopPropagation).not.toHaveBeenCalled()
    // a right click keeps the browser's own menu
    const right = click({ button: 2 })
    expect(right.preventDefault).not.toHaveBeenCalled()
    expect(shown).toEqual(['frame-1'])
    expect(navigate).not.toHaveBeenCalled()
  })
})

describe('the feature', () => {
  it('is on the board page with its two palette commands, no longer pending', () => {
    expect(CANVAS_FEATURES.map((f) => f.id)).toContain('board-links')
    const ids = (feature.commands ?? []).map((c) => c.id)
    expect(ids).toEqual([BOARD_LINKS_INSERT_COMMAND_ID, BOARD_LINKS_BACKLINKS_COMMAND_ID])
    for (const id of ids) {
      expect(PALETTE_COMMAND_IDS as readonly string[]).toContain(id)
      expect(PENDING_PALETTE_COMMAND_IDS as readonly string[]).not.toContain(id)
    }
    // "Linked from" is for every role that can view; inserting needs an editor
    const backlinksCmd = feature.commands?.find((c) => c.id === BOARD_LINKS_BACKLINKS_COMMAND_ID)
    expect(backlinksCmd?.readOnlyAllowed).toBe(true)
    const insert = feature.commands?.find((c) => c.id === BOARD_LINKS_INSERT_COMMAND_ID)
    expect(insert?.readOnlyAllowed).toBeFalsy()
    expect(feature.contentHandlers).toEqual([relativeBoardPathHandler])
  })
})
