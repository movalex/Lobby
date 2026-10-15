// Wave Q (the foundation; OWNER: WS2 after it): a selection as a library item's elements (./library.ts). Item-local
// ids, the box at (0, 0), what a copy takes along, nothing identity- or board-bound, never an inline URL, every element
// valid as the room checks it, the item's limits, and the input untouched.
import { checkElement, type WireElement } from '@draftroom/canvas-schema/elements'
import { checkInvariants } from '@draftroom/canvas-schema/invariants'
import { describe, expect, it } from 'vitest'
import { itemBoundsOf, itemBoxOf, type LibraryItemLimits, serializeLibraryItem } from './library.ts'
import type { BoardElement } from './read.ts'
import { sampleBoard, seqIds } from './test-kit.ts'

/** @draftroom/contracts LIBRARY_LIMITS as the callers pass them (the web test compares the two). */
const LIMITS: LibraryItemLimits = { maxElements: 500, maxBytes: 262_144, maxImages: 20, maxNameChars: 80 }

type El = Record<string, unknown>
const byId = (els: readonly WireElement[]) => new Map(els.map((e) => [e.id, e as unknown as El]))
const pick = (board: WireElement[], ...ids: string[]) => board.filter((e) => ids.includes(e.id))
const lobbyOf = (e: El | undefined) => (e?.customData as { lobby?: El } | undefined)?.lobby

function serialize(selected: WireElement[], scene?: WireElement[], limits: Partial<LibraryItemLimits> = {}) {
  const r = serializeLibraryItem(selected, {
    ...(scene ? { scene } : {}),
    limits: { ...LIMITS, ...limits },
    newId: seqIds('i'),
    now: 5,
  })
  return r
}

function ok(r: ReturnType<typeof serialize>) {
  if (!r.ok) throw new Error(`expected an item, got ${r.problem}`)
  return r.item
}

describe('serializeLibraryItem', () => {
  it('re-keys to item-local ids with the box at (0, 0), and takes the selected containers’ labels along', () => {
    const board = sampleBoard()
    const item = ok(serialize(pick(board, 'R', 'A', 'E'), board))
    // R, its label, A and E; ids and groups are the item's own
    expect(item.elementCount).toBe(4)
    expect(item.elements.map((e) => e.id).sort()).toEqual(['i1', 'i2', 'i3', 'i4'])
    const types = item.elements.map((e) => e.type).sort()
    expect(types).toEqual(['arrow', 'ellipse', 'rectangle', 'text'])
    // R starts the box (300, 100) → (0, 0); E ends it at 900 - 300
    const els = item.elements as unknown as El[]
    expect(Math.min(...els.map((e) => e.x as number))).toBe(0)
    expect(Math.min(...els.map((e) => e.y as number))).toBe(0)
    expect(item.width).toBe(600)
    expect(item.height).toBe(100)
    // the arrow still binds the box and the ellipse, both ways; the frame was not selected: cut
    const rect = els.find((e) => e.type === 'rectangle') as El
    const arrow = els.find((e) => e.type === 'arrow') as El
    const ellipse = els.find((e) => e.type === 'ellipse') as El
    expect((arrow.startBinding as El).elementId).toBe(rect.id)
    expect((arrow.endBinding as El).elementId).toBe(ellipse.id)
    expect(rect.boundElements).toEqual(
      expect.arrayContaining([
        { id: arrow.id, type: 'arrow' },
        { id: (els.find((e) => e.type === 'text') as El).id, type: 'text' },
      ]),
    )
    for (const e of els) expect(e.frameId).toBeNull()
    expect(item.cut.frames).toBe(4)
    // the server-owned fields restart; every element is what the room takes, and the set is consistent
    for (const e of els) {
      expect(e.version).toBe(1)
      expect(e.updated).toBe(5)
      expect(checkElement(e).ok, String(e.type)).toBe(true)
    }
    expect(checkInvariants(item.elements)).toEqual([])
    expect(item.files).toEqual([])
    expect(item.imageCount).toBe(0)
  })

  it('a selected frame brings its children and their labels; nothing identity- or board-bound is kept', () => {
    const board = sampleBoard()
    const item = ok(serialize(pick(board, 'F'), board))
    // F, N + label, R + label, E, A, T
    expect(item.elementCount).toBe(8)
    const els = item.elements as unknown as El[]
    const frame = els.find((e) => e.type === 'frame') as El
    for (const e of els) if (e !== frame) expect(e.frameId, String(e.type)).toBe(frame.id)
    for (const e of els) {
      const cd = e.customData as El | undefined
      expect(cd?.lobbyServer, String(e.type)).toBeUndefined()
      const lobby = lobbyOf(e) ?? {}
      for (const key of Object.keys(lobby)) {
        expect(key.startsWith('tag:'), key).toBe(false)
        expect(key.startsWith('plusOne:'), key).toBe(false)
        expect(key, key).not.toBe('ai')
      }
      // unlocked: the insert decides locking (T was locked on the board)
      expect(e.locked).toBe(false)
      expect('status' in e).toBe(false)
    }
    // the frame keeps its place in no presentation; the card keeps its kind; the mind map points at the copies
    expect(lobbyOf(frame)).toBeUndefined()
    const note = els.find((e) => e.type === 'stickynote') as El
    expect(lobbyOf(note)?.mindmap).toEqual({
      rootId: note.id,
      parentId: null,
      side: 'right',
      collapsed: false,
    })
    expect(lobbyOf(els.find((e) => e.type === 'rectangle'))?.kind).toBe('card')
    // tag:research, plusOne and ai (count only)
    expect(item.cut.customData).toBe(3)
    expect(checkInvariants(item.elements)).toEqual([])
    // the first words in reading order: the box's label sits higher than the note's
    expect(item.suggestedName).toBe('=Launch plan')
  })

  it('collects the versions an image shows, keeps its file facts and its group', () => {
    const board = sampleBoard()
    const item = ok(serialize(pick(board, 'I', 'D')))
    expect(item.files).toEqual([{ versionId: 'ver_0123456789abcdef', assetId: 'ast_0123456789abcdef' }])
    expect(item.imageCount).toBe(1)
    const els = byId(item.elements)
    const image = [...els.values()].find((e) => e.type === 'image') as El
    expect(image.fileId).toBe('ver_0123456789abcdef')
    expect((lobbyOf(image)?.file as El | undefined)?.versionId).toBe('ver_0123456789abcdef')
    const groups = new Set([...els.values()].map((e) => (e.groupIds as string[]).join()))
    expect(groups.size).toBe(1)
    expect([...groups][0]).not.toBe('G1')
    // no text, no frame: no suggested name
    expect(item.suggestedName).toBeNull()
  })

  it('never stores a data: or blob: URL: in a link, a fileId or anywhere in customData', () => {
    const board = sampleBoard()
    const rect = pick(board, 'E')[0] as unknown as El
    const image = pick(board, 'I')[0] as unknown as El
    const cases: El[] = [
      { ...rect, link: 'data:text/html,<script>1</script>' },
      { ...rect, link: ' BLOB:https://lobby.example/uuid' },
      { ...image, fileId: 'data:image/png;base64,AAAA' },
      { ...image, customData: { lobby: { alt: 'blob:https://x/y' } } },
      { ...rect, customData: { lobby: { deep: { deeper: ['data:x'] } } } },
    ]
    for (const el of cases) {
      const r = serialize([el as unknown as WireElement])
      expect(r, JSON.stringify(el).slice(0, 80)).toEqual({ ok: false, problem: 'inline-data', count: 1 })
    }
  })

  it('refuses types no board holds; an unknown customData key is dropped, not stored', () => {
    const board = sampleBoard()
    const rect = pick(board, 'E')[0] as unknown as El
    expect(serialize([{ ...rect, type: 'embeddable' } as unknown as WireElement])).toMatchObject({
      ok: false,
      problem: 'refused-type',
    })
    expect(serialize([{ ...rect, type: 'iframe' } as unknown as WireElement])).toMatchObject({
      problem: 'refused-type',
    })
    expect(serialize([{ ...rect, type: 'widget' } as unknown as WireElement])).toMatchObject({
      problem: 'unknown-type',
    })
    const item = ok(serialize([{ ...rect, customData: { lobby: { mystery: 1 } } } as unknown as WireElement]))
    expect(lobbyOf(item.elements[0] as unknown as El)).toBeUndefined()
    // an element the room would refuse is refused here too
    const bad = { ...rect, strokeWidth: -3 } as unknown as WireElement
    expect(serialize([bad])).toEqual({ ok: false, problem: 'invalid', count: 1 })
  })

  it('holds the item to its limits: elements, bytes and images', () => {
    const board = sampleBoard()
    expect(serialize(pick(board, 'R', 'E'), board, { maxElements: 2 })).toEqual({
      ok: false,
      problem: 'too-many-elements',
      count: 3,
    })
    const big = serialize(pick(board, 'R', 'E'), board, { maxBytes: 100 })
    expect(big).toMatchObject({ ok: false, problem: 'too-large' })
    expect(serialize(pick(board, 'I'), undefined, { maxImages: 0 })).toEqual({
      ok: false,
      problem: 'too-many-images',
      count: 1,
    })
    const item = ok(serialize(pick(board, 'R', 'E'), board))
    expect(item.bytes).toBe(new TextEncoder().encode(JSON.stringify(item.elements)).length)
  })

  it('an empty or deleted selection is "empty"; a long first line is cut to the name limit', () => {
    const board = sampleBoard()
    expect(serialize([])).toEqual({ ok: false, problem: 'empty', count: 0 })
    expect(serialize(pick(board, 'X'))).toEqual({ ok: false, problem: 'empty', count: 0 })
    const t = pick(board, 'T')[0] as unknown as El
    const words = 'a'.repeat(100)
    const long = { ...t, text: words, originalText: words } as unknown as WireElement
    const item = ok(serialize([long], undefined, { maxNameChars: 10 }))
    expect(item.suggestedName).toBe(`${'a'.repeat(9)}…`)
  })

  it('never changes its input', () => {
    const board = sampleBoard()
    const before = structuredClone(board)
    ok(serialize(pick(board, 'F', 'I', 'D'), board))
    expect(board).toEqual(before)
  })
})

describe('the item box', () => {
  it('follows a line’s points (they may run left of its x) and a rotation about the box centre', () => {
    const line = {
      id: 'l',
      type: 'line',
      x: 100,
      y: 100,
      width: 50,
      height: 20,
      angle: 0,
      points: [
        [0, 0],
        [-50, 20],
      ],
    }
    expect(itemBoxOf(line as unknown as BoardElement)).toEqual({ x: 50, y: 100, w: 50, h: 20 })
    const turned = { id: 'r', type: 'rectangle', x: 0, y: 0, width: 100, height: 20, angle: Math.PI / 2 }
    const b = itemBoxOf(turned as unknown as BoardElement)
    expect(b.w).toBeCloseTo(20)
    expect(b.h).toBeCloseTo(100)
    expect(b.x).toBeCloseTo(40)
    expect(b.y).toBeCloseTo(-40)
    expect(itemBoundsOf([])).toBeNull()
  })
})
