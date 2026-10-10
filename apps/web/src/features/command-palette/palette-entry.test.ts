// W3 (wave M, M3-1, M3-3): the palette's on-screen entry and the "Try it" hint, without a browser. How an opening is
// counted (key, button, phone), what a chosen command line counts, and `?try=<hint>` read once on mount: taken out of
// the address bar, the coach shown when the thing is ready, the fallback when it is not, an unknown value ignored.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLobbyCanvas } from '../../canvas/api/impl.ts'
import {
  type CanvasFeatureContext,
  type CommandSpec,
  createFeatureRegistries,
  type LobbyCanvas,
  markRoomReady,
} from '../../canvas/api/index.ts'
import type { CanvasPort } from '../../canvas/port.ts'
import { pendingUsage, resetUsageForTests } from '../../lib/usage.ts'
import { CANVAS_FEATURES } from '../canvas-registry.ts'
import {
  openedVia,
  openPalette,
  paletteArgs,
  feature as paletteFeature,
  paletteState,
  resetTryHintForTests,
  runChosen,
  startTryHint,
  TRY_WAIT_MS,
} from './index.tsx'
import { coachBubble } from './TryCoach.tsx'
import { TRY_COACH, TRY_COACH_FALLBACK, TRY_HINTS, withoutTryParam } from './try-hints.ts'

function fakePort(): CanvasPort {
  const noop = () => {}
  return {
    items: () => [],
    get: () => undefined,
    bounds: () => null,
    selection: [],
    select: noop,
    viewport: { get: () => ({ x: 0, y: 0, width: 100, height: 100, zoom: 1 }), set: noop, fit: noop },
    sceneToScreen: (p) => p,
    screenToScene: (p) => p,
    transact: (_label, fn) => fn({ create: () => 'new', update: noop, delete: noop }),
    setTool: () => true,
    tool: () => 'select',
    on: () => noop,
    editingId: () => null,
    leaseHolder: () => null,
    collaborators: () => [],
    saveStatus: () => ({ state: 'saved', pending: 0, offlineChanges: 0, lastReject: null }),
    engine: null,
  }
}

function boardCtx(extra: readonly CommandSpec[] = [], panels: string[] = []): CanvasFeatureContext {
  const registries = createFeatureRegistries()
  for (const f of CANVAS_FEATURES) {
    for (const c of f.commands ?? []) registries.commands.register(c)
    for (const t of f.tools ?? []) registries.tools.register(t)
  }
  for (const c of extra) registries.commands.register(c)
  for (const id of panels)
    registries.panels.register({ id, label: id, icon: () => null, order: 1, component: () => null } as never)
  const { canvas } = createLobbyCanvas({ port: fakePort(), registries })
  return {
    canvas: { ...canvas, readOnly: () => false } as LobbyCanvas,
    registries,
    board: { id: 'brd_test', status: 'active' } as CanvasFeatureContext['board'],
    role: 'editor',
    me: { user: { id: 'usr_test' } } as CanvasFeatureContext['me'],
    workspace: { id: 'wsp_test', name: 'Test' },
    api: {} as CanvasFeatureContext['api'],
    events: {} as CanvasFeatureContext['events'],
    notify: () => {},
    dismiss: () => {},
    openPanel: vi.fn(),
    activePanel: null,
  }
}

const askOn: CommandSpec = {
  id: 'ai.ask',
  label: 'Ask this board',
  enabled: () => true,
  readOnlyAllowed: true,
  run: () => {},
}

beforeEach(() => {
  resetUsageForTests()
})

describe('how an opening is counted (palette.open:<key|button|phone>)', () => {
  it('reads the args of the command, and the key from the registry’s own source', () => {
    expect(paletteArgs({ via: 'button' })).toEqual({ via: 'button' })
    expect(paletteArgs({ via: 'phone' })).toEqual({ via: 'phone' })
    expect(paletteArgs({ via: 'key' })).toEqual({})
    expect(paletteArgs({ via: 'nope' })).toEqual({})
    expect(paletteArgs(null)).toEqual({})
    expect(paletteArgs('button')).toEqual({})
    expect(openedVia('kbd', undefined)).toBe('key')
    expect(openedVia('toolbar', { via: 'button' })).toBe('button')
    expect(openedVia('dock', { via: 'phone' })).toBe('phone')
    // anything else (the dev hook, a menu) is no one of the three: not counted
    expect(openedVia('menu', undefined)).toBeNull()
  })

  it('the command counts a key, a button and a phone opening, and opens an empty palette each time', () => {
    const ctx = boardCtx()
    const run = (
      source: Parameters<NonNullable<typeof paletteFeature.commands>[number]['run']>[1],
      args?: unknown,
    ) => void paletteFeature.commands?.[0]?.run(ctx, source, args)
    run('kbd')
    run('toolbar', { via: 'button' })
    run('toolbar', { via: 'button' })
    run('dock', { via: 'phone' })
    run('menu')
    expect(pendingUsage()).toEqual({
      'palette.open:key': 1,
      'palette.open:button': 2,
      'palette.open:phone': 1,
    })
    expect(paletteState(ctx.canvas).get()).toMatchObject({ query: '' })
    expect(paletteState(ctx.canvas).get()?.coach).toBeUndefined()
  })

  it('a chosen command line counts palette.run:<id> (only from the contract’s list); a frame or a tool counts nothing', () => {
    const ctx = boardCtx()
    const line = (id: string) => ({ id, label: id, group: 'x', run: () => {} })
    runChosen(ctx, line('cmd:canvas-ux.toggle-lock'))
    runChosen(ctx, line('cmd:canvas-ux.toggle-lock'))
    runChosen(ctx, line('cmd:some.unknown-command'))
    runChosen(ctx, line('frame:abc'))
    runChosen(ctx, line('tool:note'))
    expect(pendingUsage()).toEqual({ 'palette.run:canvas-ux.toggle-lock': 2 })
  })

  it('opening with a line to coach keeps it in the open state', () => {
    const ctx = boardCtx()
    openPalette(ctx, '', { coach: { entryId: 'cmd:ai.ask', text: 'Ask' } })
    expect(paletteState(ctx.canvas).get()?.coach).toEqual({ entryId: 'cmd:ai.ask', text: 'Ask' })
    openPalette(ctx)
    expect(paletteState(ctx.canvas).get()?.coach).toBeUndefined()
  })
})

describe('?try=<hint> on mount (M3-3)', () => {
  const replaceState = vi.fn()
  const setLocation = (search: string) =>
    vi.stubGlobal('window', {
      location: { search, pathname: '/b/brd_test', href: `http://lobby.test/b/brd_test${search}#top` },
      history: { state: { n: 1 }, replaceState },
    })

  beforeEach(() => {
    vi.useFakeTimers()
    replaceState.mockClear()
    resetTryHintForTests()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('takes the hint out of the address bar at once, keeping the path, the other parameters and the hash', () => {
    setLocation('?try=ask&el=abc')
    const ctx = boardCtx([askOn])
    const off = startTryHint(ctx)
    expect(replaceState).toHaveBeenCalledTimes(1)
    expect(replaceState).toHaveBeenCalledWith({ n: 1 }, '', '/b/brd_test?el=abc#top')
    off()
    expect(withoutTryParam('/b/x?try=ask')).toBe('/b/x')
    expect(withoutTryParam('/b/x?a=1')).toBe('/b/x?a=1')
  })

  it('survives the development server’s remount (StrictMode runs the effect, its cleanup and the effect again)', () => {
    setLocation('?try=palette')
    const ctx = boardCtx()
    markRoomReady(ctx.canvas)
    const first = startTryHint(ctx)
    first()
    // the second run finds the address without the parameter, and still shows the coach once
    setLocation('')
    const second = startTryHint(ctx)
    vi.advanceTimersByTime(600)
    expect(coachBubble(ctx.canvas).get()?.text).toBe(TRY_COACH.palette.text)
    // once it was shown, a later mount at the same path does not show it again
    coachBubble(ctx.canvas).set(null)
    second()
    const third = startTryHint(ctx)
    vi.advanceTimersByTime(TRY_WAIT_MS * 2)
    expect(coachBubble(ctx.canvas).get()).toBeNull()
    third()
    // and one that was not carried for long is forgotten
    setLocation('?try=palette')
    startTryHint(ctx)()
    vi.advanceTimersByTime(4000)
    setLocation('')
    const late = startTryHint(ctx)
    vi.advanceTimersByTime(TRY_WAIT_MS * 2)
    expect(coachBubble(ctx.canvas).get()).toBeNull()
    late()
  })

  it('an unknown value, or none, is ignored: nothing shown, the address untouched', () => {
    for (const search of ['?try=nope', '?try=', '?try=ASK', '', '?x=1']) {
      setLocation(search)
      const ctx = boardCtx([askOn])
      markRoomReady(ctx.canvas)
      const off = startTryHint(ctx)
      vi.advanceTimersByTime(TRY_WAIT_MS * 5)
      off()
      expect(paletteState(ctx.canvas).get(), search).toBeNull()
      expect(coachBubble(ctx.canvas).get(), search).toBeNull()
    }
    expect(replaceState).not.toHaveBeenCalled()
  })

  it('waits for the room, then opens the palette with the Ask line marked', () => {
    setLocation('?try=ask')
    const ctx = boardCtx([askOn])
    const off = startTryHint(ctx)
    vi.advanceTimersByTime(3000)
    // the board has not come up: nothing yet
    expect(paletteState(ctx.canvas).get()).toBeNull()
    markRoomReady(ctx.canvas)
    vi.advanceTimersByTime(500)
    expect(paletteState(ctx.canvas).get()?.coach).toEqual({ entryId: 'cmd:ai.ask', text: TRY_COACH.ask.text })
    // once: it does not open again
    paletteState(ctx.canvas).set(null)
    vi.advanceTimersByTime(TRY_WAIT_MS * 2)
    expect(paletteState(ctx.canvas).get()).toBeNull()
    off()
  })

  it('when the thing is not there for this person (AI off) it settles for a bubble about the palette itself', () => {
    setLocation('?try=ask')
    const ctx = boardCtx()
    markRoomReady(ctx.canvas)
    const off = startTryHint(ctx)
    vi.advanceTimersByTime(TRY_WAIT_MS - 500)
    expect(coachBubble(ctx.canvas).get()).toBeNull()
    vi.advanceTimersByTime(1500)
    expect(paletteState(ctx.canvas).get()).toBeNull()
    expect(coachBubble(ctx.canvas).get()).toMatchObject({
      text: TRY_COACH_FALLBACK,
      anchors: TRY_COACH.ask.anchors,
    })
    off()
  })

  it('the palette hint is a bubble under the top-bar button, or the phone sheet’s button', () => {
    setLocation('?try=palette')
    const ctx = boardCtx()
    markRoomReady(ctx.canvas)
    const off = startTryHint(ctx)
    vi.advanceTimersByTime(600)
    expect(coachBubble(ctx.canvas).get()).toMatchObject({
      text: TRY_COACH.palette.text,
      anchors: ['topbar-palette', 'phone-sheet-open'],
    })
    off()
  })

  it('the run of show opens the Frames panel (for an editor who has it) and points at Facilitate', () => {
    setLocation('?try=run-of-show')
    const ctx = boardCtx([], ['frames'])
    markRoomReady(ctx.canvas)
    const off = startTryHint(ctx)
    vi.advanceTimersByTime(600)
    expect(ctx.openPanel).toHaveBeenCalledWith('frames')
    expect(coachBubble(ctx.canvas).get()?.anchors[0]).toBe('facilitate-button')
    off()
  })

  it('every hint of the contract has a coach; the ones with a line name an id the index has', () => {
    for (const hint of TRY_HINTS) {
      const copy = TRY_COACH[hint]
      expect(copy.text.length, hint).toBeGreaterThan(20)
      expect(copy.anchors.length, hint).toBeGreaterThan(0)
      if (copy.entry) expect(copy.entry, hint).toMatch(/^(cmd|panel):/)
    }
  })
})
