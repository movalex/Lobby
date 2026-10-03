// The board's input stream (canvas/board/input.ts) as features see it:
//  - CR-3D-2: a `key-down` says whether it is Lobby's own (`synthetic`: the lease's Enter and Escape are never
//    trusted events), whether an IME is composing, and a listener can take it with `handled()` (the key then goes
//    no further: not to the key dispatch, not to the engine);
//  - CR-W5-3G-4: a double-tap on an element is offered as the `double-click` it stands for.
// Against a fake root element: no DOM here, so the DOM classes the layer tests with are stubbed as empty ones.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanvasElement, CanvasInputEvent } from '../api/index.ts'

class FakeNode {}
class FakeHTMLElement extends FakeNode {}
class FakeTextArea extends FakeHTMLElement {}

beforeEach(() => {
  vi.stubGlobal('Node', FakeNode)
  vi.stubGlobal('HTMLElement', FakeHTMLElement)
  vi.stubGlobal('HTMLInputElement', class extends FakeHTMLElement {})
  vi.stubGlobal('HTMLTextAreaElement', FakeTextArea)
  vi.stubGlobal('HTMLSelectElement', class extends FakeHTMLElement {})
  vi.stubGlobal('requestAnimationFrame', () => 0)
})
afterEach(() => vi.unstubAllGlobals())

const { BoardInput } = await import('./input.ts')

type Handler = (e: unknown) => void

function setup(hit: CanvasElement | null = null) {
  const handlers = new Map<string, Handler[]>()
  const onKeys: unknown[] = []
  const root = {
    addEventListener: (type: string, fn: Handler) => handlers.set(type, [...(handlers.get(type) ?? []), fn]),
    removeEventListener: () => {},
    ownerDocument: {
      addEventListener: () => {},
      removeEventListener: () => {},
      defaultView: null,
      activeElement: null,
    },
  }
  const seen: CanvasInputEvent[] = []
  let take: ((e: CanvasInputEvent) => boolean) | null = null
  const listener = (e: CanvasInputEvent) => {
    seen.push(e)
    if (take?.(e) && 'handled' in e) e.handled()
  }
  const keySpec = { id: 'k', scope: 'canvas' as const, match: () => true, handle: () => true }
  const input = new BoardInput({
    root: root as never,
    canvasEl: () => null,
    keys: () => [keySpec] as never,
    canvas: () => ({}) as never,
    editor: () => 'none',
    isGrantedEditor: () => false,
    toScene: (x, y) => ({ x, y }),
    hit: () => hit,
    listeners: () => [listener],
    onPointerChange: () => {},
    onHoverChange: () => {},
  })
  const keydown = (over: Record<string, unknown> = {}) => {
    const e = {
      key: 'a',
      code: 'KeyA',
      isTrusted: true,
      isComposing: false,
      shiftKey: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      target: new FakeHTMLElement(),
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      ...over,
    }
    for (const h of handlers.get('keydown') ?? []) h(e)
    return e
  }
  return {
    input,
    seen,
    keydown,
    take: (fn: (e: CanvasInputEvent) => boolean) => {
      take = fn
    },
    onKeys,
  }
}

const keyDowns = (seen: readonly CanvasInputEvent[]) =>
  seen.filter((e): e is Extract<CanvasInputEvent, { type: 'key-down' }> => e.type === 'key-down')

describe('key-down events on the input stream (CR-3D-2)', () => {
  it('say a person’s key is not synthetic, and Lobby’s own (the lease’s untrusted Enter) is', () => {
    const t = setup()
    t.keydown({ key: 'x', code: 'KeyX' })
    t.keydown({ key: 'Enter', code: 'Enter', isTrusted: false })
    const [typed, lease] = keyDowns(t.seen)
    expect(typed).toMatchObject({ key: 'x', code: 'KeyX', synthetic: false, composing: false })
    expect(lease).toMatchObject({ key: 'Enter', synthetic: true })
  })

  it('say an IME is composing, with the modifiers held', () => {
    const t = setup()
    t.keydown({ key: 'Process', isComposing: true, shiftKey: true })
    expect(keyDowns(t.seen)[0]).toMatchObject({ composing: true, shift: true, alt: false })
  })

  it('stop and prevent the key when a listener takes it, and run no key spec on it', () => {
    const t = setup()
    t.take((e) => e.type === 'key-down' && e.key === 'q')
    const taken = t.keydown({ key: 'q' })
    expect(taken.preventDefault).toHaveBeenCalled()
    expect(taken.stopPropagation).toHaveBeenCalled()
    const free = t.keydown({ key: 'w' })
    expect(free.stopPropagation).not.toHaveBeenCalled()
  })

  it('lets every listener see a key before it is taken (an observer after a taker still hears it)', () => {
    const t = setup()
    t.take(() => true)
    t.keydown({ key: 'q' })
    expect(keyDowns(t.seen)).toHaveLength(1)
  })
})

describe('a double-tap on an element (CR-W5-3G-4)', () => {
  const el = { id: 'gif1', type: 'image' } as unknown as CanvasElement

  it('is offered to the features as the double-click it stands for, and says when one took it', () => {
    const t = setup(el)
    let took = false
    t.take((e) => {
      took = e.type === 'double-click'
      return took
    })
    expect(t.input.dispatchDoubleTap({ x: 10, y: 20 }, { x: 110, y: 220 })).toBe(true)
    expect(t.seen[0]).toMatchObject({
      type: 'double-click',
      scene: { x: 10, y: 20 },
      screen: { x: 110, y: 220 },
      hit: el,
      button: 0,
      pointerType: 'touch',
    })
    expect(took).toBe(true)
  })

  it('is not taken when no feature handles it', () => {
    const t = setup(el)
    expect(t.input.dispatchDoubleTap({ x: 0, y: 0 }, { x: 0, y: 0 })).toBe(false)
  })

  it('is never offered for empty canvas, where a double-tap keeps its own meaning', () => {
    const t = setup(null)
    t.take(() => true)
    expect(t.input.dispatchDoubleTap({ x: 0, y: 0 }, { x: 0, y: 0 })).toBe(false)
    expect(t.seen).toEqual([])
  })
})
