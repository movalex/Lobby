// The people list's frame derivation reads the frames alone: moving another shape (a drag streams a
// change per frame) never re-runs it, moving or renaming a frame does.
import {
  computed,
  createShapeId,
  createTLStore,
  DocumentRecordType,
  defaultShapeUtils,
  FrameShapeUtil,
  GeoShapeUtil,
  PageRecordType,
  TLDOCUMENT_ID,
  type TLShape,
  type TLShapeId,
} from 'tldraw'
import { describe, expect, it } from 'vitest'
import { type FrameEditor, frameBoxes, frameRecordsQuery } from './frames.ts'

const pageId = PageRecordType.createId('p1')
const FRAME = createShapeId('frame1')
const GEO = createShapeId('geo1')

function board() {
  const store = createTLStore({ shapeUtils: defaultShapeUtils })
  const shape = (id: TLShapeId, type: 'frame' | 'geo', props: object, x = 0) =>
    store.schema.types.shape.create({ id, type, parentId: pageId, index: 'a1' as never, x, y: 0, props })
  store.put([
    DocumentRecordType.create({ id: TLDOCUMENT_ID }),
    PageRecordType.create({ id: pageId, name: 'Page 1', index: 'a1' as never }),
    shape(FRAME, 'frame', { ...new FrameShapeUtil({} as never).getDefaultProps(), name: 'Brainstorm' }),
    shape(GEO, 'geo', new GeoShapeUtil({} as never).getDefaultProps(), 500),
  ])
  // The two editor reads the derivation uses, over the same reactive store.
  const editor = {
    store,
    getAncestorPageId: (s: TLShape) => {
      let parent: string | undefined = s.parentId
      while (parent && !parent.startsWith('page:'))
        parent = (store.get(parent as TLShapeId) as TLShape)?.parentId
      return parent
    },
    getShapePageBounds: (s: TLShape) => {
      const r = store.get(s.id) as TLShape & { props: { w: number; h: number } }
      return { x: r.x, y: r.y, w: r.props.w, h: r.props.h }
    },
  } as unknown as FrameEditor
  return { store, editor }
}

describe('people list frames', () => {
  it('re-runs for frame changes only, never for other shapes', () => {
    const { store, editor } = board()
    const query = frameRecordsQuery(editor)
    let runs = 0
    const key = computed('frames', () => {
      runs++
      return JSON.stringify(frameBoxes(editor, query.get()))
    })
    expect(JSON.parse(key.get())).toEqual([{ name: 'Brainstorm', pageId, x: 0, y: 0, w: 320, h: 180 }])
    const before = runs
    for (let x = 510; x < 600; x += 10) {
      const geo = store.get(GEO) as TLShape
      store.put([{ ...geo, x }])
      key.get()
    }
    expect(runs).toBe(before)
    const frame = store.get(FRAME) as TLShape
    store.put([{ ...frame, x: 40 }])
    expect(JSON.parse(key.get())[0]).toMatchObject({ x: 40, name: 'Brainstorm' })
    expect(runs).toBe(before + 1)
  })
})
