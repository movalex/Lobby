// F11: one undo press undoes the last real change; the selection-only steps that tldraw 5.4.2's select
// tool leaves on every click (a history stopping point, then a page-state change) never use one up.
// Runs installPerPropUndo against a real store and HistoryManager, driven the way the editor drives
// them (marks, then user changes; remote changes are not recorded).
import {
  createShapeId,
  createTLStore,
  DocumentRecordType,
  defaultShapeUtils,
  type Editor,
  GeoShapeUtil,
  HistoryManager,
  InstancePageStateRecordType,
  PageRecordType,
  TLDOCUMENT_ID,
  TLINSTANCE_ID,
  type TLRecord,
  type TLShapeId,
} from 'tldraw'
import { describe, expect, it } from 'vitest'
import { installPerPropUndo, MAX_SESSION_ONLY_STEPS, skipSessionOnlySteps } from './perPropUndo.ts'

const pageId = PageRecordType.createId('p1')
const psId = InstancePageStateRecordType.createId(pageId)
const G1 = createShapeId('g1')
const G2 = createShapeId('g2')

function board(opts: { skip?: boolean } = {}) {
  const store = createTLStore({ shapeUtils: defaultShapeUtils })
  const geo = (id: TLShapeId, index: string) =>
    store.schema.types.shape.create({
      id,
      type: 'geo',
      parentId: pageId,
      index: index as never,
      props: new GeoShapeUtil({} as never).getDefaultProps(),
    })
  store.mergeRemoteChanges(() =>
    store.put([
      DocumentRecordType.create({ id: TLDOCUMENT_ID }),
      PageRecordType.create({ id: pageId, name: 'Page 1', index: 'a1' as never }),
      store.schema.types.instance.create({ id: TLINSTANCE_ID, currentPageId: pageId }),
      InstancePageStateRecordType.create({ id: psId, pageId }),
      geo(G1, 'a1'),
      geo(G2, 'a2'),
    ]),
  )
  // isReplaying() and _mark() are @internal in 5.4.2 (the editor's isReplayingHistory and
  // markHistoryStoppingPoint call them).
  const history = new HistoryManager<TLRecord>({ store }) as HistoryManager<TLRecord> & {
    isReplaying(): boolean
    _mark(id: string): void
  }
  const editor = {
    store,
    undo() {
      history.undo()
      return this
    },
    redo() {
      history.redo()
      return this
    },
    getCanUndo: () => history.getNumUndos() > 0,
    getCanRedo: () => history.getNumRedos() > 0,
    isReplayingHistory: () => history.isReplaying(),
    getSortedChildIdsForParent: () => [],
    getBindingsToShape: () => [],
  }
  installPerPropUndo(editor as unknown as Editor, { skipSessionOnlySteps: opts.skip })
  let n = 0
  const mark = (name: string) => history._mark(`${name}-${++n}`)
  const select = (...ids: TLShapeId[]) => {
    const ps = store.get(psId)
    if (ps) store.put([{ ...ps, selectedShapeIds: ids }])
  }
  const moveTo = (id: TLShapeId, x: number) => {
    const s = store.get(id)
    if (s) store.put([{ ...s, x }])
  }
  const x = (id: TLShapeId) => store.get(id)?.x
  const selected = () => store.get(psId)?.selectedShapeIds ?? []
  // A real change with both shapes selected (arrange as grid), then the reviewer's clicks.
  const arrangeThenClickAbout = () => {
    mark('select')
    select(G1, G2)
    mark('arrange')
    moveTo(G1, 100)
    moveTo(G2, 200)
    mark('selecting none') // click empty canvas
    select()
    mark('selecting shape') // click one shape
    select(G2)
    mark('clearing selection') // Escape
    select()
    mark('select all') // Ctrl+A
    select(G1, G2)
  }
  return { editor, history, store, mark, select, moveTo, x, selected, arrangeThenClickAbout }
}

describe('undo skips selection-only steps (F11)', () => {
  it('one press undoes the arrange after four selection clicks, and restores its selection', () => {
    const b = board()
    b.arrangeThenClickAbout()
    b.editor.undo()
    expect([b.x(G1), b.x(G2)]).toEqual([0, 0])
    expect(b.selected()).toEqual([G1, G2])
    // Redo puts the layout back in one press too.
    b.editor.redo()
    expect([b.x(G1), b.x(G2)]).toEqual([100, 200])
  })

  it("without the fix (tldraw's own steps) the first four presses only change the selection", () => {
    const b = board({ skip: false })
    b.arrangeThenClickAbout()
    const seen: number[] = []
    for (let i = 0; i < 4; i++) {
      b.editor.undo()
      seen.push(b.selected().length)
      expect(b.x(G1)).toBe(100)
    }
    expect(seen).toEqual([0, 1, 0, 2])
    b.editor.undo()
    expect(b.x(G1)).toBe(0)
  })

  it('stops at every real change, one per press', () => {
    const b = board()
    b.mark('move 1')
    b.moveTo(G1, 10)
    b.mark('click')
    b.select(G1)
    b.mark('move 2')
    b.moveTo(G1, 20)
    b.mark('click')
    b.select()
    b.editor.undo()
    expect(b.x(G1)).toBe(10)
    b.editor.undo()
    expect(b.x(G1)).toBe(0)
    expect(b.editor.getCanUndo()).toBe(false)
  })

  it('a stack of only selection steps is walked to the end and never loops', () => {
    const b = board()
    for (let i = 0; i < 5; i++) {
      b.mark('click')
      b.select(i % 2 ? G1 : G2)
    }
    b.editor.undo()
    expect(b.editor.getCanUndo()).toBe(false)
    expect(b.selected()).toEqual([])
    expect([b.x(G1), b.x(G2)]).toEqual([0, 0])
  })

  it('an undo right after a click (the change still pending) also reaches the real change', () => {
    const b = board()
    b.mark('move')
    b.moveTo(G2, 50)
    b.mark('click')
    b.select(G2) // pending, no mark after it
    b.editor.undo()
    expect(b.x(G2)).toBe(0)
  })

  it('caps the walk (a stand-in whose steps never touch the document)', () => {
    let calls = 0
    const target = {
      undo: () => {
        calls++
      },
      redo: () => {},
      getCanUndo: () => true,
      getCanRedo: () => false,
    }
    const off = skipSessionOnlySteps(target, { reset() {}, touchedDocument: () => false })
    target.undo()
    expect(calls).toBe(MAX_SESSION_ONLY_STEPS)
    off()
    calls = 0
    target.undo()
    expect(calls).toBe(1)
  })
})
