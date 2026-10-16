// Storyboard writes (wave T, WS2) on the canvas fake: each is one transact (one undo step) that writes the order keys
// it must and re-lays out what moved; shot numbers are derived (never written); a read-only canvas writes nothing;
// a tab that only receives changes writes nothing (the echo rule).
import { indexKeyBetween } from '@draftroom/canvas-schema/engine'
import { shotNumbers } from '@draftroom/canvas-schema/planning'
import { describe, expect, it } from 'vitest'
import type { CanvasFeatureContext } from '../../canvas/api/index.ts'
import { feature } from './index.tsx'
import { GAP_X, gridPositions, insertKeys, moveKeys, panelGeometry, panelWidth, wrapWords } from './model.ts'
import {
  createStoryboard,
  deletePanels,
  duplicatePanel,
  frameCandidates,
  insertPanel,
  movePanel,
  readingOrder,
  type Sb,
  setDuration,
  storyboardFromFrames,
} from './ops.ts'
import { boardsOf, panelWords } from './state.ts'
import { asCanvas, type El, fakeSbCanvas } from './test-canvas.ts'

let seq = 0
const ids = () => `e${++seq}`
const lobby = (e: El | undefined) =>
  (e?.customData as { lobby?: Record<string, unknown> } | undefined)?.lobby ?? {}

function board(n = 4, words: { camera?: string; action?: string }[] = []) {
  const f = fakeSbCanvas()
  const canvas = asCanvas(f)
  const made = createStoryboard(
    canvas,
    {
      title: 'Coffee spot',
      aspect: '16:9',
      perRow: 3,
      panels: Array.from({ length: n }, (_, i) => ({ durationMs: 1000 * (i + 1), ...(words[i] ?? {}) })),
      at: { x: 0, y: 0 },
    },
    ids,
  )
  if (!made) throw new Error('not made')
  const sb = () => boardsOf(canvas).get(made.headId) as Sb
  return { f, canvas, made, sb }
}

describe('create', () => {
  it('a head and its panels in one step: keys, fields, words, a grid under the head', () => {
    const { f, made, sb } = board(4, [{ camera: 'WIDE', action: 'A city at dawn' }])
    expect(f.transacts.map((t) => t.label)).toEqual(['create storyboard'])
    const head = f.els.get(made.headId)
    expect(head?.type).toBe('text')
    expect(lobby(head)['sb:head']).toEqual({ aspect: '16:9', perRow: 3 })
    expect(head?.originalText).toBe('Coffee spot')
    const s = sb()
    expect(s.panels.map((p) => p.id)).toEqual(made.panelIds)
    expect(s.panels.map((p) => lobby(p as unknown as El)['sb:dur'])).toEqual([1000, 2000, 3000, 4000])
    const keys = s.panels.map((p) => lobby(p as unknown as El)['sb:pos'] as string)
    expect([...keys].sort()).toEqual(keys)
    // three per row, rows under the head
    const xs = s.panels.map((p) => p.x)
    const w = panelWidth('16:9')
    expect(xs).toEqual([0, w + GAP_X, 2 * (w + GAP_X), 0])
    expect(s.panels[3]?.y).toBeGreaterThan(s.panels[0]?.y ?? 0)
    expect(s.panels[0]?.y).toBeGreaterThan(0)
    // each panel: a picture slot, three captions, three field boxes by kind; words in their labels
    const first = made.panelIds[0] as string
    const kids = [...f.els.values()].filter((e) => e.frameId === first)
    expect(kids.filter((k) => lobby(k).slot === 'image')).toHaveLength(1)
    expect(kids.filter((k) => lobby(k).kind === 'sb-caption').map((k) => k.originalText)).toEqual([
      'CAMERA',
      'ACTION',
      'DIALOGUE / VO',
    ])
    expect(panelWords(asCanvas(f), first)).toEqual({
      'sb-camera': 'WIDE',
      'sb-action': 'A city at dawn',
      'sb-dialogue': '',
    })
    // nothing is locked (a layout moves them all)
    expect([...f.els.values()].some((e) => e.locked)).toBe(false)
    // one undo takes the whole storyboard away
    f.undo()
    expect([...f.els.values()].filter((e) => !e.isDeleted)).toEqual([])
  })

  it('nothing on a read-only canvas, nothing for no panels', () => {
    const f = fakeSbCanvas()
    f.setReadOnly(true)
    expect(
      createStoryboard(asCanvas(f), { title: 'x', aspect: '1:1', panels: [{}], at: { x: 0, y: 0 } }),
    ).toBeNull()
    f.setReadOnly(false)
    expect(
      createStoryboard(asCanvas(f), { title: 'x', aspect: '1:1', panels: [], at: { x: 0, y: 0 } }),
    ).toBeNull()
    expect(f.transacts).toEqual([])
  })
})

describe('reorder, insert, duplicate, delete', () => {
  it('a move writes the moved panel’s key only and re-lays out, in one undoable step', () => {
    const { f, canvas, made, sb } = board(4)
    const before = sb().panels.map((p) => ({
      id: p.id,
      x: p.x,
      y: p.y,
      pos: lobby(p as unknown as El)['sb:pos'],
    }))
    f.transacts.length = 0
    expect(movePanel(canvas, sb(), 0, 2)).toBe(true)
    expect(f.transacts.map((t) => t.label)).toEqual(['reorder panels'])
    const after = sb()
    expect(after.panels.map((p) => p.id)).toEqual([
      made.panelIds[1],
      made.panelIds[2],
      made.panelIds[0],
      made.panelIds[3],
    ])
    expect([...shotNumbers(after.panels).entries()]).toEqual([
      [made.panelIds[1], 1],
      [made.panelIds[2], 2],
      [made.panelIds[0], 3],
      [made.panelIds[3], 4],
    ])
    // only the moved panel got a new key
    const changed = after.panels.filter(
      (p) => lobby(p as unknown as El)['sb:pos'] !== before.find((b) => b.id === p.id)?.pos,
    )
    expect(changed.map((p) => p.id)).toEqual([made.panelIds[0]])
    // the panels took each other's slots; a field moved with its panel
    expect(after.panels.map((p) => [p.x, p.y])).toEqual(before.map((b) => [b.x, b.y]))
    const moved = after.panels[2] as unknown as El
    const field = [...f.els.values()].find((e) => e.frameId === moved.id && lobby(e).kind === 'sb-camera')
    expect((field?.x ?? 0) - moved.x).toBe(panelGeometry('16:9').fields[0]?.box.x)
    f.undo()
    expect(sb().panels.map((p) => p.id)).toEqual(made.panelIds)
    expect(sb().panels.map((p) => [p.x, p.y])).toEqual(before.map((b) => [b.x, b.y]))
  })

  it('insert after the first: a key between its neighbours, the rest shift one slot', () => {
    const { f, canvas, made, sb } = board(3)
    const slots = sb().panels.map((p) => [p.x, p.y])
    f.transacts.length = 0
    const id = insertPanel(canvas, sb(), 1, {}, ids) as string
    expect(f.transacts.map((t) => t.label)).toEqual(['insert panel'])
    const s = sb()
    expect(s.panels.map((p) => p.id)).toEqual([made.panelIds[0], id, made.panelIds[1], made.panelIds[2]])
    expect(s.panels.slice(0, 3).map((p) => [p.x, p.y])).toEqual(slots)
    expect(lobby(f.els.get(id))['sb:of']).toBe(made.headId)
    expect(lobby(f.els.get(id))['sb:dur']).toBe(2000)
    expect(asCanvas(f).selection).toEqual([id])
  })

  it('duplicate: the copy joins the storyboard right after its source', () => {
    const { f, canvas, made, sb } = board(2, [{ camera: 'CU' }])
    const copy = duplicatePanel(canvas, sb(), 0) as string
    const s = sb()
    expect(s.panels.map((p) => p.id)).toEqual([made.panelIds[0], copy, made.panelIds[1]])
    expect(lobby(f.els.get(copy))['sb:of']).toBe(made.headId)
    expect(panelWords(asCanvas(f), copy)['sb-camera']).toBe('CU')
  })

  it('delete: the frame and all it holds; the rest close up; one step', () => {
    const { f, canvas, made, sb } = board(3)
    const firstSlot = [sb().panels[0]?.x, sb().panels[0]?.y]
    f.transacts.length = 0
    expect(deletePanels(canvas, sb(), [made.panelIds[0] as string])).toBe(1)
    expect(f.transacts.map((t) => t.label)).toEqual(['delete panel'])
    expect([...f.els.values()].filter((e) => !e.isDeleted && e.frameId === made.panelIds[0])).toEqual([])
    expect(sb().panels.map((p) => p.id)).toEqual(made.panelIds.slice(1))
    expect([sb().panels[0]?.x, sb().panels[0]?.y]).toEqual(firstSlot)
    expect(shotNumbers(sb().panels).get(made.panelIds[1] as string)).toBe(1)
  })

  it('a duration, and a read-only canvas changes nothing', () => {
    const { f, canvas, made, sb } = board(2)
    setDuration(canvas, made.panelIds[0] as string, 2500)
    expect(lobby(f.els.get(made.panelIds[0] as string))['sb:dur']).toBe(2500)
    f.setReadOnly(true)
    f.transacts.length = 0
    expect(movePanel(canvas, sb(), 0, 1)).toBe(false)
    expect(insertPanel(canvas, sb(), 0)).toBeNull()
    expect(deletePanels(canvas, sb(), made.panelIds)).toBe(0)
    expect(f.transacts).toEqual([])
  })
})

describe('a locked panel keeps its place', () => {
  const lock = (f: ReturnType<typeof board>['f'], id: string) =>
    f.els.set(id, { ...(f.els.get(id) as El), locked: true })
  const posOf = (f: ReturnType<typeof board>['f'], id: string) => lobby(f.els.get(id))['sb:pos'] as string
  const ascending = (keys: string[]) => keys.every((k, i) => i === 0 || (keys[i - 1] as string) < k)

  it('a move across a locked panel keys the rest around it; the locked one keeps its key and its slot', () => {
    const { f, canvas, made, sb } = board(4)
    const [p0, p1, p2, p3] = made.panelIds as [string, string, string, string]
    lock(f, p1)
    const slots = sb().panels.map((p) => [p.x, p.y])
    const lockedBefore = structuredClone(f.els.get(p1))
    expect(movePanel(canvas, sb(), 0, 2)).toBe(true)
    expect(f.lockedWrites).toEqual([])
    expect(f.els.get(p1)).toEqual(lockedBefore)
    // the locked panel stays second: the others take the slots around it
    expect(sb().panels.map((p) => p.id)).toEqual([p2, p1, p0, p3])
    expect(sb().panels.map((p) => [p.x, p.y])).toEqual(slots)
    expect(ascending(sb().panels.map((p) => posOf(f, p.id)))).toBe(true)
  })

  it('a locked panel is not moved: nothing is written', () => {
    const { f, canvas, made, sb } = board(3)
    lock(f, made.panelIds[0] as string)
    f.transacts.length = 0
    expect(movePanel(canvas, sb(), 0, 2)).toBe(false)
    expect(f.transacts).toEqual([])
  })

  it('a rebalance (keys past 48 characters) skips the locked panel and keys the rest around it', () => {
    const { f, canvas, made, sb } = board(3)
    const [p0, p1, p2] = made.panelIds as [string, string, string]
    // keys that have grown long between the first two panels (past 48 characters, still valid)
    const lo = 'a0'
    let hi = 'a1'
    for (let i = 0; i < 320; i++) hi = indexKeyBetween(lo, hi)
    expect(hi.length).toBeGreaterThan(48)
    expect(hi.length).toBeLessThanOrEqual(64)
    const set = (id: string, pos: string) =>
      f.els.set(id, {
        ...(f.els.get(id) as El),
        customData: { lobby: { ...lobby(f.els.get(id)), 'sb:pos': pos } },
      })
    set(p0, lo)
    set(p1, hi)
    set(p2, 'a2')
    lock(f, p2)
    // insert between the first two: a key between them would pass 48 characters (a rebalance of all, before); now
    // the unlocked panels are keyed around the locked one, which keeps its key and its place (the third slot): the
    // panel pushed out of the slot before it flows past it
    const id = insertPanel(canvas, sb(), 1, {}, ids) as string
    expect(f.lockedWrites).toEqual([])
    expect(posOf(f, p2)).toBe('a2')
    expect(sb().panels.map((p) => p.id)).toEqual([p0, id, p2, p1])
    const keys = sb().panels.map((p) => posOf(f, p.id))
    expect(ascending(keys)).toBe(true)
    expect(keys.every((k) => k.length <= 48)).toBe(true)
  })

  it('insert and duplicate before a locked panel: it keeps its key and its slot', () => {
    for (const run of ['insert', 'duplicate'] as const) {
      const { f, canvas, made, sb } = board(3)
      const p2 = made.panelIds[2] as string
      lock(f, p2)
      const slot = [f.els.get(p2)?.x, f.els.get(p2)?.y]
      const lockedBefore = structuredClone(f.els.get(p2))
      const made1 = run === 'insert' ? insertPanel(canvas, sb(), 1, {}, ids) : duplicatePanel(canvas, sb(), 0)
      expect(made1).toBeTruthy()
      expect(f.lockedWrites).toEqual([])
      expect(f.els.get(p2)).toEqual(lockedBefore)
      expect([f.els.get(p2)?.x, f.els.get(p2)?.y]).toEqual(slot)
      expect(
        sb()
          .panels.map((p) => p.id)
          .indexOf(p2),
      ).toBe(2)
      expect(sb().panels).toHaveLength(4)
      expect(ascending(sb().panels.map((p) => posOf(f, p.id)))).toBe(true)
    }
  })
})

describe('order keys', () => {
  const at = (pos: string[]) => pos.map((p, i) => ({ id: `p${i}`, pos: p }))
  it('one key between neighbours; a rebalance past 48 characters or between equal keys', () => {
    const { newKey, rewrites } = insertKeys(at(['a0', 'a1']), 1)
    expect(newKey > 'a0' && newKey < 'a1').toBe(true)
    expect(rewrites.size).toBe(0)
    // keys that have grown long: the whole storyboard is rebalanced in the same step
    let lo = 'a0'
    let hi = 'a1'
    for (let i = 0; i < 400; i++) hi = indexKeyBetween(lo, hi)
    expect(hi.length).toBeGreaterThan(48)
    const long = insertKeys(at([lo, hi]), 1)
    expect(long.rewrites.size).toBeGreaterThan(0)
    expect(long.newKey.length).toBeLessThanOrEqual(4)
    // a copy with its source's key: no key fits between equal ones
    const same = insertKeys(at(['a0', 'a0']), 1)
    expect(same.rewrites.size).toBeGreaterThan(0)
    lo = 'a0'
    expect(moveKeys(at(['a0', 'a1', 'a2']), 2, 0).size).toBe(1)
  })
})

describe('layout and words', () => {
  it('rows as tall as their tallest panel; words wrap to the field', () => {
    const pos = gridPositions(
      [
        { w: 100, h: 50 },
        { w: 100, h: 80 },
        { w: 100, h: 40 },
      ],
      { x: 10, y: 20 },
      2,
    )
    expect(pos).toEqual([
      { x: 10, y: 20 },
      { x: 10 + 100 + GAP_X, y: 20 },
      { x: 10, y: 20 + 80 + 56 },
    ])
    const width = (s: string) => s.length * 10
    expect(wrapWords('one two three four', 90, width)).toBe('one two\nthree\nfour')
    expect(wrapWords('abcdefghijklmnop', 50, width)).toBe('abcde\nfghij\nklmno\np')
  })
})

describe('Make storyboard from frames', () => {
  it('frames in reading order (rows, then left to right) and a Shapes-kit panel wrapped in a frame', () => {
    const frame = (id: string, x: number, y: number) =>
      ({ id, type: 'frame', x, y, width: 200, height: 120, name: id }) as El
    const f = fakeSbCanvas([
      frame('f-b', 300, 0),
      frame('f-c', 0, 200),
      frame('f-a', 0, 10),
      {
        id: 'k1',
        type: 'rectangle',
        x: 600,
        y: 0,
        width: 400,
        height: 120,
        groupIds: ['g1'],
        customData: { lobby: { kind: 'piece-sb-16x9' } },
      } as El,
      {
        id: 'k2',
        type: 'text',
        x: 616,
        y: 14,
        width: 100,
        height: 20,
        groupIds: ['g1'],
        customData: { lobby: { kind: 'piece-sb-16x9' } },
      } as El,
    ])
    const canvas = asCanvas(f)
    const c = frameCandidates(canvas, ['f-b', 'f-c', 'f-a', 'k1'])
    expect(c.frames.map((x) => x.id).sort()).toEqual(['f-a', 'f-b', 'f-c'])
    expect(c.kits).toHaveLength(1)
    const head = storyboardFromFrames(canvas, c, {}, ids) as string
    expect(f.transacts.map((t) => t.label)).toEqual(['make storyboard from frames'])
    const sb = boardsOf(canvas).get(head) as Sb
    const kitFrame = sb.panels.find((p) => !['f-a', 'f-b', 'f-c'].includes(p.id))
    expect(sb.panels.map((p) => p.id)).toEqual(['f-a', 'f-b', kitFrame?.id, 'f-c'])
    expect(f.els.get('k1')?.frameId).toBe(kitFrame?.id)
    expect(f.els.get('k2')?.frameId).toBe(kitFrame?.id)
    expect(lobby(f.els.get(head))['sb:head']).toEqual({ aspect: '16:9', perRow: 3 })
    // a panel is not offered again
    expect(frameCandidates(canvas, ['f-a']).frames).toEqual([])
    expect(
      readingOrder([
        { x: 5, y: 0, w: 1, h: 10 },
        { x: 0, y: 2, w: 1, h: 10 },
      ]).map((b) => b.x),
    ).toEqual([0, 5])
  })
})

describe('the echo rule', () => {
  it('a tab that receives storyboard changes writes nothing', () => {
    const { f, canvas } = board(3)
    const listeners = new Map<string, ((...a: unknown[]) => void)[]>()
    const c = canvas as unknown as Record<string, unknown>
    c.on = (event: string, fn: (...a: unknown[]) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), fn])
      return () => undefined
    }
    const ctx = { canvas, notify: () => undefined } as unknown as CanvasFeatureContext
    const off = feature.onMount?.(ctx)
    f.transacts.length = 0
    // a remote reorder lands, and the selection changes with it
    for (const fn of listeners.get('change') ?? [])
      fn({ source: 'remote', created: [], updated: ['x'], deleted: [] })
    for (const fn of listeners.get('changed') ?? []) fn(['x'])
    for (const fn of listeners.get('selectionChanged') ?? []) fn([])
    expect(f.transacts).toEqual([])
    off?.()
  })
})
