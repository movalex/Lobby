// The wave N foundation's web stubs: each answers its safe default without a request (nothing changes on the board
// page until its owner lands it), and each frozen id is a contract id. OWNERS: WS4 (visits), WS5 (capture), WS7 (board
// links); each owner moves its part of this file into its own tests when it implements the client.
import {
  BOARD_CARD_KIND,
  BoardCardsAnswer,
  PALETTE_COMMAND_IDS,
  PENDING_PALETTE_COMMAND_IDS,
} from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AI_CAPTURE_COMMAND_ID,
  CaptureUnavailableError,
  captureAvailable,
  captureBoardImage,
  capturePhoto,
  captureTranscript,
} from './ai/capture/client.ts'
import { backlinks, boardCards } from './board-links/client.ts'
import { feature as boardLinksFeature } from './board-links/index.tsx'
import {
  BOARD_LINKS_BACKLINKS_COMMAND_ID,
  BOARD_LINKS_INSERT_COMMAND_ID,
  boardLinkOf,
  boardPathOfUrl,
  isBoardCard,
} from './board-links/model.ts'
import { CANVAS_FEATURES } from './canvas-registry.ts'
import { fetchVisit, sendSeen } from './visits/client.ts'
import { feature as visitsFeature } from './visits/index.tsx'

let calls = 0
const g = globalThis as { fetch?: unknown; navigator?: unknown }
let fetchBefore: unknown
beforeEach(() => {
  calls = 0
  fetchBefore = g.fetch
  g.fetch = () => {
    calls++
    return Promise.reject(new Error('no request expected'))
  }
})
afterEach(() => {
  g.fetch = fetchBefore
})

describe('the wave N features are registered and contribute nothing yet', () => {
  it('visits and board-links are on the board page, empty', () => {
    const ids = CANVAS_FEATURES.map((f) => f.id)
    expect(ids).toContain('visits')
    expect(ids).toContain('board-links')
    for (const f of [visitsFeature, boardLinksFeature]) expect(Object.keys(f)).toEqual(['id'])
  })

  it('their palette commands are contract ids, pending until registered', () => {
    for (const id of [
      AI_CAPTURE_COMMAND_ID,
      BOARD_LINKS_INSERT_COMMAND_ID,
      BOARD_LINKS_BACKLINKS_COMMAND_ID,
    ]) {
      expect(PALETTE_COMMAND_IDS as readonly string[]).toContain(id)
      expect(PENDING_PALETTE_COMMAND_IDS as readonly string[]).toContain(id)
    }
  })
})

describe('the stubs answer their safe default without a request', () => {
  it('visits: no visit to show, no beacon', async () => {
    expect(await fetchVisit('b-board00001')).toBeNull()
    expect(sendSeen('b-board00001')).toBe(false)
    expect(calls).toBe(0)
  })

  it('board links: every face unavailable, no backlinks', async () => {
    const answer = await boardCards('b-board00001', ['b-two0000001', 'b-three00001:frame-1'])
    expect(BoardCardsAnswer.parse(answer)).toEqual({
      cards: { 'b-two0000001': { state: 'unavailable' }, 'b-three00001:frame-1': { state: 'unavailable' } },
    })
    expect(await backlinks('b-board00001')).toBeNull()
    expect(calls).toBe(0)
  })

  it('capture: never available; every call rejects unavailable', async () => {
    expect(captureAvailable()).toBe(false)
    await expect(capturePhoto('b-board00001', new Blob([]), 'auto')).rejects.toBeInstanceOf(
      CaptureUnavailableError,
    )
    await expect(captureBoardImage('b-board00001', 'img-1', 'notes')).rejects.toMatchObject({
      code: 'unavailable',
    })
    await expect(captureTranscript('b-board00001', 'We decided.')).rejects.toMatchObject({
      code: 'unavailable',
    })
    expect(calls).toBe(0)
  })
})

describe('board link rules (frozen for WS7)', () => {
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
})
