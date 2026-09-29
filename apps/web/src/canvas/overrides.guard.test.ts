// Spike B (O5): the hit guard's three gaps from A10 (docs/EXCALIDRAW-MIGRATION.md §2.7) and the board
// page seam, in Node: a fake wrapper (EventTarget) and a fake engine API over real engine elements. The
// browser half is B12 (e2e/spike-b/tests/b12-*.spec.ts).
import { newElement } from '@excalidraw/element'
import type { ExcalidrawElement } from '@excalidraw/element/types'
import type { ElementRenderOverrides } from '@excalidraw/excalidraw/types'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type GuardApi,
  HIT_BLOCKED_CLASS,
  HitGuardCore,
  type HitGuardEvent,
  installBoardOverrides,
  installHitGuard,
  movingMessage,
  onOverrides,
  overridesOf,
  RenderOverrides,
} from './overrides.ts'
import { createRegistries } from './registries.ts'

const rect = (id: string, x: number, y: number, extra: Record<string, unknown> = {}) =>
  ({
    ...newElement({
      type: 'rectangle',
      x,
      y,
      width: 100,
      height: 100,
      backgroundColor: '#ffdf6b',
      fillStyle: 'solid',
      roughness: 0,
    }),
    id,
    ...extra,
  }) as ExcalidrawElement

/** A wrapper that records its class list and dispatches events with a canvas target. */
class FakeWrapper extends EventTarget {
  readonly classes = new Set<string>()
  readonly classList = {
    toggle: (c: string, on?: boolean) => {
      const want = on ?? !this.classes.has(c)
      if (want) this.classes.add(c)
      else this.classes.delete(c)
      return want
    },
    contains: (c: string) => this.classes.has(c),
  }
}
const canvas = { tagName: 'CANVAS', classList: { contains: (c: string) => c === 'interactive' } }
const staticCanvas = { tagName: 'CANVAS', classList: { contains: () => false } }

function fire(target: EventTarget, type: string, props: Record<string, unknown> = {}, on: object = canvas) {
  const ev = new Event(type, { cancelable: true, bubbles: true })
  Object.assign(ev, { button: 0, buttons: 0, isPrimary: true, pointerType: 'mouse', ...props })
  Object.defineProperty(ev, 'target', { value: on })
  // a later listener stands for Excalidraw's own handler: it must not run for a swallowed event
  let reached = false
  const later = () => {
    reached = true
  }
  target.addEventListener(type, later)
  target.dispatchEvent(ev)
  target.removeEventListener(type, later)
  return { ev, reached }
}

function fakeApi(elements: ExcalidrawElement[], tool = 'selection') {
  const updates: unknown[] = []
  const listeners: ((els: readonly ExcalidrawElement[], s: unknown) => void)[] = []
  const submitted: (ElementRenderOverrides | null)[] = []
  const appState = {
    zoom: { value: 1 },
    offsetLeft: 0,
    offsetTop: 0,
    scrollX: 0,
    scrollY: 0,
    frameRendering: { enabled: true, clip: true, name: true, outline: true },
    activeTool: { type: tool },
    selectedElementIds: {} as Record<string, true>,
  }
  const api = {
    getAppState: () => appState,
    getSceneElements: () => elements,
    getSceneElementsIncludingDeleted: () => elements,
    updateScene: (u: { appState?: Record<string, unknown> }) => {
      updates.push(u)
      if (u.appState) Object.assign(appState, u.appState)
      for (const l of listeners) l(elements, appState)
    },
    onChange: (l: (els: readonly ExcalidrawElement[], s: unknown) => void) => {
      listeners.push(l)
      return () => listeners.splice(listeners.indexOf(l), 1)
    },
    setElementRenderOverrides: (o: ElementRenderOverrides | null) => submitted.push(o),
  }
  return { api, updates, appState, submitted }
}

const manual = () => {
  const q: (() => void)[] = []
  return {
    schedule: (f: () => void) => q.push(f),
    run: () => {
      for (const f of q.splice(0)) f()
    },
  }
}

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const c of cleanup.splice(0)) c()
})

function setup(
  elements: ExcalidrawElement[],
  opts: { tool?: string; dragger?: Parameters<typeof installHitGuard>[0]['dragger'] } = {},
) {
  const wrapper = new FakeWrapper()
  const { api, updates, appState } = fakeApi(elements, opts.tool)
  const tick = manual()
  const overrides = new RenderOverrides(
    { setElementRenderOverrides: () => {} },
    { elements: () => elements, schedule: tick.schedule },
  )
  const log: HitGuardEvent[] = []
  const hover = manual()
  const uninstall = installHitGuard({
    wrapper: wrapper as unknown as HTMLElement,
    api: api as unknown as GuardApi,
    overrides,
    onBlocked: (e) => log.push(e),
    dragger: opts.dragger,
    keyTarget: null,
    scheduleHover: hover.schedule,
  })
  cleanup.push(uninstall)
  return { wrapper, api, updates, appState, overrides, log, hover, tick, uninstall }
}

describe('the dead zone (§2.7): a swallowed press selects what the user sees there', () => {
  it('a hidden element over a visible one: the press is swallowed and the visible one is selected', () => {
    // v is below h in z-order; they overlap on [50,100]x[50,100]
    const v = rect('v', 0, 0)
    const h = rect('h', 50, 50)
    const s = setup([v, h])
    s.overrides.setHidden('collapse', ['h'])
    s.tick.run()
    const over = fire(s.wrapper, 'pointerdown', { clientX: 75, clientY: 75 })
    expect(over.reached).toBe(false)
    expect(over.ev.defaultPrevented).toBe(true)
    expect(s.log).toEqual([{ id: 'h', reason: { kind: 'hidden' }, type: 'pointerdown', selected: 'v' }])
    expect(s.appState.selectedElementIds).toEqual({ v: true })
    // Only h there: swallowed, nothing selected, no `selected` key (spike A's A10 log shape).
    s.appState.selectedElementIds = {}
    const alone = fire(s.wrapper, 'pointerdown', { clientX: 140, clientY: 140 })
    expect(alone.reached).toBe(false)
    expect(s.log[1]).toEqual({ id: 'h', reason: { kind: 'hidden' }, type: 'pointerdown' })
    expect(s.appState.selectedElementIds).toEqual({})
    // A visible element on top of a hidden one is Excalidraw's own pick: not blocked at all.
    const s2 = setup([h, rect('top', 50, 50)])
    s2.overrides.setHidden('collapse', ['h'])
    s2.tick.run()
    expect(fire(s2.wrapper, 'pointerdown', { clientX: 75, clientY: 75 }).reached).toBe(true)
    expect(s2.log).toEqual([])
  })

  it("a peer's drag: the old spot's press is swallowed, the note under it is selected, the dragger is named", () => {
    const under = rect('frameish', 0, 0, { width: 300, height: 300 })
    const m = rect('m', 100, 100)
    const s = setup([under, m], { dragger: (id) => (id === 'm' ? { sid: 'bob:1', name: 'Bob' } : null) })
    s.overrides.setDrag('bob:1', new Map([['m', { x: 400, y: 0 }]]))
    s.tick.run()
    const p = fire(s.wrapper, 'pointerdown', { clientX: 150, clientY: 150 })
    expect(p.reached).toBe(false)
    expect(s.log).toEqual([
      { id: 'm', reason: { kind: 'moving', source: 'bob:1' }, type: 'pointerdown', selected: 'frameish' },
    ])
    expect(s.appState.selectedElementIds).toEqual({ frameish: true })
    const core = new HitGuardCore(s.api as unknown as GuardApi, s.overrides, (id) =>
      id === 'm' ? { sid: 'bob:1', name: 'Bob' } : null,
    )
    expect(core.isBlocked({ x: 150, y: 150 })).toEqual({ kind: 'moving', sid: 'bob:1', name: 'Bob' })
    expect(core.isBlocked({ x: 20, y: 20 })).toBeNull()
    expect(movingMessage('Bob')).toBe('Bob is moving this')
    expect(movingMessage(null)).toBe('Someone is moving this')
    // the commit arrives: nothing is blocked any more
    s.overrides.clearDragFor(['m'])
    s.tick.run()
    expect(fire(s.wrapper, 'pointerdown', { clientX: 150, clientY: 150 }).reached).toBe(true)
  })

  it('a grouped visible element selects its outermost group too (selection only)', () => {
    const v = rect('v', 0, 0, { groupIds: ['inner', 'outer'] })
    const h = rect('h', 0, 0)
    const s = setup([v, h])
    s.overrides.setHidden('c', ['h'])
    s.tick.run()
    fire(s.wrapper, 'pointerdown', { clientX: 50, clientY: 50 })
    expect(s.updates).toEqual([
      { appState: { selectedElementIds: { v: true }, selectedGroupIds: { outer: true } } },
    ])
  })
})

describe('the hover cursor (§2.7): default over blocked elements, not move', () => {
  it('toggles the wrapper class over hidden and moving elements, never while a button is held', () => {
    const h = rect('h', 0, 0)
    const m = rect('m', 200, 0)
    const s = setup([h, m, rect('free', 400, 0)])
    // nothing blocked: no hit test, no class
    fire(s.wrapper, 'pointermove', { clientX: 50, clientY: 50 })
    s.hover.run()
    expect(s.wrapper.classes.has(HIT_BLOCKED_CLASS)).toBe(false)
    s.overrides.setHidden('c', ['h'])
    s.overrides.setDrag('bob', new Map([['m', { x: 10, y: 10 }]]))
    s.tick.run()
    fire(s.wrapper, 'pointermove', { clientX: 50, clientY: 50 })
    s.hover.run()
    expect(s.wrapper.classes.has(HIT_BLOCKED_CLASS)).toBe(true)
    fire(s.wrapper, 'pointermove', { clientX: 450, clientY: 50 })
    s.hover.run()
    expect(s.wrapper.classes.has(HIT_BLOCKED_CLASS)).toBe(false)
    fire(s.wrapper, 'pointermove', { clientX: 250, clientY: 50 })
    s.hover.run()
    expect(s.wrapper.classes.has(HIT_BLOCKED_CLASS)).toBe(true)
    // the user's own drag over it: unchanged (no test while a button is held)
    fire(s.wrapper, 'pointermove', { clientX: 450, clientY: 50, buttons: 1 })
    s.hover.run()
    expect(s.wrapper.classes.has(HIT_BLOCKED_CLASS)).toBe(true)
    // leaving the canvas clears it; moves over other targets clear it
    fire(s.wrapper, 'pointerleave', {})
    expect(s.wrapper.classes.has(HIT_BLOCKED_CLASS)).toBe(false)
    fire(s.wrapper, 'pointermove', { clientX: 50, clientY: 50 })
    s.hover.run()
    expect(s.wrapper.classes.has(HIT_BLOCKED_CLASS)).toBe(true)
    fire(s.wrapper, 'pointermove', { clientX: 50, clientY: 50 }, staticCanvas)
    s.hover.run()
    expect(s.wrapper.classes.has(HIT_BLOCKED_CLASS)).toBe(false)
    // the uninstall clears it too
    fire(s.wrapper, 'pointermove', { clientX: 50, clientY: 50 })
    s.hover.run()
    s.uninstall()
    expect(s.wrapper.classes.has(HIT_BLOCKED_CLASS)).toBe(false)
  })

  it('the hand tool never gets the class (panning shows its own cursor)', () => {
    const h = rect('h', 0, 0)
    const s = setup([h], { tool: 'hand' })
    s.overrides.setHidden('c', ['h'])
    s.tick.run()
    fire(s.wrapper, 'pointermove', { clientX: 50, clientY: 50 })
    s.hover.run()
    expect(s.wrapper.classes.has(HIT_BLOCKED_CLASS)).toBe(false)
  })
})

describe('touch (§2.7): taps, double-taps and long-presses on a hidden element do nothing', () => {
  it('swallows touch and pen pointerdowns, one-finger touchstarts and the long-press menu', () => {
    const h = rect('h', 0, 0)
    const s = setup([h])
    s.overrides.setHidden('c', ['h'])
    s.tick.run()
    const at = { clientX: 50, clientY: 50 }
    expect(fire(s.wrapper, 'pointerdown', { ...at, pointerType: 'touch' }).reached).toBe(false)
    expect(fire(s.wrapper, 'pointerdown', { ...at, pointerType: 'pen' }).reached).toBe(false)
    const touch = fire(s.wrapper, 'touchstart', { touches: [at] })
    expect(touch.reached).toBe(false)
    expect(touch.ev.defaultPrevented).toBe(true) // no compatibility mouse events
    expect(fire(s.wrapper, 'contextmenu', at).reached).toBe(false)
    expect(fire(s.wrapper, 'dblclick', at).reached).toBe(false)
    // two fingers: a pinch, not a tap: let it through
    expect(fire(s.wrapper, 'touchstart', { touches: [at, { clientX: 60, clientY: 60 }] }).reached).toBe(true)
    expect(s.log.map((e) => e.type)).toEqual([
      'pointerdown',
      'pointerdown',
      'touchstart',
      'contextmenu',
      'dblclick',
    ])
    expect(s.appState.selectedElementIds).toEqual({})
    // a secondary touch pointer never selects through the dead zone
    const v = rect('v', 0, 0)
    const s2 = setup([v, rect('h2', 0, 0)])
    s2.overrides.setHidden('c', ['h2'])
    s2.tick.run()
    fire(s2.wrapper, 'pointerdown', { ...at, pointerType: 'touch', isPrimary: false })
    expect(s2.appState.selectedElementIds).toEqual({})
  })
})

describe('the board page seam', () => {
  it('provides isBlocked and isHidden, names the dragger, hands the overrides to features, and undoes it all', () => {
    const v = rect('v', 0, 0)
    const h = rect('h', 0, 0)
    const m = rect('m', 300, 0)
    const { api, submitted } = fakeApi([v, h, m])
    const registries = createRegistries()
    const unDragger = registries.dragger.provide((id) => (id === 'm' ? { sid: 'bob:1', name: 'Bob' } : null))
    const got: RenderOverrides[] = []
    // a feature installed before the engine is ready waits for the overrides
    onOverrides(registries, (o) => got.push(o))
    expect(overridesOf(registries)).toBeNull()
    const toasts: string[] = []
    const wrapper = new FakeWrapper()
    const board = installBoardOverrides({
      api: api as never,
      wrapper: wrapper as unknown as HTMLElement,
      registries,
      toast: (m) => toasts.push(m),
    })
    expect(got).toEqual([board.overrides])
    expect(overridesOf(registries)).toBe(board.overrides)
    board.overrides.setHidden('mindmap', ['h'])
    board.overrides.setDrag('bob:1', new Map([['m', { x: 50, y: 0 }]]))
    board.overrides.flush()
    expect(submitted.at(-1)?.get('h')).toEqual({ opacity: 0 })
    expect(registries.hidden.isHidden('h')).toBe(true)
    expect(registries.hidden.isHidden('v')).toBe(false)
    expect(registries.hitGuard.isBlocked({ x: 50, y: 50 })).toEqual({ kind: 'hidden' })
    expect(registries.hitGuard.isBlocked({ x: 350, y: 50 })).toEqual({
      kind: 'moving',
      sid: 'bob:1',
      name: 'Bob',
    })
    fire(wrapper, 'pointerdown', { clientX: 350, clientY: 50 })
    expect(toasts).toEqual(['Bob is moving this'])
    fire(wrapper, 'pointerdown', { clientX: 50, clientY: 50 }) // hidden: no toast
    expect(toasts).toHaveLength(1)
    expect(board.log.map((e) => [e.type, e.id, e.reason.kind])).toEqual([
      ['pointerdown', 'm', 'moving'],
      ['pointerdown', 'h', 'hidden'],
    ])
    board.dispose()
    expect(registries.hidden.isHidden('h')).toBe(false)
    expect(registries.hitGuard.isBlocked({ x: 50, y: 50 })).toBeNull()
    expect(overridesOf(registries)).toBeNull()
    expect(submitted.at(-1)).toBeNull()
    expect(fire(wrapper, 'pointerdown', { clientX: 50, clientY: 50 }).reached).toBe(true)
    unDragger()
  })
})
