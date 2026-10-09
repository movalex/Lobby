// L4-1: the flow keys through the key registry (installCanvasFeatures, so the wave L claims are matched as the
// board matches them), the contextual Ctrl/Cmd+Shift+Arrow, and the new shape's editor: words typed before the
// lease grant end up in it, and an Escape before the grant still keeps them.
import { describe, expect, it } from 'vitest'
import {
  type CanvasFeature,
  type CanvasFeatureContext,
  createFeatureRegistries,
  installCanvasFeatures,
  type KeyEventLike,
} from '../../canvas/api/index.ts'
import { takeWalkKey } from '../a11y/ported/traversal.ts'
import { FLOW_KEYS } from './keys.ts'
import { flowRuntimeOf, mountFlow, wordsAfter } from './runtime.ts'
import { type El, fakeFlowCanvas } from './test-canvas.ts'

const RECT: Partial<El> = {
  id: 'src',
  type: 'rectangle',
  x: 0,
  y: 0,
  width: 200,
  height: 100,
  strokeColor: '#1e1e1e',
}

function setup(seed: Partial<El>[] = [RECT]) {
  const f = fakeFlowCanvas(seed)
  const registries = createFeatureRegistries()
  const ctx = { canvas: f.canvas, registries } as unknown as CanvasFeatureContext
  const feature: CanvasFeature = { id: 'flow', keys: FLOW_KEYS, onMount: (c) => mountFlow(c) }
  const off = installCanvasFeatures([feature], ctx)
  /** The board's key dispatch: the first registered key that matches and handles it. */
  const press = (key: string, mods: Partial<KeyEventLike> = {}) => {
    const e: KeyEventLike = {
      key,
      code: key,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      ...mods,
    }
    for (const k of registries.keys.list())
      if (k.scope === 'canvas' && k.match(e) && k.handle(e, f.canvas)) return k.id
    return null
  }
  return { f, ctx, press, off }
}

const tick = async () => {
  for (let i = 0; i < 3; i++) await Promise.resolve()
}
const arrows = (f: ReturnType<typeof fakeFlowCanvas>) => f.live().filter((e) => e.type === 'arrow')

describe('Ctrl/Cmd+Arrow: the next connected shape', () => {
  it('on the one selected shape: creates it and its connector (one step), selects it, opens its editor', () => {
    const { f, press } = setup()
    f.canvas.select(['src'])
    expect(press('ArrowRight', { ctrlKey: true })).toBe('key:flow.next')
    const made = f.selected[0] as string
    expect(f.els.get(made)).toMatchObject({ type: 'rectangle', x: 300, y: 0 })
    expect(arrows(f)).toHaveLength(1)
    expect(f.steps()).toBe(1)
    expect(f.edits).toEqual([{ id: made, via: 'api' }])
  })

  it('does nothing (the key falls through to the allowlist) with nothing, several or a locked shape selected, read-only, or mid-gesture', () => {
    const { f, press } = setup([
      RECT,
      { ...RECT, id: 'locked', x: 900, locked: true },
      { ...RECT, id: 'b', x: 1800 },
    ])
    const none = () => expect(press('ArrowRight', { ctrlKey: true })).toBeNull()
    none()
    f.canvas.select(['src', 'b'])
    none()
    f.canvas.select(['locked'])
    none()
    f.canvas.select(['src'])
    f.setReadOnly(true)
    none()
    f.setReadOnly(false)
    f.setGesture('dragging')
    none()
    f.setGesture('idle')
    f.setEditing('src')
    none()
    expect(f.live()).toHaveLength(3)
  })

  it('the claim keeps the other modifiers and AltGr out', () => {
    const { f, press } = setup()
    f.canvas.select(['src'])
    expect(press('ArrowRight', { ctrlKey: true, altKey: true })).toBeNull()
    expect(press('ArrowRight', { altKey: true })).toBeNull()
    expect(press('ArrowRight')).toBeNull()
    expect(
      press('ArrowRight', {
        ctrlKey: true,
        getModifierState: (k: string) => k === 'AltGraph',
      } as Partial<KeyEventLike>),
    ).toBeNull()
    expect(f.live()).toHaveLength(1)
  })
})

describe('Ctrl/Cmd+Shift+Arrow: the last created kind, only while a flow is being built', () => {
  it('declines before any flow step, then makes the kind the flow last made', async () => {
    const { f, press } = setup([RECT, { id: 'dia', type: 'diamond', x: 0, y: 600, width: 160, height: 110 }])
    f.canvas.select(['src'])
    expect(press('ArrowDown', { ctrlKey: true, shiftKey: true })).toBeNull()
    // a step from the diamond: the last created kind is a diamond
    f.canvas.select(['dia'])
    expect(press('ArrowRight', { ctrlKey: true })).toBe('key:flow.next')
    f.grant(false)
    await tick()
    // the rectangle is not in the flow yet: Ctrl+Shift+Arrow is a11y's (into a frame) there
    f.canvas.select(['src'])
    expect(press('ArrowDown', { ctrlKey: true, shiftKey: true })).toBeNull()
    // the diamond is: a branch below it, a diamond again
    f.canvas.select(['dia'])
    expect(press('ArrowDown', { ctrlKey: true, shiftKey: true })).toBe('key:flow.repeat')
    expect(f.els.get(f.selected[0] as string)?.type).toBe('diamond')
  })

  it('never while the comment tool is on (its level keys)', async () => {
    const { f, press } = setup()
    f.canvas.select(['src'])
    press('ArrowRight', { ctrlKey: true })
    f.grant(false)
    await tick()
    f.canvas.select(['src'])
    expect(flowRuntimeOf(f.canvas)?.repeatSource()).toBe('src')
    f.setTool('comment')
    expect(press('ArrowDown', { ctrlKey: true, shiftKey: true })).toBeNull()
  })
})

describe("the new shape's editor: no key lost", () => {
  it('the words typed before the grant are in the editor when it opens', async () => {
    const { f, press } = setup()
    f.canvas.select(['src'])
    press('ArrowRight', { ctrlKey: true })
    for (const ch of 'Reviex') f.key(ch)
    f.key('Backspace')
    f.key('w')
    // the lease's own synthetic Enter is not the person's
    f.key('Enter', { synthetic: true })
    expect(flowRuntimeOf(f.canvas)?.waiting).toBe(true)
    f.grant(true)
    await Promise.resolve()
    await Promise.resolve()
    expect(f.textarea?.value).toBe('Review')
    expect(f.textarea?.inputs).toBe(1)
    expect(f.stops).toBe(0)
    expect(flowRuntimeOf(f.canvas)?.waiting).toBe(false)
  })

  it('an Escape before the grant: the words become the new shape’s label, without an editor', async () => {
    const { f, press } = setup()
    f.canvas.select(['src'])
    press('ArrowDown', { ctrlKey: true })
    const made = f.selected[0] as string
    for (const ch of 'Review') f.key(ch)
    f.key('Escape')
    f.grant(false)
    for (let i = 0; i < 5; i++) await Promise.resolve()
    const label = f.live().find((e) => e.type === 'text' && e.containerId === made)
    expect(label).toMatchObject({ text: 'Review', originalText: 'Review', textAlign: 'center' })
    expect(f.els.get(made)?.boundElements).toContainEqual({ id: label?.id, type: 'text' })
    expect(f.transacts.at(-1)?.label).toBe('flow: words')
  })

  it('an Escape typed after the words, with the editor granted, closes it', async () => {
    const { f, press } = setup()
    f.canvas.select(['src'])
    press('ArrowRight', { ctrlKey: true })
    f.key('A')
    f.key('Escape')
    f.grant(true)
    await Promise.resolve()
    await Promise.resolve()
    expect(f.textarea?.value).toBe('A')
    expect(f.stops).toBe(1)
  })

  it('wordsAfter: printable keys, Enter, Backspace and Escape; other chords mean nothing', () => {
    const k = (
      key: string,
      m: Partial<{ shift: boolean; ctrl: boolean; meta: boolean; alt: boolean }> = {},
    ) => ({
      key,
      shift: false,
      ctrl: false,
      meta: false,
      alt: false,
      ...m,
    })
    expect(wordsAfter('a', k('b'))).toEqual({ words: 'ab' })
    expect(wordsAfter('ab', k('Backspace'))).toEqual({ words: 'a' })
    expect(wordsAfter('a', k('Enter'))).toEqual({ words: 'a\n' })
    expect(wordsAfter('a', k('Escape'))).toEqual({ words: 'a', escape: true })
    expect(wordsAfter('a', k('c', { ctrl: true }))).toBeNull()
    expect(wordsAfter('a', k('Shift'))).toBeNull()
    // AltGr (Ctrl+Alt on Windows) types
    expect(wordsAfter('a', k('@', { ctrl: true, alt: true }))).toEqual({ words: 'a@' })
  })
})

describe('Alt+Arrow is told to the walk', () => {
  it('an Alt+Arrow key-down is noted for the traversal; a synthetic one or another chord is not', () => {
    const { f } = setup()
    f.key('ArrowRight', { alt: true })
    expect(takeWalkKey(f.canvas)).toBe('ArrowRight')
    f.key('ArrowRight', { alt: true, synthetic: true })
    f.key('ArrowLeft', { alt: true, shift: true })
    expect(takeWalkKey(f.canvas)).toBeNull()
  })
})
