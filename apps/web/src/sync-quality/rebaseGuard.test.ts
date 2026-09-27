// The redo-stack guard against the mechanism it works around (docs in rebaseGuard.ts). The Editor's
// own cleanup is reproduced here the way @tldraw/editor 5.4.2 registers it: a before-delete handler
// that notes shape ids, and an operation-complete handler that drops them from the page state.
import {
  createShapeId,
  createTLStore,
  DocumentRecordType,
  defaultShapeUtils,
  GeoShapeUtil,
  InstancePageStateRecordType,
  PageRecordType,
  TLDOCUMENT_ID,
  TLINSTANCE_ID,
  type TLShapeId,
  type TLStore,
} from 'tldraw'
import { describe, expect, it } from 'vitest'
import { guardStore, restoreDroppedRefs } from './rebaseGuard.ts'

const pageId = PageRecordType.createId('p1')
const psId = InstancePageStateRecordType.createId(pageId)
const G1 = createShapeId('g1')
const G2 = createShapeId('g2')

function board(guarded: boolean) {
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
  // The Editor's cleanup (Editor.ts: beforeDelete -> deletedShapeIds; operation complete -> cleanup).
  const deleted = new Set<string>()
  store.sideEffects.registerBeforeDeleteHandler('shape', (s) => {
    deleted.add(s.id)
  })
  store.sideEffects.registerOperationCompleteHandler(() => {
    if (!deleted.size) return
    const ps = store.get(psId)
    const ids = new Set(deleted)
    deleted.clear()
    if (!ps) return
    const selectedShapeIds = ps.selectedShapeIds.filter((id) => !ids.has(id))
    if (selectedShapeIds.length !== ps.selectedShapeIds.length) store.put([{ ...ps, selectedShapeIds }])
  })
  if (guarded) guardStore(store)
  const ps = store.get(psId)
  if (ps) store.put([{ ...ps, selectedShapeIds: [G1, G2] }])
  const userChanges: string[] = []
  store.listen((e) => userChanges.push(...Object.keys(e.changes.updated)), { source: 'user' })
  return { store, geo, userChanges, selection: () => store.get(psId)?.selectedShapeIds }
}

/** What TLSyncClient.rebase does when the server confirms our delete of a shape we re-created since. */
function rebaseDeleteThenRecreate(store: TLStore, geo: (id: TLShapeId, index: string) => unknown) {
  store.mergeRemoteChanges(() => {
    store.remove([G1])
    store.put([geo(G1, 'a1') as never])
  })
}

describe('rebase selection guard', () => {
  it('without it, a delete + re-create inside one remote merge drops the shape from the selection as a user change', () => {
    const { store, geo, userChanges, selection } = board(false)
    rebaseDeleteThenRecreate(store, geo)
    expect(store.has(G1)).toBe(true)
    expect(selection()).toEqual([G2]) // the engine behavior the guard exists for
    expect(userChanges).toContain(psId) // ...recorded as the user's own change (ends the redo stack)
  })

  it('with it, the re-created shape stays selected and nothing is attributed to the user', () => {
    const { store, geo, userChanges, selection } = board(true)
    rebaseDeleteThenRecreate(store, geo)
    expect(selection()).toEqual([G1, G2])
    expect(userChanges).toEqual([])
  })

  it('still drops a shape a remote change really deleted', () => {
    const { store, selection } = board(true)
    store.mergeRemoteChanges(() => store.remove([G1]))
    expect(selection()).toEqual([G2])
  })

  it('leaves local deletions alone', () => {
    const { store, selection } = board(true)
    store.remove([G2])
    expect(selection()).toEqual([G1])
  })

  it('restores only wrongly dropped references, in their previous order', () => {
    const ps = InstancePageStateRecordType.create({
      id: psId,
      pageId,
      selectedShapeIds: [G1, G2],
      hoveredShapeId: G1,
    })
    const next = { ...ps, selectedShapeIds: [G2], hoveredShapeId: null }
    expect(restoreDroppedRefs(ps, next, (id) => id === G1)).toBe(ps)
    const partly = restoreDroppedRefs(ps, { ...next, selectedShapeIds: [] }, (id) => id === G1)
    expect(partly.selectedShapeIds).toEqual([G1])
    expect(partly.hoveredShapeId).toBe(G1)
    expect(restoreDroppedRefs(ps, next, () => false)).toBe(next)
  })
})
