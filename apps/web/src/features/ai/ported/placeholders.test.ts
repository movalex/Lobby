// K7-4: the wait made deliberate. A component test of the placeholder and the highlight (./Placeholders.tsx):
// during a run a shimmer shows where results will land, then the new elements are briefly highlighted, overlay
// only (the views draw from pixel boxes; nothing here can write to the board) and off under reduced motion.
// Plus the geometry (./shimmer.ts) and where each action's result will land (./landing.ts, ./apply.ts).
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { setMindmap } from '../../mindmap/ported/bridge.ts'
import type { Mindmap } from '../../mindmap/ported/commands.ts'
import { MindmapRuntime } from '../../mindmap/ported/runtime.ts'
import { type El, fakeMapCanvas, lobbyOf, measure } from '../../mindmap/test-canvas.ts'
import { landingFor } from './landing.ts'
import { FlashView, ShimmerView } from './Placeholders.tsx'
import {
  mapTiles,
  noteColumns,
  noteTiles,
  onScreen,
  pillTiles,
  regionTile,
  SHIMMER_MAX_TILES,
  toPixels,
} from './shimmer.ts'
import { NONE } from './target.ts'

const tile = (x: number, y: number, w = 100, h = 60, shape: 'note' | 'pill' | 'hub' | 'region' = 'note') => ({
  x,
  y,
  w,
  h,
  shape,
})

describe('the shimmer placeholder', () => {
  it('shows a block where each result will land, and moves with the shimmer unless motion is reduced', () => {
    const html = renderToStaticMarkup(
      createElement(ShimmerView, {
        tiles: [tile(10, 20), tile(130, 20, 100, 60, 'pill')],
        action: 'ideas',
        still: false,
      }),
    )
    expect(html).toContain('data-testid="ai-shimmer"')
    expect(html).toContain('data-action="ideas"')
    expect(html).toContain('data-motion="shimmer"')
    expect(html.match(/dr-ai-shimmer__tile /g)).toHaveLength(2)
    expect(html).toContain('dr-ai-shimmer__tile--pill')
    expect(html).toContain('left:10px;top:20px;width:100px;height:60px')
    // decoration: a screen reader hears the busy pill, not the placeholder
    expect(html).toContain('aria-hidden="true"')
  })

  it('stands still under reduced motion', () => {
    const html = renderToStaticMarkup(
      createElement(ShimmerView, { tiles: [tile(0, 0)], action: 'ideas', still: true }),
    )
    expect(html).toContain('data-motion="still"')
  })

  it('draws nothing when there is nowhere to point (a summary lands in its panel)', () => {
    expect(
      renderToStaticMarkup(createElement(ShimmerView, { tiles: [], action: 'summarize', still: false })),
    ).toBe('')
  })
})

describe('the highlight of a result', () => {
  const boxes = [
    { x: 10, y: 10, w: 100, h: 100 },
    { x: 200, y: 10, w: 100, h: 100 },
  ]

  it('draws a box over each element the result wrote', () => {
    const html = renderToStaticMarkup(createElement(FlashView, { boxes, still: false }))
    expect(html).toContain('data-testid="ai-flash"')
    expect(html.match(/dr-ai-flash__box/g)).toHaveLength(2)
    // a few pixels past the element's edge, in overlay pixels
    expect(html).toContain('left:6px;top:6px;width:108px;height:108px')
  })

  it('is off under reduced motion, and when there is nothing to draw', () => {
    expect(renderToStaticMarkup(createElement(FlashView, { boxes, still: true }))).toBe('')
    expect(renderToStaticMarkup(createElement(FlashView, { boxes: [], still: false }))).toBe('')
  })
})

describe('placeholder geometry', () => {
  const rect = { x: 0, y: 0, w: 640, h: 500 }

  it('a grid of notes under a heading, the columns the notes block uses', () => {
    expect([1, 3, 4, 5, 9, 10, 12].map(noteColumns)).toEqual([1, 3, 4, 3, 3, 4, 4])
    const plan = noteTiles(rect, 6, 40)
    expect(plan.tiles).toHaveLength(6)
    expect(plan.tiles.every((t) => t.shape === 'note' && t.w === t.h)).toBe(true)
    expect(Math.min(...plan.tiles.map((t) => t.y))).toBeGreaterThanOrEqual(40)
  })

  it('pills stack, the map has a hub and a ring, a region is one block', () => {
    const pills = pillTiles({ x: 0, y: 0, w: 150, h: 340 }, 5)
    expect(pills.tiles.map((t) => t.y)).toEqual([...pills.tiles.map((t) => t.y)].sort((a, b) => a - b))
    const map = mapTiles(rect, 6)
    expect(map.tiles.filter((t) => t.shape === 'hub')).toHaveLength(1)
    expect(map.tiles.filter((t) => t.shape === 'pill')).toHaveLength(6)
    expect(regionTile(rect).tiles).toEqual([{ ...rect, shape: 'region' }])
  })

  it('never draws more than a few blocks', () => {
    expect(noteTiles(rect, 500).tiles.length).toBeLessThanOrEqual(SHIMMER_MAX_TILES)
    expect(mapTiles(rect, 500).tiles.length).toBeLessThanOrEqual(SHIMMER_MAX_TILES + 1)
  })

  it('scene boxes become overlay pixels, and off-screen ones are told apart', () => {
    const px = toPixels({ x: 100, y: 50, w: 40, h: 20 }, (p) => ({ x: p.x * 2 - 10, y: p.y * 2 }))
    expect(px).toEqual({ x: 190, y: 100, w: 80, h: 40 })
    expect(onScreen(px, 1000, 800)).toBe(true)
    expect(onScreen({ x: 1200, y: 0, w: 10, h: 10 }, 1000, 800)).toBe(false)
    expect(onScreen({ x: -50, y: 0, w: 40, h: 10 }, 1000, 800)).toBe(false)
  })
})

describe('where each result will land', () => {
  function board(seed: El[] = []) {
    const f = fakeMapCanvas(seed)
    const rt = new MindmapRuntime(f.canvas, (text, size) => measure(text, size))
    setMindmap(f.canvas, { rt, notify: () => undefined } as unknown as Mindmap)
    return { f, rt }
  }

  it('a summary has no place on the board (it opens in its panel)', () => {
    const { f } = board()
    expect(landingFor(f.canvas, { action: 'summarize' }, NONE)).toBeNull()
  })

  it('notes regrouped lie where the target is', () => {
    const { f } = board()
    const plan = landingFor(
      f.canvas,
      { action: 'themes' },
      { ...NONE, bounds: { x: 0, y: 0, width: 400, height: 300 } },
    )
    expect(plan?.tiles).toHaveLength(1)
    expect(plan?.tiles[0]).toMatchObject({ shape: 'region', x: -12, y: -12, w: 424, h: 324 })
  })

  it('Generate ideas: a heading and one block per note, beside the target', () => {
    const note: El = { id: 'n1', type: 'stickynote', x: 0, y: 0, width: 200, height: 200 }
    const { f } = board([note])
    const target = {
      ...NONE,
      kind: 'selection' as const,
      ids: ['n1'],
      label: '1 sticky note',
      texts: 1,
      bounds: { x: 0, y: 0, width: 200, height: 200 },
    }
    const plan = landingFor(f.canvas, { action: 'ideas', prompt: 'names', count: 4 }, target)
    expect(plan?.tiles.filter((t) => t.shape === 'note')).toHaveLength(4)
    // clear of what is there
    expect(plan?.rect.x).toBeGreaterThanOrEqual(200)
  })

  it('Expand with AI: pills in a column beside the topic', () => {
    const { f, rt } = board()
    const built = rt.createMapFromOutline({
      text: 'Hub',
      children: [
        { text: 'A', children: [] },
        { text: 'B', children: [] },
      ],
    })
    const a = built?.children[0] as string
    const box = f.canvas.bounds(a)
    const plan = landingFor(
      f.canvas,
      { action: 'ideas', prompt: 'A', count: 5, into: { kind: 'expand', topicId: a } },
      NONE,
    )
    expect(plan?.tiles).toHaveLength(5)
    expect(plan?.tiles.every((t) => t.shape === 'pill')).toBe(true)
    const left = (lobbyOf(f.els.get(a)).mindmap as { side: string }).side === 'left'
    const edge = plan?.rect.x ?? 0
    // beside the topic, away from the centre
    expect(
      left ? edge + (plan?.rect.w ?? 0) <= (box?.x ?? 0) : edge >= (box?.x ?? 0) + (box?.width ?? 0),
    ).toBe(true)
  })

  it('Mind map from a prompt: a hub and a ring at the free spot a new map goes to', () => {
    const { f } = board()
    const plan = landingFor(
      f.canvas,
      { action: 'ideas', prompt: 'Party', count: 6, into: { kind: 'mindmap' } },
      NONE,
    )
    expect(plan?.tiles.filter((t) => t.shape === 'hub')).toHaveLength(1)
    expect(plan?.tiles.filter((t) => t.shape === 'pill')).toHaveLength(6)
  })
})
