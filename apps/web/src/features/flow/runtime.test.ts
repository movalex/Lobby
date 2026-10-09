// L4-1: the flow keys through the key registry (installCanvasFeatures, so the wave L claims are matched as the
// board matches them, with a11y's frame keys registered after them as on the board), the contextual
// Ctrl/Cmd+Shift+Arrow (only while the flow is being built: it ends on a selection change, a canvas press or
// FLOW_IDLE_MS, and the chord is a11y's again), and the new shape's editor: words typed before the lease grant end
// up in it, and an Escape before the grant still keeps them.
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  type CanvasFeature,
  type CanvasFeatureContext,
  createFeatureRegistries,
  installCanvasFeatures,
  type KeyEventLike,
} from '../../canvas/api/index.ts'
import { feature as a11yFeature } from '../a11y/ported/index.tsx'
import { takeWalkKey } from '../a11y/ported/traversal.ts'
import { FLOW_KEYS } from './keys.ts'
import { FLOW_IDLE_MS, flowRuntimeOf, mountFlow, wordsAfter } from './runtime.ts'
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
  // a11y's commands (its frame keys mod+Shift+Down / Up among them), after flow as in features/canvas-registry.ts
  const a11y: CanvasFeature = { id: 'a11y', commands: a11yFeature.commands }
  const off = installCanvasFeatures([feature, a11y], ctx)
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
    // Alt+Arrow is a11y's walk (a selection change only)
    expect(press('ArrowRight', { altKey: true })).toBe('command:a11y.next:canvas')
    f.canvas.select(['src'])
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
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const DIA: Partial<El> = { id: 'dia', type: 'diamond', x: 0, y: 600, width: 160, height: 110 }
  /** Ctrl+Right from the diamond (the flow's last kind is a diamond), no words typed; returns the made shape. */
  async function stepFromDiamond(s: ReturnType<typeof setup>): Promise<string> {
    s.f.canvas.select(['dia'])
    expect(s.press('ArrowRight', { ctrlKey: true })).toBe('key:flow.next')
    s.f.grant(false)
    await tick()
    return s.f.selected[0] as string
  }

  it('declines before any flow step, then makes the kind the flow last made, from the shape it made', async () => {
    const s = setup([RECT, DIA])
    const { f, press } = s
    f.canvas.select(['src'])
    // a11y's 'into the frame' (nothing to go into: the key is taken, nothing is made)
    expect(press('ArrowDown', { ctrlKey: true, shiftKey: true })).toBe('command:a11y.into-frame:canvas')
    const made = await stepFromDiamond(s)
    expect(f.els.get(made)?.type).toBe('diamond')
    // the new diamond is still the selection: a branch below it, a diamond again
    expect(press('ArrowDown', { ctrlKey: true, shiftKey: true })).toBe('key:flow.repeat')
    const branch = f.selected[0] as string
    expect(branch).not.toBe(made)
    expect(f.els.get(branch)?.type).toBe('diamond')
    // and on from the branch
    f.grant(false)
    await tick()
    expect(flowRuntimeOf(f.canvas)?.repeatSource()).toBe(branch)
  })

  it('the shape the flow built from is not the flow: the chord stays a11y’s there', async () => {
    const s = setup([RECT, DIA])
    await stepFromDiamond(s)
    s.f.canvas.select(['dia'])
    expect(s.press('ArrowDown', { ctrlKey: true, shiftKey: true })).toBe('command:a11y.into-frame:canvas')
    expect(s.f.live().filter((e) => e.type === 'diamond')).toHaveLength(2)
  })

  it('selecting anything else ends the flow: back on the shape it made, the chord is a11y’s', async () => {
    const s = setup([RECT, DIA])
    const { f, press } = s
    const made = await stepFromDiamond(s)
    f.canvas.select(['src'])
    f.canvas.select([made])
    expect(flowRuntimeOf(f.canvas)?.repeatSource()).toBeNull()
    expect(flowRuntimeOf(f.canvas)?.lastKind).toBeNull()
    expect(press('ArrowDown', { ctrlKey: true, shiftKey: true })).toBe('command:a11y.into-frame:canvas')
    expect(f.live().filter((e) => e.type === 'diamond')).toHaveLength(2)
  })

  it('so do several selected and a press on the canvas; an empty selection (the editor opening) does not', async () => {
    const s = setup([RECT, DIA])
    const { f } = s
    const rt = () => flowRuntimeOf(f.canvas)
    let made = await stepFromDiamond(s)
    f.canvas.select([made, 'src'])
    f.canvas.select([made])
    expect(rt()?.repeatSource()).toBeNull()
    made = await stepFromDiamond(s)
    expect(rt()?.repeatSource()).toBe(made)
    f.pointerDown()
    expect(rt()?.repeatSource()).toBeNull()
    // the engine deselects while the new shape's editor opens, and selects it again as the editor closes
    f.canvas.select(['dia'])
    expect(s.press('ArrowRight', { ctrlKey: true })).toBe('key:flow.next')
    made = f.selected[0] as string
    f.canvas.select([])
    f.grant(true)
    await tick()
    f.canvas.text.stop()
    f.canvas.select([made])
    expect(rt()?.repeatSource()).toBe(made)
    // a selected label stands for its shape
    f.els.set('lbl', { id: 'lbl', type: 'text', x: 0, y: 0, width: 1, height: 1, containerId: made } as El)
    f.canvas.select(['lbl'])
    expect(rt()?.repeatSource()).toBe(made)
  })

  it(`ends FLOW_IDLE_MS (${FLOW_IDLE_MS} ms) after the last step; the editor opening or closing is a step`, async () => {
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const s = setup([RECT, DIA])
    const { f } = s
    const made = await stepFromDiamond(s)
    now += FLOW_IDLE_MS - 1
    expect(flowRuntimeOf(f.canvas)?.repeatSource()).toBe(made)
    // typing the words for a while: the editor closing is a step
    f.setEditing(made)
    now += FLOW_IDLE_MS - 1
    f.setEditing(null)
    now += FLOW_IDLE_MS - 1
    expect(flowRuntimeOf(f.canvas)?.repeatSource()).toBe(made)
    now += 2
    expect(flowRuntimeOf(f.canvas)?.repeatSource()).toBeNull()
    expect(s.press('ArrowDown', { ctrlKey: true, shiftKey: true })).toBe('command:a11y.into-frame:canvas')
  })

  it('a flow-made shape inside a frame, selected again later: Ctrl+Shift+Up is a11y’s, out to the frame', async () => {
    const s = setup([
      { id: 'fr', type: 'frame', x: -100, y: -100, width: 900, height: 500 },
      { ...RECT, frameId: 'fr' },
      { id: 'other', type: 'rectangle', x: 0, y: 250, width: 100, height: 60, frameId: 'fr' },
    ])
    const { f, press } = s
    f.canvas.select(['src'])
    expect(press('ArrowRight', { ctrlKey: true })).toBe('key:flow.next')
    const made = f.selected[0] as string
    expect(f.els.get(made)?.frameId).toBe('fr')
    f.grant(false)
    await tick()
    const count = f.live().length
    // something else, then back to the shape the flow made
    f.canvas.select(['other'])
    f.canvas.select([made])
    expect(press('ArrowUp', { ctrlKey: true, shiftKey: true })).toBe('command:a11y.out-of-frame:canvas')
    expect(f.selected).toEqual(['fr'])
    expect(f.live()).toHaveLength(count)
    expect(f.edits).toHaveLength(1)
  })

  it('never while the comment tool is on (its level keys)', async () => {
    const { f, press } = setup()
    f.canvas.select(['src'])
    press('ArrowRight', { ctrlKey: true })
    const made = f.selected[0] as string
    f.grant(false)
    await tick()
    expect(flowRuntimeOf(f.canvas)?.repeatSource()).toBe(made)
    f.setTool('comment')
    expect(press('ArrowDown', { ctrlKey: true, shiftKey: true })).not.toBe('key:flow.repeat')
    expect(f.live().filter((e) => e.type === 'rectangle')).toHaveLength(2)
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
