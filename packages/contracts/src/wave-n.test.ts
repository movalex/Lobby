// The wave N foundation's contracts (OWNER: WS4 after the foundation): visits, board links, Capture the room, the
// strip-keys and text-links internal shapes, reaction codes and the new usage events.
import { describe, expect, it } from 'vitest'
import {
  AI_LEDGER_ACTION_PATTERN,
  BACKLINKS_MAX,
  BacklinksAnswer,
  BOARD_CARD_KIND,
  BOARD_CARDS_MAX_IDS,
  BOARD_TEXT_LINKS_MAX,
  BoardCardFace,
  BoardCardsAnswer,
  BoardCardsQuery,
  BoardTextLinks,
  boardCardsPath,
  boardCardTarget,
  boardLinkPath,
  CAPTURE_LEDGER_ACTIONS,
  CAPTURE_PHOTO_MAX_BYTES,
  CAPTURE_TRANSCRIPT_MAX_CHARS,
  CaptureBoardImageRequest,
  CapturePhotoQuery,
  CaptureResponse,
  CaptureResult,
  CaptureTranscriptRequest,
  capturePhotoPath,
  isUsageEvent,
  PALETTE_COMMAND_IDS,
  PENDING_PALETTE_COMMAND_IDS,
  parseBoardLinkPath,
  REACTION_CODES,
  STRIP_KEYS_ROUTE,
  StripKeysAnswer,
  StripKeysRequest,
  USAGE_EVENT_PATTERN,
  USAGE_EVENTS,
  VISIT_ROUTE,
  VISIT_SEEN_ROUTE,
  VisitAnswer,
  visitPath,
  visitSeenPath,
} from './index.ts'

const RUN = 'air_0123456789ABCDEFGHIJ'

describe('visits (WS4)', () => {
  it('routes and the answer: the caller’s own previous time (null on a first visit) and the time stored', () => {
    expect(VISIT_ROUTE).toBe('/api/boards/:bid/visit')
    expect(VISIT_SEEN_ROUTE).toBe('/api/boards/:bid/visit/seen')
    expect(visitPath('b-one')).toBe('/api/boards/b-one/visit')
    expect(visitSeenPath('b-one')).toBe('/api/boards/b-one/visit/seen')
    expect(VisitAnswer.safeParse({ previousSeenAt: null, seenAt: 1_790_000_000_000 }).success).toBe(true)
    expect(VisitAnswer.safeParse({ previousSeenAt: 1, seenAt: 2 }).success).toBe(true)
    // strict: no other field (never anyone else's time)
    expect(VisitAnswer.safeParse({ previousSeenAt: 1, seenAt: 2, userId: 'usr_x' }).success).toBe(false)
    expect(VisitAnswer.safeParse({ previousSeenAt: -1, seenAt: 2 }).success).toBe(false)
  })
})

describe('board links (WS7)', () => {
  it('a stored board path is relative and names one board and at most one element', () => {
    expect(parseBoardLinkPath('/b/b-one')).toEqual({ boardId: 'b-one', elementId: null })
    expect(parseBoardLinkPath('/b/b-one?el=frame-1')).toEqual({ boardId: 'b-one', elementId: 'frame-1' })
    for (const bad of [
      'https://lobby.example/b/b-one',
      '//evil.example/b/b-one',
      '/b/b-one/x',
      '/b/B-ONE',
      '/b/b-one?el=a,b',
      '/b/b-one?view=1,2,3,4',
      '/b/b-one#x',
      ' /b/b-one',
      null,
      42,
    ])
      expect(parseBoardLinkPath(bad), String(bad)).toBeNull()
    expect(boardLinkPath('b-one')).toBe('/b/b-one')
    expect(boardLinkPath('b-one', 'el-1')).toBe('/b/b-one?el=el-1')
    expect(parseBoardLinkPath(boardLinkPath('b-one', 'el-1'))).toEqual({
      boardId: 'b-one',
      elementId: 'el-1',
    })
    expect(BOARD_CARD_KIND).toBe('board-card')
  })

  it('board-cards: 1 to 50 targets, `<board>` or `<board>:<element>`; the 51st refused', () => {
    const ids = Array.from({ length: BOARD_CARDS_MAX_IDS }, (_, i) =>
      boardCardTarget(`b-${i}xx`, i % 2 ? 'e1' : null),
    )
    expect(BoardCardsQuery.parse({ ids: ids.join(',') }).ids).toHaveLength(50)
    expect(BoardCardsQuery.safeParse({ ids: [...ids, 'b-51xx'].join(',') }).success).toBe(false)
    expect(BoardCardsQuery.safeParse({ ids: '' }).success).toBe(false)
    expect(BoardCardsQuery.safeParse({ ids: 'B-ONE' }).success).toBe(false)
    expect(boardCardsPath('b-one', ['b-two', 'b-three:el-1'])).toBe(
      '/api/boards/b-one/board-cards?ids=b-two,b-three%3Ael-1',
    )
  })

  it('a face is ok (title, frame name, same-origin thumbnail) or unavailable with nothing else', () => {
    const ok = { state: 'ok', title: 'Plan', frameName: null, thumbnailPath: '/api/boards/b-two/thumbnail' }
    expect(BoardCardFace.safeParse(ok).success).toBe(true)
    expect(BoardCardFace.safeParse({ ...ok, thumbnailPath: 'https://cdn.example/x.png' }).success).toBe(false)
    expect(BoardCardFace.safeParse({ state: 'unavailable' }).success).toBe(true)
    expect(BoardCardFace.safeParse({ state: 'unavailable', title: 'Secret' }).success).toBe(false)
    expect(BoardCardFace.safeParse({ state: 'forbidden' }).success).toBe(false)
    expect(
      BoardCardsAnswer.safeParse({ cards: { 'b-two': ok, 'b-three:el-1': { state: 'unavailable' } } })
        .success,
    ).toBe(true)
  })

  it('backlinks: at most 50, each a board, its title and the linking element', () => {
    const one = { boardId: 'b-one', title: 'Plan', elementId: 'card-1' }
    expect(BacklinksAnswer.safeParse({ backlinks: [one] }).success).toBe(true)
    expect(BacklinksAnswer.safeParse({ backlinks: Array(BACKLINKS_MAX + 1).fill(one) }).success).toBe(false)
  })

  it('the text route’s links: at most 200, a linking element, a board, an optional element', () => {
    expect(
      BoardTextLinks.safeParse([
        { el: 'card-1', to: 'b-two' },
        { el: 'r1', to: 'b-two', toEl: 'f1' },
      ]).success,
    ).toBe(true)
    expect(BoardTextLinks.safeParse([{ el: 'card-1', to: 'https://x' }]).success).toBe(false)
    expect(
      BoardTextLinks.safeParse(Array(BOARD_TEXT_LINKS_MAX + 1).fill({ el: 'a', to: 'b-two' })).success,
    ).toBe(false)
  })
})

describe('strip-keys (WS2)', () => {
  it('only the wave N key classes, internal path, counts only', () => {
    expect(STRIP_KEYS_ROUTE).toBe('/internal/maintenance/strip-keys')
    expect(StripKeysRequest.safeParse({ prefix: 'react:' }).success).toBe(true)
    for (const prefix of ['plusOne:', 'tag:', '', 'react'])
      expect(StripKeysRequest.safeParse({ prefix }).success, prefix).toBe(false)
    expect(
      StripKeysAnswer.safeParse({ boards: 3, rewritten: 1, elements: 2, keys: 5, failed: 0 }).success,
    ).toBe(true)
  })
})

describe('Capture the room (WS5)', () => {
  it('ledger actions fit the 0028 pattern; the limits are the plan’s', () => {
    for (const a of Object.values(CAPTURE_LEDGER_ACTIONS)) expect(a).toMatch(AI_LEDGER_ACTION_PATTERN)
    expect(CAPTURE_PHOTO_MAX_BYTES).toBe(4 * 1024 * 1024)
    expect(CAPTURE_TRANSCRIPT_MAX_CHARS).toBe(60_000)
    expect(capturePhotoPath('b-one', 'notes')).toBe('/api/boards/b-one/ai/capture/photo?mode=notes')
  })

  it('requests: the mode defaults to auto; a transcript of at most 60,000 characters', () => {
    expect(CapturePhotoQuery.parse({})).toEqual({ mode: 'auto' })
    expect(CapturePhotoQuery.safeParse({ mode: 'sketch' }).success).toBe(false)
    expect(CaptureBoardImageRequest.parse({ elementId: 'img-1' })).toEqual({
      elementId: 'img-1',
      mode: 'auto',
    })
    expect(
      CaptureTranscriptRequest.safeParse({ text: 'x'.repeat(CAPTURE_TRANSCRIPT_MAX_CHARS) }).success,
    ).toBe(true)
    expect(
      CaptureTranscriptRequest.safeParse({ text: 'x'.repeat(CAPTURE_TRANSCRIPT_MAX_CHARS + 1) }).success,
    ).toBe(false)
    expect(CaptureTranscriptRequest.safeParse({ text: '   ' }).success).toBe(false)
  })

  it('results: notes in their layout, a diagram, a meeting; boxes normalised; strict', () => {
    const box = { x: 0.1, y: 0.2, w: 0.1, h: 0.1 }
    const results = [
      {
        kind: 'notes',
        notes: [{ text: 'Ship it', color: 'yellow', box }],
        groups: [{ name: 'Now', notes: [0] }],
      },
      {
        kind: 'diagram',
        nodes: [
          { id: 'n1', label: 'Start', shape: 'ellipse', box },
          { id: 'n2', label: 'Ok?', shape: 'diamond' },
        ],
        edges: [{ from: 'n1', to: 'n2', kind: 'arrow', label: 'then' }],
      },
      {
        kind: 'transcript',
        themes: [{ name: 'Budget', notes: ['Cut travel'] }],
        decisions: ['We ship Friday'],
        actions: [{ text: 'Book the room', owner: 'Sam' }, { text: 'Send notes' }],
      },
    ]
    for (const r of results) {
      expect(CaptureResult.safeParse(r).success, r.kind).toBe(true)
      expect(
        CaptureResponse.safeParse({
          runId: RUN,
          result: r,
          quota: { photosLeftToday: 7, transcriptsLeftToday: null },
        }).success,
      ).toBe(true)
    }
    expect(
      CaptureResult.safeParse({
        ...results[0],
        notes: [{ text: 'x', color: 'yellow', box: { ...box, x: 2 } }],
      }).success,
    ).toBe(false)
    expect(CaptureResult.safeParse({ ...results[0], extra: 1 }).success).toBe(false)
    expect(
      CaptureResult.safeParse({
        kind: 'diagram',
        nodes: [{ id: 'model-1', label: 'x', shape: 'rect' }],
        edges: [],
      }).success,
    ).toBe(false)
  })
})

describe('reaction codes and the wave N usage events', () => {
  it('every new event is a usage event of the stored pattern; the new commands are pending', () => {
    const fixed = [
      'reactions.clear',
      'visits.chip.shown',
      'visits.tour',
      'visits.markseen',
      'ai.capture.photo',
      'ai.capture.boardimage',
      'ai.capture.transcript',
      'ai.capture.apply',
      'export.pdf.vector',
      'export.pdf.raster',
      'boardlinks.insert',
      'boardlinks.open',
      'boardlinks.backlinks',
      'open.decode:worker',
      'open.decode:main',
      'open.apply:diff',
      'open.apply:chunked',
      'open.apply:full',
      ...REACTION_CODES.map((c) => `reactions.add:${c}`),
    ]
    for (const e of fixed) {
      expect(isUsageEvent(e), e).toBe(true)
      expect(e).toMatch(USAGE_EVENT_PATTERN)
    }
    expect(new Set(USAGE_EVENTS).size).toBe(USAGE_EVENTS.length)
    const wn = ['reactions.react', 'board-links.insert', 'board-links.backlinks', 'ai.capture']
    for (const id of wn) {
      expect(PALETTE_COMMAND_IDS as readonly string[]).toContain(id)
      expect(PENDING_PALETTE_COMMAND_IDS as readonly string[]).toContain(id)
    }
  })
})
