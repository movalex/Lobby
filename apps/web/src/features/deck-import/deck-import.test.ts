// WS4 (wave W, deck import; docs/WAVE-W-CONTRACTS.md §6): the web side of "Insert as slides" in Node: which cards
// are decks, the slide grid, the placement as ONE transact (frames in page order, Present's reading order), the wait
// for pages 9+ (the api's answers, the requester's file.op events, the meta), the meta refresh it relies on, and the
// feature's entries (offered only with the switch and the api's offer; the palette id held while pending).
import { presentationOrderOf } from '@draftroom/board-ops/elements'
import {
  DECK_LIMITS,
  FILE_OP_EVENT,
  type FileOpState,
  FORMAT_ELEMENT_KINDS,
  FORMAT_SWITCHES_OFF,
  WORKER_OP_LIMITS,
  WORKER_OP_MESSAGES,
} from '@draftroom/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../api/client.ts'
import type { AssetVersionMeta, DerivativeRecord } from '../../assets/contract.ts'
import { AssetMetaStore, type MetaSnapshot } from '../../assets/meta-store.ts'
import type { CanvasFeatureContext } from '../../canvas/api/index.ts'
import { FileUrlResolver } from '../../canvas/files/resolve.ts'
import type { FileFacts } from '../../file-card/ported/model.ts'
import { FORMATS_FLAG_KEYS, setFormatsOffer } from '../formats/flags.ts'
import { el, fakeCanvas } from '../workshops/ported/test-kit.ts'
import { deckCardOf, deckCommandHeld, feature } from './index.tsx'
import { DECK_WAIT_MS, type DeckJobDeps, prepareDeck } from './job.ts'
import {
  DECK_COPY,
  deckKindOf,
  deckPlan,
  layoutSlides,
  missingPages,
  renderProgress,
  slideAlt,
  slidePagesOf,
  workingText,
} from './model.ts'
import { placeDeck } from './place.ts'

const VER = 'ver_0123456789abcdefghij'
const AST = 'ast_0123456789abcdefghij'
const BOARD = 'b-board0001'
const FACTS: FileFacts = {
  assetId: AST,
  versionId: VER,
  kind: 'pdf',
  name: 'Pitch.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 1000,
}

let drv = 0
const d = (page: number, width = 1024, height = 576): DerivativeRecord =>
  ({
    id: `drv_${String(++drv).padStart(20, '0')}`,
    role: 'page',
    page,
    width,
    height,
    mimeType: 'image/webp',
    bytes: 10,
    file: 'x.webp',
  }) as unknown as DerivativeRecord

/** A ready PDF meta of `total` pages with pictures of `pages`. */
function meta(total: number, pages: number[], size?: (p: number) => [number, number]): AssetVersionMeta {
  return {
    assetId: AST,
    versionId: VER,
    boardId: BOARD,
    kind: 'pdf',
    name: 'Pitch.pdf',
    mimeType: 'application/pdf',
    status: 'ready',
    probe: { pageCount: total },
    derivatives: pages.map((p) => d(p, ...(size ? size(p) : ([1024, 576] as [number, number])))),
  } as unknown as AssetVersionMeta
}
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i)

describe('the model', () => {
  it('a deck is a PDF, PowerPoint or OpenDocument presentation card; a .key file is Keynote; anything else neither', () => {
    expect(deckKindOf(FACTS)).toBe('deck')
    expect(
      deckKindOf({
        ...FACTS,
        name: 'Q3.pptx',
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      }),
    ).toBe('deck')
    expect(deckKindOf({ ...FACTS, name: 'Talk.odp', mimeType: 'application/octet-stream' })).toBe('deck')
    expect(
      deckKindOf({
        ...FACTS,
        name: 'Notes.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
    ).toBeNull()
    expect(
      deckKindOf({ ...FACTS, kind: 'other', name: 'Keynote talk.key', mimeType: 'application/zip' }),
    ).toBe('keynote')
    expect(deckKindOf({ ...FACTS, kind: 'image', name: 'x.png', mimeType: 'image/png' })).toBeNull()
    expect(deckKindOf(null)).toBeNull()
  })

  it('the plan: the first 100 pages, pages past 8 to make first', () => {
    expect(deckPlan(5)).toEqual({ total: 5, slides: 5, truncated: false, needsRender: false })
    expect(deckPlan(8)).toEqual({ total: 8, slides: 8, truncated: false, needsRender: false })
    expect(deckPlan(9)).toEqual({ total: 9, slides: 9, truncated: false, needsRender: true })
    expect(deckPlan(100)).toEqual({ total: 100, slides: 100, truncated: false, needsRender: true })
    expect(deckPlan(101)).toEqual({ total: 101, slides: 100, truncated: true, needsRender: true })
  })

  it('which pages are missing, and the progress of pages past 8', () => {
    const m = meta(12, [...range(1, 8), 10])
    expect(missingPages(m, 12)).toEqual([9, 11, 12])
    expect(renderProgress(m, 12)).toEqual({ ready: 1, of: 4 })
    expect(slidePagesOf(meta(120, range(1, 120)), 100)).toHaveLength(100)
  })

  it('the grid: 1600 wide at each page’s aspect, 5 to a row, 80 apart, rows top-aligned', () => {
    const pages = slidePagesOf(
      meta(7, range(1, 7), (p) => (p === 3 ? [768, 1024] : [1024, 576])),
      7,
    )
    const g = layoutSlides(pages)
    expect(g.slides.map((s) => [s.page, s.x, s.y, s.w, s.h])).toEqual([
      [1, 0, 0, 1600, 900],
      [2, 1680, 0, 1600, 900],
      [3, 3360, 0, 1600, 2133.33],
      [4, 5040, 0, 1600, 900],
      [5, 6720, 0, 1600, 900],
      [6, 0, 2213.33, 1600, 900],
      [7, 1680, 2213.33, 1600, 900],
    ])
    expect(g.w).toBe(5 * 1600 + 4 * DECK_LIMITS.gridGap)
    expect(g.h).toBe(2213.33 + 900)
    expect(layoutSlides([])).toEqual({ w: 0, h: 0, slides: [] })
  })
})

describe('placing a deck', () => {
  const card = () =>
    el('card', 'image', {
      x: 0,
      y: 0,
      width: 320,
      height: 240,
      fileId: VER,
      customData: { lobby: { file: FACTS } },
    })

  it('one transact: per slide a deck-slide frame and its deck-page picture inside, in page order, Present walks them', () => {
    const f = fakeCanvas([card()])
    const pages = slidePagesOf(meta(12, range(1, 12)), 12)
    const placed = placeDeck(f.canvas, 'card', FACTS, pages, 12)
    expect(f.steps).toEqual(['Insert slides'])
    expect(placed.frames).toHaveLength(12)
    expect(placed.images).toHaveLength(12)
    type Placed = {
      id: string
      type: string
      name?: string
      x: number
      y: number
      width: number
      height: number
      frameId?: string | null
      fileId?: string
      customData: { lobby: Record<string, unknown> }
    }
    const frames = placed.frames.map((id) => f.canvas.get(id) as unknown as Placed)
    const images = placed.images.map((id) => f.canvas.get(id) as unknown as Placed)
    frames.forEach((fr, i) => {
      expect(fr.type).toBe('frame')
      expect(fr.name).toBe(`Slide ${i + 1}`)
      expect(fr.customData).toEqual({ lobby: { kind: FORMAT_ELEMENT_KINDS.deckSlide } })
      expect([fr.width, fr.height]).toEqual([1600, 900])
      const im = images[i] as Placed
      expect(im.type).toBe('image')
      expect(im.frameId).toBe(fr.id)
      expect([im.x, im.y, im.width, im.height]).toEqual([fr.x, fr.y, fr.width, fr.height])
      expect(im.fileId).toBe(`${VER}.p${i + 1}`)
      expect(im.customData.lobby).toEqual({
        file: FACTS,
        pdfPage: i + 1,
        alt: slideAlt(i + 1, 12),
        kind: FORMAT_ELEMENT_KINDS.deckPage,
      })
      // no URL, no bytes: only stable ids
      expect(JSON.stringify(im)).not.toMatch(/data:|blob:|https?:/)
    })
    // right of the card, clear of it
    expect(Math.min(...frames.map((fr) => fr.x))).toBeGreaterThanOrEqual(320 + 80)
    // the frames are selected; Present's order (reading order) is page order
    expect(f.selection).toEqual(placed.frames)
    expect(presentationOrderOf(f.canvas.items()).map((e) => e.name)).toEqual(
      range(1, 12).map((n) => `Slide ${n}`),
    )
  })

  it('a card inside a frame: the slides still go on the page (frames never nest), clear of the frame', () => {
    const f = fakeCanvas([
      el('outer', 'frame', { x: -50, y: -50, width: 3000, height: 1000, name: 'Board area' }),
      { ...card(), frameId: 'outer' } as never,
    ])
    const placed = placeDeck(f.canvas, 'card', FACTS, slidePagesOf(meta(3, [1, 2, 3]), 3), 3)
    for (const id of placed.frames) {
      const fr = f.canvas.get(id) as unknown as {
        frameId: string | null
        x: number
        y: number
        height: number
      }
      expect(fr.frameId ?? null).toBeNull()
      const clear = fr.x >= 3000 - 50 || fr.y >= 1000 - 50 || fr.y + fr.height <= -50
      expect(clear).toBe(true)
    }
  })

  it('nothing on a read-only canvas, with no pages, or without the card', () => {
    const f = fakeCanvas([card()])
    f.readOnly = true
    expect(placeDeck(f.canvas, 'card', FACTS, slidePagesOf(meta(3, [1, 2, 3]), 3), 3)).toEqual({
      frames: [],
      images: [],
    })
    f.readOnly = false
    expect(placeDeck(f.canvas, 'card', FACTS, [], 3).frames).toEqual([])
    expect(placeDeck(f.canvas, 'gone', FACTS, slidePagesOf(meta(3, [1]), 3), 3).frames).toEqual([])
    expect(f.steps).toEqual([])
  })
})

// ---- the wait for pages 9+ -----------------------------------------------------------------------------------------

function fakeEvents() {
  const listeners = new Map<string, ((data: unknown) => void)[]>()
  const resync: (() => void)[] = []
  return {
    on(type: string, l: (data: unknown) => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), l])
      return () =>
        listeners.set(
          type,
          (listeners.get(type) ?? []).filter((x) => x !== l),
        )
    },
    onResync(l: () => void) {
      resync.push(l)
      return () => {}
    },
    emit(type: string, data: unknown) {
      for (const l of listeners.get(type) ?? []) l(data)
    },
    count: (type: string) => (listeners.get(type) ?? []).length,
  }
}

const opState = (over: Partial<FileOpState> = {}): FileOpState => ({
  id: 'wop_0123456789abcdefghij',
  kind: 'render-pages',
  status: 'queued',
  boardId: BOARD,
  sourceVersionId: VER,
  resultVersionId: null,
  pagesReady: null,
  errorCode: null,
  message: null,
  createdAt: '2026-10-19T12:00:00.000Z',
  finishedAt: null,
  ...over,
})

function job(o: {
  metas: AssetVersionMeta[]
  post?: () => Promise<unknown>
  get?: () => Promise<unknown>
  slides?: number
  /** the job's own default time limit (DECK_WAIT_MS) instead of the tests' minute */
  defaultWait?: boolean
}) {
  const events = fakeEvents()
  const ac = new AbortController()
  let i = 0
  const calls: { method: string; path: string; body?: unknown }[] = []
  const refresh = vi.fn(async (): Promise<MetaSnapshot> => {
    const m = o.metas[Math.min(i, o.metas.length - 1)] as AssetVersionMeta
    i++
    return { meta: m, missing: false, error: false }
  })
  const progress: { ready: number; of: number; stage: string }[] = []
  const deps: DeckJobDeps = {
    request: (async (method: string, path: string, opts: { body?: unknown }) => {
      calls.push({ method, path, body: opts.body })
      if (method === 'POST') return o.post ? o.post() : opState()
      return o.get ? o.get() : opState()
    }) as never,
    events: events as unknown as DeckJobDeps['events'],
    refresh,
    boardId: BOARD,
    versionId: VER,
    slides: o.slides ?? 12,
    signal: ac.signal,
    onProgress: (p) => progress.push(p),
    pollMs: 1_000,
    ...(o.defaultWait ? {} : { waitMs: 60_000 }),
  }
  return { deps, events, ac, calls, refresh, progress, run: () => prepareDeck(deps) }
}

afterEach(() => vi.useRealTimers())

describe('getting the pages ready', () => {
  it('every page there already: ready at once, no request', async () => {
    const j = job({ metas: [meta(12, range(1, 12))] })
    const out = await j.run()
    expect(out.kind).toBe('ready')
    expect(out.kind === 'ready' && out.pages.map((p) => p.page)).toEqual(range(1, 12))
    expect(j.calls).toEqual([])
  })

  it('asks for the pages, then waits: the requester’s done event makes it look again; ready when all are there', async () => {
    vi.useFakeTimers()
    const j = job({ metas: [meta(12, range(1, 8)), meta(12, range(1, 10)), meta(12, range(1, 12))] })
    const p = j.run()
    await vi.advanceTimersByTimeAsync(0)
    expect(j.calls).toEqual([
      { method: 'POST', path: `/api/files/${VER}/render-pages`, body: { boardId: BOARD } },
    ])
    expect(j.events.count(FILE_OP_EVENT)).toBe(1)
    // an op of another file, or of another kind: ignored
    j.events.emit(FILE_OP_EVENT, {
      op: opState({ status: 'done', sourceVersionId: 'ver_99999999999999999999' }),
    })
    j.events.emit(FILE_OP_EVENT, { op: opState({ status: 'failed', kind: 'remove-bg', message: 'x' }) })
    j.events.emit(FILE_OP_EVENT, { op: opState({ status: 'done', pagesReady: 12 }) })
    await vi.advanceTimersByTimeAsync(0)
    // a poll finds the rest
    await vi.advanceTimersByTimeAsync(1_000)
    const out = await p
    expect(out.kind).toBe('ready')
    expect(out.kind === 'ready' && out.pages).toHaveLength(12)
    expect(j.progress.at(-1)).toMatchObject({ ready: 4, of: 4 })
    // nothing left listening or polling
    expect(j.events.count(FILE_OP_EVENT)).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('an op of this file that fails: its fixed message, with the pages that are ready', async () => {
    vi.useFakeTimers()
    const j = job({ metas: [meta(40, range(1, 20))], slides: 40 })
    const p = j.run()
    await vi.advanceTimersByTimeAsync(0)
    j.events.emit(FILE_OP_EVENT, {
      op: opState({
        status: 'failed',
        errorCode: 'RENDER_PAGES_FAILED',
        message: 'The slides of this file could not be made.',
      }),
    })
    const out = await p
    expect(out).toMatchObject({ kind: 'error', message: 'The slides of this file could not be made.' })
    expect(out.kind === 'error' && out.pages).toHaveLength(20)
  })

  it('the op state route telling of a failure no event brought (a queued op nobody ran)', async () => {
    vi.useFakeTimers()
    const j = job({
      metas: [meta(12, range(1, 8))],
      get: async () =>
        opState({
          status: 'failed',
          errorCode: 'WORKER_UNAVAILABLE',
          message: 'This is not available right now. Try again later.',
        }),
    })
    const p = j.run()
    await vi.advanceTimersByTimeAsync(4_000)
    const out = await p
    expect(out).toMatchObject({ kind: 'error', message: 'This is not available right now. Try again later.' })
    expect(j.calls.filter((c) => c.method === 'GET').map((c) => c.path)).toEqual([
      '/api/file-ops/wop_0123456789abcdefghij',
    ])
  })

  it('NOTHING_TO_RENDER: the pages exist, looked up again', async () => {
    const j = job({
      metas: [meta(12, range(1, 8)), meta(12, range(1, 12))],
      post: async () => {
        throw new ApiError(
          'conflict',
          409,
          'NOTHING_TO_RENDER',
          'Every slide of this file is ready to place.',
        )
      },
    })
    expect((await j.run()).kind).toBe('ready')
  })

  it('FILE_OP_ACTIVE: someone is making them; the meta decides', async () => {
    vi.useFakeTimers()
    const j = job({
      metas: [meta(12, range(1, 8)), meta(12, range(1, 8)), meta(12, range(1, 12))],
      post: async () => {
        throw new ApiError('conflict', 409, 'FILE_OP_ACTIVE', 'busy')
      },
    })
    const p = j.run()
    await vi.advanceTimersByTimeAsync(2_000)
    expect((await p).kind).toBe('ready')
  })

  it('a guest is told to place the first 8; the route not there is "not available"; a time limit; a stop', async () => {
    const guest = job({
      metas: [meta(12, range(1, 8))],
      post: async () => {
        throw new ApiError('forbidden', 403, 'GUEST_ACCOUNT_REQUIRED', 'Guests…')
      },
    })
    expect(await guest.run()).toEqual({ kind: 'guest' })
    const gone = job({
      metas: [meta(12, range(1, 8))],
      post: async () => {
        throw new ApiError('not-found', 404, 'NOT_FOUND', 'Not found.')
      },
    })
    expect(await gone.run()).toMatchObject({ kind: 'error', message: DECK_COPY.unavailable })
    vi.useFakeTimers()
    const slow = job({ metas: [meta(12, range(1, 8))] })
    const p = slow.run()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(await p).toMatchObject({ kind: 'error', message: DECK_COPY.slow })
    const stop = job({ metas: [meta(12, range(1, 8))] })
    const q = stop.run()
    await vi.advanceTimersByTimeAsync(0)
    stop.ac.abort()
    expect(await q).toEqual({ kind: 'cancelled' })
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('waiting honestly for the file worker', () => {
  it('says queued while the ops wait for the worker, then shows the pages being made once one runs', async () => {
    vi.useFakeTimers()
    const j = job({ metas: [meta(40, range(1, 8))], slides: 40 })
    const p = j.run()
    await vi.advanceTimersByTimeAsync(0)
    expect(j.progress.at(-1)).toEqual({ ready: 0, of: 32, stage: 'queued' })
    expect(workingText({ ready: 0, of: 32, stage: 'queued' })).toBe(
      'Queued: waiting for the file worker… 0 of 32 ready',
    )
    j.events.emit(FILE_OP_EVENT, { op: opState({ status: 'running' }) })
    expect(j.progress.at(-1)).toEqual({ ready: 0, of: 32, stage: 'running' })
    expect(workingText({ ready: 3, of: 32, stage: 'running' })).toBe('Making slides… 3 of 32 ready')
    j.ac.abort()
    expect(await p).toEqual({ kind: 'cancelled' })
  })

  it('the new codes show their contract messages (from the event or the op route, whatever the api sent)', async () => {
    vi.useFakeTimers()
    const busy = job({ metas: [meta(12, range(1, 8))] })
    const p = busy.run()
    await vi.advanceTimersByTimeAsync(0)
    busy.events.emit(FILE_OP_EVENT, {
      op: opState({ status: 'failed', errorCode: 'WORKER_BUSY', message: null }),
    })
    expect(await p).toMatchObject({ kind: 'error', message: WORKER_OP_MESSAGES.WORKER_BUSY })
    const complex = job({
      metas: [meta(12, range(1, 8))],
      get: async () => opState({ status: 'failed', errorCode: 'FILE_TOO_COMPLEX', message: 'older words' }),
    })
    const q = complex.run()
    await vi.advanceTimersByTimeAsync(4_000)
    expect(await q).toMatchObject({ kind: 'error', message: WORKER_OP_MESSAGES.FILE_TOO_COMPLEX })
  })

  it('the local time limit never fires before the api decides a queued request (WORKER_BUSY at 30 min)', async () => {
    expect(DECK_WAIT_MS).toBeGreaterThan(
      WORKER_OP_LIMITS.requestedQueueDeadlineMs + WORKER_OP_LIMITS.maxAttempts * WORKER_OP_LIMITS.leaseMs,
    )
    vi.useFakeTimers()
    const j = job({
      metas: [meta(12, range(1, 8))],
      get: async () => opState({ status: 'queued' }),
      defaultWait: true,
    })
    let out: unknown = null
    void j.run().then((o) => {
      out = o
    })
    // a queue busy for 35 minutes, the op still queued: the dialog keeps waiting and says so
    await vi.advanceTimersByTimeAsync(35 * 60_000)
    expect(out).toBeNull()
    expect(j.progress.at(-1)).toMatchObject({ stage: 'queued' })
    // the api's answer ends it with its message
    j.events.emit(FILE_OP_EVENT, {
      op: opState({ status: 'failed', errorCode: 'WORKER_BUSY', message: null }),
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(out).toMatchObject({ kind: 'error', message: WORKER_OP_MESSAGES.WORKER_BUSY })
    expect(vi.getTimerCount()).toBe(0)
  })
})

// ---- the meta refresh the slides rely on (shared: assets/meta-store.ts, canvas/files/resolve.ts) ---------------------

describe('a ready PDF that gains pages later', () => {
  function store(answers: AssetVersionMeta[]) {
    let n = 0
    let t = 0
    const s = new AssetMetaStore({
      fetchImpl: (async () => {
        const body = answers[Math.min(n, answers.length - 1)]
        n++
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }) as typeof fetch,
      now: () => t,
    })
    return { s, fetches: () => n, tick: (ms: number) => (t += ms) }
  }

  it('refresh asks again for a terminal answer, at most once per interval', async () => {
    const m = store([meta(12, range(1, 8)), meta(12, range(1, 12))])
    expect((await m.s.load(BOARD, AST, VER)).meta?.derivatives).toHaveLength(8)
    expect((await m.s.load(BOARD, AST, VER)).meta?.derivatives).toHaveLength(8)
    expect(m.fetches()).toBe(1)
    // too soon after the last answer: the cached one
    expect((await m.s.refresh(BOARD, AST, VER)).meta?.derivatives).toHaveLength(8)
    expect(m.fetches()).toBe(1)
    m.tick(5_000)
    expect((await m.s.refresh(BOARD, AST, VER)).meta?.derivatives).toHaveLength(12)
    expect(m.fetches()).toBe(2)
    // forced
    expect((await m.s.refresh(BOARD, AST, VER, 0)).meta?.derivatives).toHaveLength(12)
    expect(m.fetches()).toBe(3)
  })

  it('the board loader’s resolver asks again for a placed page its cached answer lacks', async () => {
    const m = store([meta(12, range(1, 8)), meta(12, range(1, 12))])
    const r = new FileUrlResolver({ boardId: BOARD, meta: m.s })
    r.learnRef(VER, AST)
    // the card's cover first: the version's answer is cached (pages 1..8)
    expect(
      await r.resolveUrl(VER, 'thumb', { key: VER, versionId: VER, derivative: 'thumb', page: null }),
    ).toMatch(/\/d\/drv_/)
    m.tick(5_000)
    const url = await r.resolveUrl(VER, 'thumb', {
      key: `${VER}.p11`,
      versionId: VER,
      derivative: 'thumb',
      page: 11,
    })
    expect(url).toMatch(new RegExp(`^/files/${AST}/${VER}/d/drv_`))
    expect(m.fetches()).toBe(2)
    // a page past the document's end never resolves (and asks at most once per interval)
    expect(
      await r.resolveUrl(VER, 'thumb', { key: `${VER}.p13`, versionId: VER, derivative: 'thumb', page: 13 }),
    ).toBeNull()
    expect(m.fetches()).toBe(2)
  })
})

// ---- the feature's entries ------------------------------------------------------------------------------------------

describe('the deck-import feature', () => {
  afterEach(() => {
    setFormatsOffer(null)
    try {
      globalThis.localStorage?.removeItem(FORMATS_FLAG_KEYS.deckImport)
    } catch {}
  })

  const ctxOf = (f: ReturnType<typeof fakeCanvas>) =>
    ({ canvas: f.canvas, registries: {} as never }) as unknown as CanvasFeatureContext

  it('offers "Insert as slides" on one deck or Keynote card only, and only with the switch and the api’s offer', () => {
    const f = fakeCanvas([
      el('card', 'image', { fileId: VER, customData: { lobby: { file: FACTS } } }),
      el('page', 'image', { fileId: `${VER}.p2`, customData: { lobby: { file: FACTS, pdfPage: 2 } } }),
      el('key', 'image', {
        fileId: 'ver_keynote0000000000001',
        customData: {
          lobby: {
            file: {
              ...FACTS,
              versionId: 'ver_keynote0000000000001',
              kind: 'other',
              name: 'Talk.key',
              mimeType: 'application/zip',
            },
          },
        },
      }),
      el('note', 'stickynote'),
    ])
    const ctx = ctxOf(f)
    expect(deckCardOf(ctx, ['card'])).toEqual({ id: 'card', kind: 'deck' })
    expect(deckCardOf(ctx, ['key'])).toEqual({ id: 'key', kind: 'keynote' })
    expect(deckCardOf(ctx, ['page'])).toBeNull()
    expect(deckCardOf(ctx, ['note'])).toBeNull()
    expect(deckCardOf(ctx, ['card', 'note'])).toBeNull()
    const entry = feature.contextMenu?.find((m) => m.id === 'deck-import.insert-slides')
    const target = { ids: ['card'], point: null, hit: null }
    // the shipped web switch is on (the wave W integration): the api's offer decides
    setFormatsOffer({ ...FORMAT_SWITCHES_OFF, deckImport: true })
    expect(entry?.visible?.(ctx, target)).toBe(true)
    expect(entry?.visible?.(ctx, { ...target, ids: ['note'] })).toBe(false)
    setFormatsOffer({ ...FORMAT_SWITCHES_OFF })
    expect(entry?.visible?.(ctx, target)).toBe(false)
  })

  it('the palette command is held while the contracts list deck.insert-slides pending', () => {
    expect(deckCommandHeld(['deck.insert-slides'])).toBe(true)
    expect(deckCommandHeld([])).toBe(false)
    expect((feature.commands ?? []).some((c) => c.id === 'deck.insert-slides')).toBe(!deckCommandHeld())
    expect(feature.overlays?.map((o) => o.id)).toEqual(['deck-import.dialog'])
  })
})
