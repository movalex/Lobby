import type { CommentThread, ThreadComment } from '@draftroom/contracts'
import { Mat } from 'tldraw'
import { describe, expect, it } from 'vitest'
import {
  anchorForClick,
  anchorLabel,
  matchesFilter,
  pinState,
  placeAnchor,
  type ShapeFrame,
  sortThreads,
  unreadComments,
  uvFor,
} from './model.ts'

const ME = 'usr_me0000000000000000'
const ANN = 'usr_ann0000000000000000'
const BOB = 'usr_bob0000000000000000'
const ref = (id: string, name = id) => ({ id, name, color: '#123456' })

let n = 0
function comment(author: string, at: string, extra: Partial<ThreadComment> = {}): ThreadComment {
  n++
  return {
    id: `cmt_${String(n).padStart(20, '0')}`,
    threadId: 'thr_00000000000000000001',
    author: ref(author),
    body: 'hello',
    mentions: [],
    createdAt: at,
    editedAt: null,
    ...extra,
  }
}

function thread(comments: ThreadComment[], extra: Partial<CommentThread> = {}): CommentThread {
  return {
    id: `thr_${String(++n).padStart(20, '0')}`,
    boardId: 'b-0123456789',
    anchor: { kind: 'point', x: 0, y: 0 },
    status: 'open',
    createdBy: comments[0]?.author ?? ref(ANN),
    createdAt: comments[0]?.createdAt ?? '2026-09-26T10:00:00.000Z',
    updatedAt: comments[comments.length - 1]?.createdAt ?? '2026-09-26T10:00:00.000Z',
    resolvedBy: null,
    resolvedAt: null,
    comments,
    ...extra,
  }
}

const T0 = '2026-09-26T10:00:00.000Z'
const T1 = '2026-09-26T10:05:00.000Z'
const T2 = '2026-09-26T10:10:00.000Z'
const T3 = '2026-09-26T10:15:00.000Z'

describe('read state and pin states', () => {
  it('counts only other people’s comments after my read mark', () => {
    const t = thread([comment(ANN, T0), comment(ME, T1), comment(BOB, T2)])
    expect(unreadComments(t, ME, undefined).map((c) => c.author.id)).toEqual([ANN, BOB])
    expect(unreadComments(t, ME, T1).map((c) => c.author.id)).toEqual([BOB])
    expect(unreadComments(t, ME, T2)).toEqual([])
  })

  it('is unread, mentioned, read or resolved per person', () => {
    const plain = thread([comment(ANN, T0)])
    expect(pinState(plain, ME, undefined)).toBe('unread')
    expect(pinState(plain, ME, T0)).toBe('read')
    expect(pinState(plain, ANN, undefined)).toBe('read') // my own thread is never unread for me

    const mention = thread([comment(ANN, T0), comment(BOB, T1, { mentions: [ME] })])
    expect(pinState(mention, ME, undefined)).toBe('mentioned')
    expect(pinState(mention, ME, T0)).toBe('mentioned')
    expect(pinState(mention, ME, T1)).toBe('read') // once read, the @ goes away
    expect(pinState(mention, ANN, T0)).toBe('unread') // Ann was not mentioned

    const resolved = thread([comment(ANN, T0, { mentions: [ME] })], { status: 'resolved', resolvedAt: T1 })
    expect(pinState(resolved, ME, undefined)).toBe('resolved')
  })
})

describe('panel filters and order', () => {
  const mine = thread([comment(ANN, T0), comment(ME, T1)])
  const mentions = thread([comment(BOB, T0, { mentions: [ME] })])
  const other = thread([comment(BOB, T2)])
  const done = thread([comment(ME, T0)], { status: 'resolved', resolvedAt: T3 })
  const all = [mine, mentions, other, done]
  const pick = (f: Parameters<typeof matchesFilter>[1]) => all.filter((t) => matchesFilter(t, f, ME))

  it('filters open / mine / mentions / resolved / all', () => {
    expect(pick('open')).toEqual([mine, mentions, other])
    expect(pick('mine')).toEqual([mine])
    expect(pick('mentions')).toEqual([mentions])
    expect(pick('resolved')).toEqual([done])
    expect(pick('all')).toHaveLength(4)
  })

  it('sorts unread first, then by latest activity', () => {
    const reads = { [mine.id]: T1, [other.id]: T2 }
    expect(sortThreads(all, ME, reads).map((t) => t.id)).toEqual([mentions.id, done.id, other.id, mine.id])
  })
})

describe('anchor geometry', () => {
  // A 200×100 shape at (1000, 500), optionally rotated 90° about its origin.
  const frame = (rotation = 0): ShapeFrame => {
    const m = Mat.Compose(Mat.Translate(1000, 500), Mat.Rotate(rotation))
    const inv = m.clone().invert()
    return {
      pageId: 'page:one',
      bounds: { x: 0, y: 0, w: 200, h: 100 },
      toPage: (p) => m.applyToPoint(p),
      toLocal: (p) => inv.applyToPoint(p),
    }
  }

  it('a shape anchor follows its shape as it moves', () => {
    const anchor = { kind: 'shape' as const, shapeId: 'shape:a', u: 0.25, v: 0.5 }
    expect(placeAnchor(anchor, () => frame())).toEqual({
      kind: 'placed',
      pageId: 'page:one',
      point: { x: 1050, y: 550 },
    })
    const moved: ShapeFrame = { ...frame(), toPage: (p) => ({ x: p.x + 1300, y: p.y - 20 }) }
    expect(placeAnchor(anchor, () => moved)).toMatchObject({ point: { x: 1350, y: -20 + 50 } })
  })

  it('keeps the same spot of a rotated shape', () => {
    const f = frame(Math.PI / 2)
    const anchor = { kind: 'shape' as const, shapeId: 'shape:a', u: 1, v: 0 }
    const placed = placeAnchor(anchor, () => f)
    if (placed.kind !== 'placed') throw new Error('expected placed')
    expect(placed.point.x).toBeCloseTo(1000)
    expect(placed.point.y).toBeCloseTo(700)
    // …and the click that created it maps back to the same (u, v).
    expect(uvFor(f, placed.point)).toEqual({ u: 1, v: 0 })
  })

  it('resizing keeps the relative position', () => {
    const anchor = { kind: 'shape' as const, shapeId: 'shape:a', u: 0.5, v: 0.5 }
    const bigger: ShapeFrame = { ...frame(), bounds: { x: 0, y: 0, w: 400, h: 300 } }
    expect(placeAnchor(anchor, () => bigger)).toMatchObject({ point: { x: 1200, y: 650 } })
  })

  it('an anchor whose shape is gone is an orphan; it re-attaches when the shape returns', () => {
    const anchor = { kind: 'shape' as const, shapeId: 'shape:a', u: 0.5, v: 0.5 }
    let present = false
    const frameOf = () => (present ? frame() : null)
    expect(placeAnchor(anchor, frameOf)).toEqual({ kind: 'orphan' })
    expect(anchorLabel(anchor, placeAnchor(anchor, frameOf), 'page:one')).toBe('On a deleted object')
    present = true
    expect(placeAnchor(anchor, frameOf).kind).toBe('placed')
  })

  it('clamps u,v and handles zero-size shapes', () => {
    const f = frame()
    expect(uvFor(f, { x: 900, y: 9000 })).toEqual({ u: 0, v: 1 })
    const flat: ShapeFrame = { ...f, bounds: { x: 0, y: 0, w: 0, h: 100 } }
    expect(uvFor(flat, { x: 1000, y: 525 })).toEqual({ u: 0.5, v: 0.25 })
  })

  it('a point anchor stays put and remembers its page', () => {
    const a = anchorForClick({ x: 12.345, y: -7 }, null, 'page:two')
    expect(a).toEqual({ kind: 'point', x: 12.35, y: -7, pageId: 'page:two' })
    const placed = placeAnchor(a, () => null)
    expect(placed).toEqual({ kind: 'placed', pageId: 'page:two', point: { x: 12.35, y: -7 } })
    expect(anchorLabel(a, placed, 'page:one')).toBe('On the board (another page)')
  })

  it('clicking a shape attaches to it; clicking a file card attaches to the file', () => {
    const f = frame()
    expect(
      anchorForClick({ x: 1100, y: 525 }, { shapeId: 'shape:n', type: 'note', frame: f }, 'page:one'),
    ).toEqual({
      kind: 'shape',
      shapeId: 'shape:n',
      u: 0.5,
      v: 0.25,
    })
    const card = {
      shapeId: 'shape:c',
      type: 'dr-file-card',
      props: { assetId: 'ast_0123456789abcdefghij', versionId: 'ver_0123456789abcdefghij' },
      frame: f,
    }
    expect(anchorForClick({ x: 1100, y: 525 }, card, 'page:one')).toEqual({
      kind: 'asset',
      shapeId: 'shape:c',
      assetId: 'ast_0123456789abcdefghij',
      versionId: 'ver_0123456789abcdefghij',
    })
    // A file card with unusable ids falls back to a plain shape anchor.
    const odd = { ...card, props: { assetId: 'javascript:alert(1)', versionId: 'x' } }
    expect(anchorForClick({ x: 1100, y: 525 }, odd, 'page:one').kind).toBe('shape')
  })
})
