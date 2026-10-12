// Wave N, N4-3/N4-4: the 'visits' feature's life on a board page, with a fake canvas: what it asks the api and when, what it
// hands Catch me up, when it says "seen", what it never does (write to the board, ask for a guest, show a first visit), and
// the chip's actions. The pure parts are model.test.ts, refine (in model.test.ts), view.test.ts and run.test.ts.
import { VISIT_HIGHLIGHT_FADE_MS } from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanvasFeatureContext, LobbyCanvas } from '../../canvas/api/index.ts'
import { markRoomReady } from '../../canvas/api/room-ready.ts'
import { seedUserKind } from '../../invite/guest.tsx'
import { catchUpWindow, resetVisits } from '../ai/recap/window.ts'
import { ackKey } from './ack.ts'
import { actionsOf, feature } from './index.tsx'
import { visitsView } from './view.ts'

const SEEN = 1_700_000_000_000
const AFTER = SEEN + 60_000
const BOARD = 'b-board00001'

const g = globalThis as { fetch?: unknown; sessionStorage?: unknown }
const originals: Record<string, PropertyDescriptor | undefined> = {}
let requests: { url: string; method: string }[]
let beacons: string[]
let answer: { status: number; body: unknown }
let uid = 0

const setGlobal = (name: string, value: unknown) => {
  if (!(name in originals)) originals[name] = Object.getOwnPropertyDescriptor(globalThis, name)
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
}

beforeEach(() => {
  vi.useFakeTimers()
  resetVisits()
  requests = []
  beacons = []
  answer = { status: 200, body: { previousSeenAt: SEEN, seenAt: AFTER + 5_000 } }
  setGlobal('fetch', async (url: string, init?: RequestInit) => {
    requests.push({ url, method: init?.method ?? 'GET' })
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'content-type': 'application/json' },
    })
  })
  setGlobal('navigator', {
    sendBeacon: (url: string) => {
      beacons.push(url)
      return true
    },
  })
  const mem = new Map<string, string>()
  setGlobal('sessionStorage', {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
  })
})
afterEach(() => {
  vi.useRealTimers()
  for (const [name, d] of Object.entries(originals)) {
    if (d) Object.defineProperty(globalThis, name, d)
    else delete (globalThis as Record<string, unknown>)[name]
  }
})

type Hook = (e: unknown) => void
function fakeWindow() {
  const hooks = new Map<string, Set<Hook>>()
  return {
    addEventListener: (type: string, fn: Hook) =>
      void (hooks.get(type) ?? hooks.set(type, new Set()).get(type))?.add(fn),
    removeEventListener: (type: string, fn: Hook) => void hooks.get(type)?.delete(fn),
    fire: (type: string) => {
      for (const fn of hooks.get(type) ?? []) fn({})
    },
    listeners: (type: string) => hooks.get(type)?.size ?? 0,
  }
}

/** The page's document: a visibility state and 'visibilitychange' listeners, like a browser's. */
function fakeDocument(win: ReturnType<typeof fakeWindow>) {
  const w = fakeWindow()
  const doc = {
    defaultView: win,
    visibilityState: 'visible' as 'visible' | 'hidden',
    addEventListener: w.addEventListener,
    removeEventListener: w.removeEventListener,
    listeners: w.listeners,
    /** the browser turns the page hidden (a tab switch, an app switch on a phone) or visible and says so */
    setVisibility(state: 'visible' | 'hidden') {
      doc.visibilityState = state
      w.fire('visibilitychange')
    },
  }
  return doc
}

interface Fake {
  ctx: CanvasFeatureContext
  canvas: LobbyCanvas
  win: ReturnType<typeof fakeWindow>
  doc: ReturnType<typeof fakeDocument>
  writes: string[]
  zoomed: { bounds: unknown; opts: unknown }[]
}

/** A board with one note added and one edited since SEEN, and one deleted, as the scene holds them. */
function fakeCtx(o: { guest?: boolean; role?: string } = {}): Fake {
  const win = fakeWindow()
  const doc = fakeDocument(win)
  const writes: string[] = []
  const zoomed: Fake['zoomed'] = []
  const note = (id: string, created: number, updated: number) => ({
    id,
    type: 'stickynote',
    isDeleted: false,
    updated,
    customData: { lobbyServer: { createdAt: created } },
  })
  const live = [
    note('old', SEEN - 5_000, SEEN - 5_000),
    note('new', AFTER, AFTER),
    note('edited', SEEN - 5_000, AFTER),
  ]
  const dead = { id: 'gone', type: 'stickynote', isDeleted: true, updated: AFTER }
  const boundsOf: Record<string, { x: number; y: number; width: number; height: number }> = {
    new: { x: 0, y: 0, width: 100, height: 100 },
    edited: { x: 300, y: 0, width: 100, height: 100 },
  }
  const trap = (name: string) => () => {
    writes.push(name)
    throw new Error(`the visits feature called canvas.${name}`)
  }
  const canvas = {
    container: () => ({ ownerDocument: doc }),
    items: () => live,
    engine: { elements: () => new Map([...live, dead].map((e) => [e.id, e])) },
    isHidden: () => false,
    bounds: (id: string) => boundsOf[id] ?? null,
    viewport: { zoomTo: (bounds: unknown, opts: unknown) => void zoomed.push({ bounds, opts }) },
    follow: { current: () => null },
    settings: { get: () => ({ focusMode: false }) },
    // everything that writes or moves what other people see
    transact: trap('transact'),
    select: trap('select'),
    setTool: trap('setTool'),
    doc: { set: trap('doc.set') },
  } as unknown as LobbyCanvas
  const id = `usr_visitor${++uid}`
  if (o.guest) seedUserKind(id, 'guest')
  else seedUserKind(id, 'account')
  const ctx = {
    canvas,
    board: { id: BOARD, status: 'active' },
    me: { user: { id } },
    role: o.role ?? 'editor',
    registries: {},
    // no history access: the optional reads fail quietly and the timestamps' answer stands
    api: { request: async () => Promise.reject(new Error('403')) },
  } as unknown as CanvasFeatureContext
  return { ctx, canvas, win, doc, writes, zoomed }
}

/** Lets the fetch, the room wait and the compute run. */
const settle = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve()
  await vi.advanceTimersByTimeAsync(0)
}

describe('on a board page', () => {
  it('a name-only guest asks for nothing and keeps the device-local window', async () => {
    const f = fakeCtx({ guest: true })
    const cleanup = feature.onMount?.(f.ctx)
    markRoomReady(f.canvas)
    await settle()
    expect(cleanup).toBeUndefined()
    expect(requests).toEqual([])
    expect(visitsView(f.canvas).get()).toBeNull()
    expect(f.win.listeners('pagehide')).toBe(0)
    expect(f.doc.listeners('visibilitychange')).toBe(0)
    expect(catchUpWindow(BOARD, AFTER, null).visit).toBe(false)
  })

  it('asks for the visit once, hands the previous time to Catch me up, and shows what changed once the room is ready', async () => {
    const f = fakeCtx()
    const cleanup = feature.onMount?.(f.ctx)
    await settle()
    expect(requests).toEqual([{ url: `/api/boards/${BOARD}/visit`, method: 'POST' }])
    // Catch me up reads the server's time (N4-4), even before the room is ready
    expect(catchUpWindow(BOARD, AFTER + 10_000, null)).toEqual({ since: SEEN, visit: true })
    expect(visitsView(f.canvas).get()).toBeNull() // the room is not ready yet
    markRoomReady(f.canvas)
    await settle()
    const view = visitsView(f.canvas).get()
    expect(view?.changes.counts).toEqual({ added: 1, changed: 1, removed: 1 })
    expect(view?.changes.added).toEqual(['new'])
    expect(view?.changes.changed).toEqual(['edited'])
    expect(view?.visitSeenAt).toBe(AFTER + 5_000)
    expect(view).toMatchObject({ outlines: true, hidden: false, tour: -1 })
    // read-only on the board: nothing was written, selected or changed
    expect(f.writes).toEqual([])
    expect(requests).toHaveLength(1)
    cleanup?.()
  })

  it('a first visit (null previous) shows nothing and leaves Catch me up on this device', async () => {
    answer = { status: 200, body: { previousSeenAt: null, seenAt: AFTER } }
    const f = fakeCtx()
    const cleanup = feature.onMount?.(f.ctx)
    markRoomReady(f.canvas)
    await settle()
    expect(visitsView(f.canvas).get()).toBeNull()
    expect(catchUpWindow(BOARD, AFTER + 1, null).visit).toBe(false)
    cleanup?.()
  })

  it('an api without the route, or a refusal, shows nothing, says nothing and sends no "seen"', async () => {
    for (const status of [404, 403, 500]) {
      answer = { status, body: { error: { code: 'X', message: 'no' } } }
      beacons.length = 0
      const f = fakeCtx()
      const cleanup = feature.onMount?.(f.ctx)
      markRoomReady(f.canvas)
      await settle()
      expect(visitsView(f.canvas).get(), String(status)).toBeNull()
      f.win.fire('pagehide')
      f.doc.setVisibility('hidden')
      cleanup?.()
      expect(beacons, String(status)).toEqual([])
    }
  })

  it('a board left while it is in front says "seen" once (the cleanup), and forgets the visit with the page', async () => {
    const f = fakeCtx()
    const cleanup = feature.onMount?.(f.ctx)
    markRoomReady(f.canvas)
    await settle()
    expect(f.win.listeners('pagehide')).toBe(1)
    expect(f.win.listeners('pageshow')).toBe(1)
    expect(beacons).toEqual([])
    cleanup?.()
    expect(beacons).toEqual([`/api/boards/${BOARD}/visit/seen`])
    expect(f.win.listeners('pagehide')).toBe(0)
    expect(f.win.listeners('pageshow')).toBe(0)
    expect(visitsView(f.canvas).get()).toBeNull()
    expect(catchUpWindow(BOARD, AFTER + 1, null).visit).toBe(false) // forgotten with the page
  })

  it('wave N.1: leaving the page sends ONE beacon: hidden, then pagehide, then the board closing say it once', async () => {
    const f = fakeCtx()
    const cleanup = feature.onMount?.(f.ctx)
    markRoomReady(f.canvas)
    await settle()
    // a tab closed: the browser turns the page hidden, then fires pagehide (and a React unmount may follow)
    f.doc.setVisibility('hidden')
    f.win.fire('pagehide')
    cleanup?.()
    expect(beacons).toEqual([`/api/boards/${BOARD}/visit/seen`])
  })

  it('wave N.1: pagehide alone says it once, and the cleanup after it says nothing more', async () => {
    const f = fakeCtx()
    const cleanup = feature.onMount?.(f.ctx)
    markRoomReady(f.canvas)
    await settle()
    f.win.fire('pagehide')
    expect(beacons).toEqual([`/api/boards/${BOARD}/visit/seen`])
    cleanup?.()
    expect(beacons).toHaveLength(1)
  })

  it('wave N.1: a page that came back in front (a tab switch back, a back-forward restore) says "seen" again when it leaves', async () => {
    const f = fakeCtx()
    const cleanup = feature.onMount?.(f.ctx)
    markRoomReady(f.canvas)
    await settle()
    f.win.fire('pagehide')
    expect(beacons).toHaveLength(1)
    // restored from the back-forward cache: pageshow, the page is in front again
    f.win.fire('pageshow')
    f.win.fire('pagehide')
    expect(beacons).toHaveLength(2)
    // the person is back in front, then switches away again, then the board closes while hidden: once for that visit
    f.doc.setVisibility('visible')
    f.doc.setVisibility('hidden')
    expect(beacons).toHaveLength(3)
    cleanup?.()
    expect(beacons).toHaveLength(3)
  })

  it('also says "seen" when the page turns hidden (phones and discarded tabs often fire no pagehide), and not when it turns visible', async () => {
    const f = fakeCtx()
    const cleanup = feature.onMount?.(f.ctx)
    // before the api has taken this open's visit there is nothing to say "seen" about
    f.doc.setVisibility('hidden')
    expect(beacons).toEqual([])
    f.doc.setVisibility('visible')
    markRoomReady(f.canvas)
    await settle()
    expect(f.doc.listeners('visibilitychange')).toBe(1)
    f.doc.setVisibility('hidden')
    expect(beacons).toEqual([`/api/boards/${BOARD}/visit/seen`])
    f.doc.setVisibility('visible')
    expect(beacons).toHaveLength(1)
    f.doc.setVisibility('hidden') // hidden again, after it was in front: another beacon (the api collapses repeats inside 10 s)
    expect(beacons).toHaveLength(2)
    // the chip is untouched by any of it: this is not Mark all seen
    expect(visitsView(f.canvas).get()).toMatchObject({ hidden: false, outlines: true })
    cleanup?.()
    expect(f.doc.listeners('visibilitychange')).toBe(0)
    const after = beacons.length
    f.doc.setVisibility('hidden') // a closed board's page says nothing more
    expect(beacons).toHaveLength(after)
  })

  it('the outlines fade after 15 seconds; the chip stays until Mark all seen', async () => {
    const f = fakeCtx()
    const cleanup = feature.onMount?.(f.ctx)
    markRoomReady(f.canvas)
    await settle()
    expect(visitsView(f.canvas).get()?.outlines).toBe(true)
    await vi.advanceTimersByTimeAsync(VISIT_HIGHLIGHT_FADE_MS - 1)
    expect(visitsView(f.canvas).get()?.outlines).toBe(true)
    await vi.advanceTimersByTimeAsync(2)
    expect(visitsView(f.canvas).get()).toMatchObject({ outlines: false, hidden: false })
    cleanup?.()
  })
})

describe('the chip’s actions', () => {
  async function opened() {
    const f = fakeCtx()
    const cleanup = feature.onMount?.(f.ctx)
    markRoomReady(f.canvas)
    await settle()
    return { ...f, cleanup, actions: actionsOf(f.ctx) }
  }

  it('Next change moves the camera to each added and changed element in turn, and round again', async () => {
    const f = await opened()
    f.actions.next()
    expect(f.zoomed).toHaveLength(1)
    expect(f.zoomed[0]?.bounds).toEqual({ x: 0, y: 0, width: 100, height: 100 }) // the added note
    expect(f.zoomed[0]?.opts).toMatchObject({ animate: true, maxZoom: 1 })
    expect(visitsView(f.canvas).get()?.tour).toBe(0)
    f.actions.next()
    expect(f.zoomed[1]?.bounds).toEqual({ x: 300, y: 0, width: 100, height: 100 }) // the edited one
    f.actions.next()
    expect(f.zoomed[2]?.bounds).toEqual({ x: 0, y: 0, width: 100, height: 100 }) // round again
    expect(visitsView(f.canvas).get()?.tour).toBe(0)
    expect(f.writes).toEqual([]) // the camera only: nothing selected, nothing written
    f.cleanup?.()
  })

  it('Mark all seen sends the beacon, hides the chip and the outlines, and a reload that gets the same visit stays quiet', async () => {
    const f = await opened()
    f.actions.markSeen()
    expect(beacons).toEqual([`/api/boards/${BOARD}/visit/seen`])
    expect(visitsView(f.canvas).get()).toMatchObject({ hidden: true, outlines: false })
    expect(g.sessionStorage && (g.sessionStorage as Storage).getItem(ackKey(BOARD))).toBe(
      String(AFTER + 5_000),
    )
    f.cleanup?.()
    // the page reloads inside the api's write interval: it answers the same visit again
    const again = fakeCtx()
    const cleanup = feature.onMount?.(again.ctx)
    markRoomReady(again.canvas)
    await settle()
    expect(visitsView(again.canvas).get()).toBeNull()
    cleanup?.()
    // a later visit (another stored time) is a new one
    answer = { status: 200, body: { previousSeenAt: AFTER + 5_000, seenAt: AFTER + 90_000 } }
    const later = fakeCtx()
    const c2 = feature.onMount?.(later.ctx)
    markRoomReady(later.canvas)
    await settle()
    expect(visitsView(later.canvas).get()).toBeNull() // nothing changed since that time
    c2?.()
  })

  it('× hides the chip for this page only (the beacon is for pagehide)', async () => {
    const f = await opened()
    f.actions.hide()
    expect(visitsView(f.canvas).get()).toMatchObject({ hidden: true })
    expect(beacons).toEqual([])
    f.cleanup?.()
  })

  it('opens and closes the list of removed items', async () => {
    const f = await opened()
    f.actions.toggleRemoved()
    expect(visitsView(f.canvas).get()?.removedOpen).toBe(true)
    f.actions.toggleRemoved()
    expect(visitsView(f.canvas).get()?.removedOpen).toBe(false)
    f.cleanup?.()
  })
})
