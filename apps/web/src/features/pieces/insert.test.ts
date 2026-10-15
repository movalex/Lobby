// L8-3: putting a piece on a small in-memory canvas: one undo step with fresh ids, the unlocked frame under
// the point takes it (a locked one and a frame piece do not), the same piece again is nudged, the drop handler
// reads only its own text.
import { installServerTextMetrics } from '@draftroom/canvas-schema/engine'
import { insertLabel, PIECES } from '@draftroom/templates/pieces/catalog'
import { describe, expect, it } from 'vitest'
import type { ExternalContent } from '../../canvas/api/index.ts'
import { elementsState } from '../elements/state.ts'
import { type El, fakeCanvas, fakeCtx, frameEl } from '../sort/test-kit.ts'
import { COMMANDS, DROP_HANDLER, PIECE_COMMAND_IDS } from './commands.ts'
import { failureText, frameAtPoint, insertPiece } from './insert.ts'
import { dragPayload } from './model.ts'

installServerTextMetrics()

const text = (t: string): ExternalContent => ({ kind: 'text', text: t })

describe('insertPiece', () => {
  it('writes the whole piece in one step with new ids, selects it, and centres it on the view', async () => {
    const f = fakeCanvas([])
    const out = await insertPiece(f.canvas, 'button')
    expect(out.ok).toBe(true)
    expect(f.steps).toEqual(['insert button'])
    const inserted = f.ops.filter((o) => o.op === 'insert')
    expect(inserted.length).toBe(2) // the button and its label
    expect(f.selected).toHaveLength(1)
    // the view is 4000 x 3000 from (-500, -500): the middle is (1500, 1000)
    const b = f.els.get(f.selected[0] as string) as El
    expect(b.x + b.width / 2).toBeCloseTo(1500, -1)
    expect(b.y + b.height / 2).toBeCloseTo(1000, -1)
    // a second one has other ids
    const ids = new Set(f.ops.map((o) => o.id))
    await insertPiece(f.canvas, 'button')
    expect(f.steps).toHaveLength(2)
    const second = f.ops.filter((o) => o.op === 'insert').slice(2)
    for (const o of second) expect(ids.has(o.id)).toBe(false)
  })

  it('nudges the same piece inserted again at the same point, so a row of them is not a stack', async () => {
    const f = fakeCanvas([])
    await insertPiece(f.canvas, 'process')
    await insertPiece(f.canvas, 'process')
    await insertPiece(f.canvas, 'process')
    const boxes = [...f.els.values()].filter((e) => e.type === 'rectangle')
    expect(new Set(boxes.map((e) => `${e.x},${e.y}`)).size).toBe(3)
  })

  it('a drop centres on the pointer and joins the unlocked frame under it, every element of it', async () => {
    const f = fakeCanvas([frameEl('fr', 0, 0, 1200, 800, 'Screen')])
    const out = await insertPiece(f.canvas, 'card', { at: { x: 400, y: 300 } })
    expect(out).toMatchObject({ ok: true, frameId: 'fr' })
    const inserted = [...f.els.values()].filter((e) => e.id !== 'fr')
    expect(inserted.length).toBeGreaterThan(3)
    for (const e of inserted) expect(e.frameId, e.type).toBe('fr')
    const card = inserted.find((e) => e.type === 'rectangle' && e.width === 280) as El
    expect(card.x + card.width / 2).toBeCloseTo(400, -1)
    expect(card.y + card.height / 2).toBeCloseTo(300, -1)
  })

  it('does not put a piece in a locked frame, and never puts a frame piece in a frame', async () => {
    const f = fakeCanvas([frameEl('locked', 0, 0, 1200, 800, 'Locked', { locked: true })])
    const a = await insertPiece(f.canvas, 'button', { at: { x: 300, y: 300 } })
    expect(a).toMatchObject({ ok: true, frameId: null })
    const g = fakeCanvas([frameEl('open', 0, 0, 1200, 800, 'Open')])
    const b = await insertPiece(g.canvas, 'swimlane', { at: { x: 300, y: 300 } })
    expect(b).toMatchObject({ ok: true, frameId: null })
    const lane = [...g.els.values()].find((e) => e.type === 'frame' && e.id !== 'open') as El
    expect(lane.frameId).toBeNull()
  })

  it('takes the innermost frame when frames overlap, and ignores a point outside them', () => {
    const f = fakeCanvas([frameEl('big', 0, 0, 2000, 2000), frameEl('small', 100, 100, 300, 300)])
    expect(frameAtPoint(f.canvas, { x: 200, y: 200 })?.id).toBe('small')
    expect(frameAtPoint(f.canvas, { x: 1000, y: 1000 })?.id).toBe('big')
    expect(frameAtPoint(f.canvas, { x: 5000, y: 5000 })).toBeNull()
  })

  it('does nothing on a read-only canvas, or for an id it does not know', async () => {
    const f = fakeCanvas([], { readOnly: true })
    expect(await insertPiece(f.canvas, 'button')).toEqual({ ok: false, reason: 'readonly' })
    expect(f.steps).toEqual([])
    const g = fakeCanvas([])
    expect(await insertPiece(g.canvas, 'nope' as never)).toEqual({ ok: false, reason: 'unknown' })
  })

  it('refuses when the board would pass its object limit, and writes nothing', async () => {
    const f = fakeCanvas([])
    // the canvas says it already holds the limit
    ;(f.canvas as { items: () => unknown }).items = () =>
      Array.from({ length: 20_000 }, (_, i) => ({ id: `x${i}`, type: 'rectangle', frameId: null }))
    const out = await insertPiece(f.canvas, 'process')
    expect(out).toEqual({ ok: false, reason: 'too-many-shapes' })
    expect(f.steps).toEqual([])
  })

  it('writes elements the room would take: one group for a piece of several, the kind on all', async () => {
    const f = fakeCanvas([])
    await insertPiece(f.canvas, 'browser')
    const els = [...f.els.values()]
    expect(new Set(els.map((e) => (e.customData as { lobby: { kind: string } }).lobby.kind))).toEqual(
      new Set(['piece-browser']),
    )
    expect(new Set(els.map((e) => (e.groupIds as string[]).join())).size).toBe(1)
  })
})

describe('what is told when an insert did not happen', () => {
  it('says shapes, not pieces (the panel is named Shapes)', () => {
    for (const reason of ['readonly', 'too-many-shapes', 'unknown'] as const)
      expect(failureText(reason), reason).not.toMatch(/\bpieces?\b/i)
    expect(failureText('too-many-shapes')).toBe('This board has too many objects to add this shape.')
    expect(failureText('unknown')).toBe('The shape could not be added.')
  })
})

describe('the drop handler', () => {
  it('turns a piece dragged from the panel into the piece at the pointer, and takes the content', async () => {
    const f = fakeCanvas([])
    const { ctx } = fakeCtx(f.canvas)
    const taken = await DROP_HANDLER.handle(text(dragPayload('input')), ctx, { x: 800, y: 600 }, 'drop')
    expect(taken).toBe(true)
    expect(f.steps).toEqual(['insert input'])
    const box = [...f.els.values()].find((e) => e.type === 'rectangle') as El
    expect(box.x + box.width / 2).toBeCloseTo(800, -1)
  })

  it('leaves any other text to the other handlers, and a paste to the paste handlers', async () => {
    const f = fakeCanvas([])
    const { ctx } = fakeCtx(f.canvas)
    expect(await DROP_HANDLER.handle(text('buy milk\nand bread'), ctx, { x: 0, y: 0 }, 'drop')).toBe(false)
    expect(await DROP_HANDLER.handle(text(dragPayload('input')), ctx, { x: 0, y: 0 }, 'paste')).toBe(false)
    expect(await DROP_HANDLER.handle({ kind: 'url', url: 'https://example.com/x' }, ctx, null, 'drop')).toBe(
      false,
    )
    expect(f.steps).toEqual([])
    // and it runs before every text handler (bulk paste 50, link cards 100)
    expect(DROP_HANDLER.priority).toBeGreaterThan(100)
    expect(DROP_HANDLER.kinds).toEqual(['text'])
  })

  it('takes the drop but writes nothing when this person cannot edit', async () => {
    const f = fakeCanvas([], { readOnly: true })
    const { ctx } = fakeCtx(f.canvas)
    expect(await DROP_HANDLER.handle(text(dragPayload('input')), ctx, { x: 0, y: 0 }, 'drop')).toBe(true)
    expect(f.steps).toEqual([])
  })
})

describe('the commands', () => {
  it('has a command for each piece, "Insert decision" among them, and one to open the panel', () => {
    const ids = COMMANDS.map((c) => c.id)
    expect(ids).toContain(PIECE_COMMAND_IDS.open)
    for (const p of PIECES) {
      const c = COMMANDS.find((x) => x.id === PIECE_COMMAND_IDS.insert(p.id))
      expect(c?.label).toBe(insertLabel(p))
      expect(c?.group).toBe('Insert')
      expect(c?.keywords).toContain(p.name)
    }
    expect(COMMANDS.find((c) => c.id === 'pieces.insert.decision')?.label).toBe('Insert decision')
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('runs through the registry like a menu would: the piece is on the board in one step', async () => {
    const f = fakeCanvas([])
    const { ctx } = fakeCtx(f.canvas)
    const cmd = COMMANDS.find((c) => c.id === 'pieces.insert.decision')
    await cmd?.run(ctx, 'palette')
    expect(f.steps).toEqual(['insert decision'])
    expect(f.selected).toHaveLength(1)
  })

  it('opens the Elements panel on its Shapes tab (wave Q: the Shapes dock entry has retired), and closes it', () => {
    const opened: (string | null)[] = []
    const f = fakeCanvas([])
    const { ctx } = fakeCtx(f.canvas, { openPanel: (id: string | null) => void opened.push(id) } as never)
    COMMANDS.find((c) => c.id === 'pieces.open')?.run(ctx, 'palette')
    expect(opened).toEqual(['elements'])
    expect(elementsState(f.canvas).requestedTab.get()).toBe('shapes')
    const open = fakeCtx(f.canvas, {
      openPanel: (id: string | null) => void opened.push(id),
      activePanel: 'elements',
    } as never).ctx
    COMMANDS.find((c) => c.id === 'pieces.open')?.run(open, 'palette')
    expect(opened).toEqual(['elements', null])
  })
})
