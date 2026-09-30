// OWNER: 3f. The note-author labels (./note-authors.ts, CR-3F-4): what a note shows, and where Excalidraw
// would not show its bottom right corner.
import { describe, expect, it } from 'vitest'
import type { CanvasElement } from '../../../canvas/api/index.ts'
import { firstName, labelBandOf, lastEditorOf, noteAuthorsOf } from './note-authors.ts'

const by = (name: string) => ({ uid: `usr_${name.split(' ')[0]?.toLowerCase()}`, name, guest: false })

function note(
  id: string,
  at: { x: number; y: number; w?: number; h?: number; angle?: number; frameId?: string },
  text: string,
  editor: ReturnType<typeof by> | null,
): CanvasElement[] {
  const w = at.w ?? 200
  const h = at.h ?? 200
  return [
    {
      id,
      type: 'stickynote',
      x: at.x,
      y: at.y,
      width: w,
      height: h,
      angle: at.angle ?? 0,
      frameId: at.frameId ?? null,
      opacity: 100,
      boundElements: [{ type: 'text', id: `${id}-label` }],
    },
    {
      id: `${id}-label`,
      type: 'text',
      x: at.x,
      y: at.y,
      width: w,
      height: 20,
      angle: at.angle ?? 0,
      containerId: id,
      originalText: text,
      strokeColor: '#1e1e1e',
      frameId: at.frameId ?? null,
      customData: {
        lobbyServer: { createdBy: editor, createdAt: 1, lastEditedBy: editor, lastEditedAt: 1 },
      },
    },
  ] as unknown as CanvasElement[]
}

const shape = (
  id: string,
  type: string,
  box: { x: number; y: number; w: number; h: number },
  extra: Record<string, unknown> = {},
) =>
  ({
    id,
    type,
    x: box.x,
    y: box.y,
    width: box.w,
    height: box.h,
    angle: 0,
    backgroundColor: '#ffc9c9',
    fillStyle: 'solid',
    opacity: 100,
    ...extra,
  }) as unknown as CanvasElement

function authors(els: CanvasElement[], opts: { hidden?: string[]; editing?: string | null } = {}) {
  const byId = new Map(els.map((e) => [e.id, e]))
  return noteAuthorsOf(els, {
    get: (id) => byId.get(id),
    hidden: (id) => (opts.hidden ?? []).includes(id),
    editing: opts.editing ?? null,
  })
}

describe('the note-author label (CR-3F-4)', () => {
  it("shows the first name of the note's last editor, from the label's server attribution", () => {
    const list = authors(note('n1', { x: 0, y: 0 }, 'Anonymous idea', by('Alice Anders')))
    expect(list).toEqual([
      {
        id: 'n1',
        box: { x: 0, y: 0, w: 200, h: 200 },
        angle: 0,
        short: 'Alice',
        full: 'Alice Anders',
        color: '#1e1e1e',
        opacity: 1,
      },
    ])
    expect(firstName('  Bo  ')).toBe('Bo')
  })

  it('shows nothing on a note without text or without an author (an anonymous reveal)', () => {
    expect(authors(note('n1', { x: 0, y: 0 }, '  ', by('Alice')))).toEqual([])
    expect(authors(note('n1', { x: 0, y: 0 }, 'Idea', null))).toEqual([])
    expect(lastEditorOf(undefined)).toBeNull()
    expect(lastEditorOf({ customData: { lobbyServer: { lastEditedBy: { name: ' ' } } } } as never)).toBeNull()
    // a note without a label
    const [bare] = note('n1', { x: 0, y: 0 }, 'Idea', by('Alice'))
    expect(authors([{ ...bare, boundElements: [] } as unknown as CanvasElement])).toEqual([])
  })

  it('leaves out the note this tab is typing in, and a note on a collapsed branch', () => {
    const els = [
      ...note('n1', { x: 0, y: 0 }, 'One', by('Alice')),
      ...note('n2', { x: 300, y: 0 }, 'Two', by('Bob')),
    ]
    expect(authors(els, { editing: 'n1' }).map((a) => a.id)).toEqual(['n2'])
    expect(authors(els, { editing: 'n2-label' }).map((a) => a.id)).toEqual(['n1'])
    expect(authors(els, { hidden: ['n2'] }).map((a) => a.id)).toEqual(['n1'])
  })

  it('is covered by an opaque element painted above its corner, never by one below or a see-through one', () => {
    const under = note('n1', { x: 0, y: 0 }, 'Under', by('Alice'))
    // another note over the bottom right corner
    expect(
      authors([...under, ...note('n2', { x: 150, y: 150 }, 'Over', by('Bob'))]).map((a) => a.id),
    ).toEqual(['n2'])
    // the same note painted below: both labels show
    expect(
      authors([...note('n2', { x: 150, y: 150 }, 'Below', by('Bob')), ...under]).map((a) => a.id),
    ).toEqual(['n2', 'n1'])
    // over the top of the note only: the corner is free
    expect(
      authors([...under, shape('img', 'image', { x: 0, y: 0, w: 200, h: 100 })]).map((a) => a.id),
    ).toEqual(['n1'])
    expect(authors([...under, shape('img', 'image', { x: 100, y: 170, w: 50, h: 50 })])).toEqual([])
    // a filled shape covers; an unfilled or translucent one and a text do not
    const corner = { x: 120, y: 170, w: 100, h: 60 }
    expect(authors([...under, shape('r', 'rectangle', corner)])).toEqual([])
    for (const see of [
      shape('r', 'rectangle', corner, { backgroundColor: 'transparent' }),
      shape('r', 'rectangle', corner, { fillStyle: 'hachure' }),
      shape('r', 'ellipse', corner, { opacity: 50 }),
      shape('t', 'text', corner),
      shape('f', 'frame', corner),
    ])
      expect(
        authors([...under, see]).map((a) => a.id),
        see.type,
      ).toEqual(['n1'])
    // a covering element that is hidden (a collapsed branch) hides nothing
    expect(authors([...under, shape('r', 'rectangle', corner)], { hidden: ['r'] }).map((a) => a.id)).toEqual([
      'n1',
    ])
    // a huge background image painted above covers every note under it
    const huge = shape('bg', 'image', { x: -1e6, y: -1e6, w: 2e6, h: 2e6 })
    expect(authors([...under, huge])).toEqual([])
    expect(authors([huge, ...under]).map((a) => a.id)).toEqual(['n1'])
  })

  it('is left out where the note sticks out of its frame (frames clip their children)', () => {
    const frame = shape('f', 'frame', { x: -50, y: -50, w: 400, h: 400 })
    expect(authors([frame, ...note('n1', { x: 0, y: 0, frameId: 'f' }, 'In', by('Alice'))])).toHaveLength(1)
    expect(authors([frame, ...note('n1', { x: 250, y: 250, frameId: 'f' }, 'Out', by('Alice'))])).toEqual([])
  })

  it('rotates with the note: the covered corner is the rotated one', () => {
    const half = Math.PI
    // upside down, the label's corner is at the top left of the box
    const band = labelBandOf(note('n1', { x: 0, y: 0, angle: half }, 'Flip', by('Alice'))[0] as CanvasElement)
    expect(band.x).toBeCloseTo(0, 6)
    expect(band.y).toBeCloseTo(0, 6)
    expect(band.w).toBeCloseTo(120, 6)
    expect(band.h).toBeCloseTo(20, 6)
    const flipped = note('n1', { x: 0, y: 0, angle: half }, 'Flip', by('Alice'))
    expect(authors([...flipped, shape('r', 'rectangle', { x: 150, y: 150, w: 100, h: 100 })])).toHaveLength(1)
    expect(authors([...flipped, shape('r', 'rectangle', { x: -20, y: -20, w: 60, h: 30 })])).toEqual([])
    expect(authors(flipped)[0]?.angle).toBe(half)
  })
})
