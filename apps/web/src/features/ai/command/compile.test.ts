// W3 (wave L, L3-3): board command ops compiled into ONE transact. Locked and leased elements are skipped,
// bound connectors are never in the push of a move, 'find' mode never writes, and the geometry is the menus'.
import type { AiCommandOp } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import { NOTE_PALETTE } from '../../canvas-ux/palette.ts'
import { applyCompiled, compileCommand, skipsText, writesAnything } from './compile.ts'
import { arrow, fakeBoard, frame, note, shape, updatedIds } from './test-kit.ts'

const refs = (...ids: string[]) => ids.map((id) => `shape:${id}`)
const yellowFill = NOTE_PALETTE.find((s) => s.name === 'yellow')?.light.fill

describe('compileCommand', () => {
  it('is one transact for every op, and skips locked and leased elements (named in the toast)', () => {
    const b = fakeBoard(
      [
        ...note('a', { x: 0, y: 0 }),
        ...note('b', { x: 300, y: 50 }),
        ...note('c', { x: 600, y: 100, locked: true }),
        ...note('d', { x: 900, y: 150 }),
      ],
      { leases: { 'd-label': 'other-tab' } },
    )
    const ops: AiCommandOp[] = [
      { op: 'recolor', ids: refs('a', 'b', 'c', 'd'), color: 'yellow' },
      { op: 'align', ids: refs('a', 'b', 'c', 'd'), edge: 'top' },
    ]
    const c = compileCommand(b.canvas, ops, 'do')
    expect(c.skipped).toEqual({ locked: 1, leased: 1, bound: 0, refused: 0 })
    expect(skipsText(c.skipped)).toBe(
      '1 locked item was left as it is; 1 item someone is typing in was skipped.',
    )
    applyCompiled(b.canvas, c, 'Make 4 notes yellow')
    expect(b.steps).toHaveLength(1)
    const ids = updatedIds(b.steps[0])
    expect(ids).not.toContain('c')
    expect(ids).not.toContain('c-label')
    expect(ids).not.toContain('d')
    expect(ids).not.toContain('d-label')
    // a recolour and a move of the same note are one write
    const aPatch = b.steps[0]?.ops.find((o) => o[0] === 'update' && o[1] === 'b')?.[2]
    expect(aPatch).toEqual({ backgroundColor: yellowFill, x: 300, y: 0 })
    // the label moved with its note
    expect(b.steps[0]?.ops.find((o) => o[0] === 'update' && o[1] === 'b-label')?.[2]).toEqual({
      x: 310,
      y: 10,
    })
    expect([...c.changed].sort()).toEqual(['a', 'b'])
  })

  it('never puts a connector bound at either end into the push of a move (the server re-snaps it)', () => {
    const b = fakeBoard([
      shape('s1', { x: 0, y: 0 }),
      shape('s2', { x: 400, y: 120 }),
      arrow('bound', { x: 200, y: 100, startBinding: { elementId: 's1' }, endBinding: null }),
      arrow('free', { x: 100, y: 500 }),
    ])
    const ops: AiCommandOp[] = [
      { op: 'align', ids: refs('s1', 's2', 'bound', 'free'), edge: 'left' },
      { op: 'arrangeGrid', ids: refs('s1', 's2', 'bound', 'free') },
      { op: 'wrapInFrame', ids: refs('s1', 's2', 'bound', 'free'), name: 'Flow' },
    ]
    const c = compileCommand(b.canvas, ops, 'do')
    applyCompiled(b.canvas, c, 'Tidy')
    expect(b.steps).toHaveLength(1)
    const ops0 = b.steps[0]?.ops ?? []
    expect(updatedIds(b.steps[0])).not.toContain('bound')
    expect(ops0.filter((o) => o[0] === 'setFrame').flatMap((o) => o[1] as string[])).not.toContain('bound')
    expect(c.skipped.bound).toBe(1)
    expect(updatedIds(b.steps[0])).toContain('free')
    // a recolour may still reach a bound connector (it is not geometry)
    const r = compileCommand(b.canvas, [{ op: 'recolor', ids: refs('bound'), color: 'red' }], 'do')
    expect([...r.updates.keys()]).toEqual(['bound'])
  })

  it("'find' mode never emits a write: only select and zoomTo survive, the rest is counted", () => {
    const b = fakeBoard([...note('a'), ...note('b', { x: 300 }), frame('f', { x: -100, y: -100 })])
    const every: AiCommandOp[] = [
      { op: 'select', ids: refs('a') },
      { op: 'recolor', ids: refs('a', 'b'), color: 'red' },
      { op: 'setFill', ids: refs('a'), fill: 'solid' },
      { op: 'align', ids: refs('a', 'b'), edge: 'left' },
      { op: 'distribute', ids: refs('a', 'b'), axis: 'horizontal' },
      { op: 'arrangeGrid', ids: refs('a', 'b') },
      { op: 'tag', ids: refs('a'), tag: 'Finance' },
      { op: 'wrapInFrame', ids: refs('a', 'b'), name: 'X' },
      { op: 'lock', ids: refs('a', 'b') },
      { op: 'zoomTo', ids: refs('b') },
    ]
    const c = compileCommand(b.canvas, every, 'find')
    expect(writesAnything(c)).toBe(false)
    expect(c.updates.size).toBe(0)
    expect(c.frames).toEqual([])
    expect(c.doc).toEqual({})
    expect(c.skipped.refused).toBe(8)
    expect(c.select).toEqual(['a'])
    expect(c.zoom).toEqual(['b'])
    applyCompiled(b.canvas, c, 'Find')
    expect(b.steps).toHaveLength(0)
  })

  it('a new frame: around what it holds with a margin, behind it, its members set; one step', () => {
    const b = fakeBoard([...note('a', { x: 100, y: 100 }), ...note('b', { x: 400, y: 100 })])
    const c = compileCommand(b.canvas, [{ op: 'wrapInFrame', ids: refs('a', 'b'), name: 'Plan' }], 'do')
    expect(c.preview.creates).toEqual([{ x: 60, y: 60, w: 580, h: 280, kind: 'frame' }])
    applyCompiled(b.canvas, c, 'Put 2 notes in a frame')
    expect(b.steps).toHaveLength(1)
    expect(b.steps[0]?.ops).toEqual([
      ['create', 'frame', { x: 60, y: 60, width: 580, height: 280, name: 'Plan' }],
      ['setFrame', ['a', 'b'], 'new-frame-1'],
      ['reorder', ['new-frame-1'], 'back'],
    ])
  })

  it('tags: the board definition goes first (the same push), the elements in the step', () => {
    const b = fakeBoard([...note('a'), ...note('b', { x: 300 })])
    const c = compileCommand(b.canvas, [{ op: 'tag', ids: refs('a', 'b'), tag: 'Finance' }], 'do')
    applyCompiled(b.canvas, c, 'Tag')
    expect(b.docSets).toHaveLength(1)
    const key = Object.keys(b.docSets[0] ?? {})[0] as string
    expect(key).toMatch(/^tagDef:/)
    expect(b.steps).toHaveLength(1)
    const patch = b.steps[0]?.ops.find((o) => o[1] === 'a')?.[2] as {
      customData: { lobby: Record<string, unknown> }
    }
    expect(Object.keys(patch.customData.lobby)).toEqual([key.replace('tagDef:', 'tag:')])
  })

  it('lock writes the element, its label and a frame’s contents; ids not on the board are dropped', () => {
    const b = fakeBoard([frame('f', { x: 0, y: 0 }), ...note('a', { x: 100, y: 100, frameId: 'f' })])
    const c = compileCommand(b.canvas, [{ op: 'lock', ids: refs('f', 'nope', 'zz') }], 'do')
    applyCompiled(b.canvas, c, 'Lock')
    expect(updatedIds(b.steps[0]).sort()).toEqual(['a', 'a-label', 'f'])
    expect(b.steps[0]?.ops.every((o) => (o[2] as { locked?: boolean }).locked === true)).toBe(true)
  })

  it('a later op sees what an earlier one moved (one draft), and the preview lists the moves and colours', () => {
    const b = fakeBoard([
      ...note('a', { x: 0, y: 0 }),
      ...note('b', { x: 250, y: 300 }),
      ...note('c', { x: 900, y: 40 }),
    ])
    const c = compileCommand(
      b.canvas,
      [
        { op: 'align', ids: refs('a', 'b', 'c'), edge: 'top' },
        { op: 'distribute', ids: refs('a', 'b', 'c'), axis: 'horizontal' },
        { op: 'recolor', ids: refs('c'), color: 'yellow' },
      ],
      'do',
    )
    const byId = new Map(c.preview.moves.map((m) => [m.id, m]))
    expect(byId.get('b')).toEqual({ id: 'b', x: 450, y: 0 })
    expect(byId.get('c')).toEqual({ id: 'c', x: 900, y: 0 })
    expect(byId.has('a')).toBe(false)
    expect(c.preview.recolors).toEqual([{ id: 'c', to: 'yellow' }])
  })
})
