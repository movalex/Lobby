// Wave M (M1-4, UXD-09 full): the selection toolbar's tier one (./style-items.ts). Per kind: what each control reads
// ('mixed' when the selection differs), and that a pick is one write (one transact: one undo step) through the style
// panel's own pick functions, counted as `selectionbar.style:<kind>`. Arrows and lines never get a geometry field.
// Text layout needs a browser, so `styles.apply` is recorded here (its relayout and the leased-label skip are
// canvas/api/parts/styles.ts's, checked by e2e/excalidraw/m1-toolbar.spec.ts), and `styles.of` is a small stand-in
// for its text fields (a container's on its label, a note label's size as its base size; ported code reaches the
// canvas only through canvas/api/index.ts).
import { afterEach, describe, expect, it } from 'vitest'
import type { CanvasElement, LobbyCanvas, StyleValues } from '../../../canvas/api/index.ts'
import { pendingUsage, resetUsageForTests } from '../../../lib/usage.ts'
import { TIER1_ITEMS, TIER1_ORDER } from './SelectionStyleItems.tsx'
import { targetOf } from './StylePanel.tsx'
import {
  pickTier,
  SELECTION_TOOLBAR_TIER1,
  type TierControl,
  type TierStyleKind,
  tierKindOf,
  tierModel,
} from './style-items.ts'

afterEach(() => resetUsageForTests())

const base = (id: string, type: string, extra: Record<string, unknown> = {}): CanvasElement =>
  ({
    id,
    type,
    x: 0,
    y: 0,
    width: 200,
    height: 120,
    angle: 0,
    strokeColor: '#1d1d1d',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roughness: 0,
    opacity: 100,
    roundness: null,
    groupIds: [],
    frameId: null,
    containerId: null,
    locked: false,
    isDeleted: false,
    boundElements: null,
    customData: undefined,
    ...extra,
  }) as unknown as CanvasElement

const note = (id: string, fill: string, size: number, align = 'center') => [
  base(id, 'stickynote', {
    backgroundColor: fill,
    strokeColor: '#1b2330',
    boundElements: [{ id: `${id}-t`, type: 'text' }],
  }),
  base(`${id}-t`, 'text', {
    containerId: id,
    strokeColor: '#1b2330',
    fontFamily: 6,
    fontSize: size,
    baseFontSize: size,
    textAlign: align,
    verticalAlign: 'middle',
  }),
]

/** `styles.of` for the fields tier one reads through it: the text fields, from a container's label. */
function stylesOf(els: readonly CanvasElement[], get: (id: string) => CanvasElement | undefined) {
  const out: Record<string, unknown> = {}
  const seen = (k: string, v: unknown) => {
    if (v === undefined) return
    if (!(k in out)) out[k] = v
    else if (out[k] !== v) out[k] = 'mixed'
  }
  for (const el of els) {
    const e = el as unknown as Record<string, unknown>
    const label = (e.boundElements as { id: string; type: string }[] | null)?.find((b) => b.type === 'text')
    const t = (e.type === 'text' ? e : label ? get(label.id) : undefined) as
      | Record<string, unknown>
      | undefined
    if (!t) continue
    seen('fontSize', (t.baseFontSize as number | undefined) ?? t.fontSize)
    seen('textAlign', t.textAlign)
  }
  return out
}

/** An in-memory canvas: tier one's reads, recorded writes. */
function kit(els: CanvasElement[], selection: string[], opts: { readOnly?: boolean } = {}) {
  const map = new Map(els.map((e) => [e.id, e]))
  const get = (id: string) => map.get(id)
  const transacts: { label: string; ops: [string, Record<string, unknown>][]; join: boolean }[] = []
  const applies: { patch: StyleValues; ids: readonly string[] }[] = []
  const canvas = {
    get,
    items: () => [...map.values()],
    selection,
    readOnly: () => opts.readOnly === true,
    tool: () => 'select',
    editingId: () => null,
    leaseHolder: () => null,
    styles: {
      of: (ids?: readonly string[]) =>
        stylesOf(
          (ids ?? selection).map(get).filter((e): e is CanvasElement => !!e),
          get,
        ),
      // the real apply is one transact (canvas/api/parts/styles.ts); recorded as one here
      apply: (patch: StyleValues, ids?: readonly string[]) => {
        applies.push({ patch, ids: ids ?? selection })
        transacts.push({
          label: 'style',
          ops: (ids ?? selection).map((id) => [id, { ...patch }]),
          join: false,
        })
      },
      next: () => ({}),
      setNext: () => {},
    },
    transact: (
      label: string,
      fn: (tx: { update(id: string, p: Record<string, unknown>): void }) => void,
      o?: { joinPrevious?: boolean },
    ) => {
      const ops: [string, Record<string, unknown>][] = []
      fn({ update: (id, p) => void ops.push([id, p]) })
      transacts.push({ label, ops, join: o?.joinPrevious === true })
    },
  }
  return { canvas: canvas as unknown as LobbyCanvas, transacts, applies }
}

const control = (controls: readonly TierControl[] | undefined, id: TierStyleKind) => {
  const c = controls?.find((x) => x.id === id)
  if (!c) throw new Error(`no control ${id}`)
  return c
}
const readValue = (k: ReturnType<typeof kit>, id: TierStyleKind, row?: string) => {
  const c = control(tierModel(k.canvas)?.controls, id)
  return (row ? c.rows.find((r) => r.id === row) : c.rows[0])?.value
}
/** One pick: exactly one undo step (one transact that does not join another), and the usage counted. */
function expectOneStep(k: ReturnType<typeof kit>, id: TierStyleKind, row: string, value: string) {
  const before = k.transacts.length
  expect(pickTier(k.canvas, id, row, value)).toBe(true)
  const steps = k.transacts.slice(before)
  expect(steps.filter((t) => !t.join)).toHaveLength(1)
  expect(pendingUsage()[`selectionbar.style:${id}`]).toBeGreaterThanOrEqual(1)
  return steps
}

describe('which selections get tier one', () => {
  it('one kind of note, text, shape, arrow or line; not mixed kinds, frames, images or drawings', () => {
    const els = [
      ...note('n1', '#f8e48f', 22),
      base('r1', 'rectangle'),
      base('a1', 'arrow'),
      base('l1', 'line'),
      base('t1', 'text', { fontSize: 24, textAlign: 'left' }),
      base('f1', 'frame'),
      base('i1', 'image'),
      base('d1', 'freedraw'),
    ]
    const kindFor = (ids: string[]) => tierKindOf(targetOf(kit(els, ids).canvas))
    expect(kindFor(['n1'])).toBe('note')
    // a note's label selected stands for its note
    expect(kindFor(['n1-t'])).toBe('note')
    expect(kindFor(['t1'])).toBe('text')
    expect(kindFor(['r1'])).toBe('shape')
    expect(kindFor(['a1'])).toBe('arrow')
    expect(kindFor(['l1'])).toBe('line')
    expect(kindFor(['n1', 'r1'])).toBeNull()
    expect(kindFor(['f1'])).toBeNull()
    expect(kindFor(['i1'])).toBeNull()
    expect(kindFor(['d1'])).toBeNull()
    expect(kindFor([])).toBeNull()
    // a frame beside a note is the style panel's rule: the frame is not styled, the note is
    expect(kindFor(['n1', 'f1'])).toBe('note')
  })

  it('people who cannot edit get none; it ends the bar’s main row, behind the kill switch', () => {
    expect(tierModel(kit(note('n1', '#f8e48f', 22), ['n1'], { readOnly: true }).canvas)).toBeNull()
    expect(
      pickTier(
        kit(note('n1', '#f8e48f', 22), ['n1'], { readOnly: true }).canvas,
        'note-colour',
        'note-colour',
        'blue',
      ),
    ).toBe(false)
    expect(SELECTION_TOOLBAR_TIER1).toBe(true)
    expect(TIER1_ITEMS.map((i) => [i.id, i.order])).toEqual([['canvas-ux.style', TIER1_ORDER]])
    // the main row's last (after AI, 80), before the arrange row (100): Alt+F10 still lands on Copy link (10)
    expect(TIER1_ORDER).toBeGreaterThan(80)
    expect(TIER1_ORDER).toBeLessThan(100)
  })
})

describe('notes: colour, size, alignment', () => {
  const two = (a: string, b: string, sa = 22, sb = 22, al = 'center', bl = 'center') =>
    kit([...note('n1', a, sa, al), ...note('n2', b, sb, bl)], ['n1', 'n2'])

  it('the controls, with the note palette’s names; mixed values read mixed', () => {
    const same = two('#f8e48f', '#f8e48f')
    const c = tierModel(same.canvas)
    expect(c?.kind).toBe('note')
    expect(c?.controls.map((x) => x.id)).toEqual(['note-colour', 'font-size', 'text-align'])
    const colour = control(c?.controls, 'note-colour')
    expect(colour.rows[0]?.options).toHaveLength(13)
    expect(colour.rows[0]?.options[0]).toMatchObject({ value: 'black', label: 'Butter', color: '#f8e48f' })
    expect(readValue(same, 'note-colour')).toBe('black')
    expect(readValue(same, 'font-size')).toBe('m')
    expect(readValue(same, 'text-align')).toBe('center')
    const mixed = two('#f8e48f', '#a6d8f3', 22, 32, 'center', 'left')
    expect(readValue(mixed, 'note-colour')).toBe('mixed')
    expect(readValue(mixed, 'font-size')).toBe('mixed')
    expect(readValue(mixed, 'text-align')).toBe('mixed')
    // a fill outside the palette is none of the swatches
    expect(readValue(two('#b2f2bb', '#b2f2bb'), 'note-colour')).toBeNull()
  })

  it('a colour pick is one transact on both notes (their fills only)', () => {
    const k = two('#f8e48f', '#a6d8f3')
    const [step] = expectOneStep(k, 'note-colour', 'note-colour', 'light-red')
    expect(step?.ops).toEqual([
      ['n1', { backgroundColor: '#f6bfc4' }],
      ['n2', { backgroundColor: '#f6bfc4' }],
    ])
  })

  it('a size pick is one styles.apply of the label size on the notes (it lays the words out, skips a leased label)', () => {
    const k = two('#f8e48f', '#a6d8f3', 22, 32)
    expectOneStep(k, 'font-size', 'font-size', 'xl')
    expect(k.applies).toEqual([{ patch: { fontSize: 32 }, ids: ['n1', 'n2'] }])
  })

  it('an alignment pick is one styles.apply on the notes', () => {
    const k = two('#f8e48f', '#a6d8f3')
    expectOneStep(k, 'text-align', 'text-align', 'left')
    expect(k.applies).toEqual([{ patch: { textAlign: 'left' }, ids: ['n1', 'n2'] }])
  })

  it('a value that is not the control’s writes nothing', () => {
    const k = two('#f8e48f', '#a6d8f3')
    expect(pickTier(k.canvas, 'note-colour', 'note-colour', '#ff0000')).toBe(false)
    expect(pickTier(k.canvas, 'fill', 'fill', 'solid')).toBe(false)
    expect(k.transacts).toEqual([])
    expect(pendingUsage()).toEqual({})
  })
})

describe('shapes: colour, fill, stroke width and style, opacity', () => {
  const two = (a: Record<string, unknown>, b: Record<string, unknown>) =>
    kit([base('r1', 'rectangle', a), base('r2', 'ellipse', b)], ['r1', 'r2'])

  it('mixed values read mixed, per control', () => {
    const k = two(
      { strokeColor: '#4465e9', backgroundColor: '#dce1f8', strokeWidth: 2, opacity: 100 },
      {
        strokeColor: '#e03131',
        backgroundColor: 'transparent',
        strokeWidth: 4,
        strokeStyle: 'dashed',
        opacity: 50,
      },
    )
    expect(tierModel(k.canvas)?.controls.map((c) => c.id)).toEqual([
      'stroke-colour',
      'fill',
      'stroke-width',
      'stroke-style',
      'opacity',
    ])
    for (const id of ['stroke-colour', 'fill', 'stroke-width', 'stroke-style', 'opacity'] as const)
      expect(readValue(k, id), id).toBe('mixed')
    const same = two(
      { strokeColor: '#4465e9', backgroundColor: '#dce1f8' },
      { strokeColor: '#4465e9', backgroundColor: '#dce1f8' },
    )
    expect(readValue(same, 'stroke-colour')).toBe('blue')
    expect(readValue(same, 'fill')).toBe('solid')
    expect(readValue(same, 'stroke-width')).toBe('m')
    expect(readValue(same, 'stroke-style')).toBe('solid')
    expect(readValue(same, 'opacity')).toBe('100')
  })

  it('each pick is one transact: a colour keeps each shape’s fill kind in the new colour', () => {
    const k = two({ strokeColor: '#4465e9', backgroundColor: '#dce1f8' }, { strokeColor: '#4465e9' })
    const [colour] = expectOneStep(k, 'stroke-colour', 'stroke-colour', 'red')
    expect(colour?.ops).toEqual([
      ['r1', { strokeColor: '#e03131', backgroundColor: '#f4dadb' }],
      ['r2', { strokeColor: '#e03131' }],
    ])
    const [fill] = expectOneStep(k, 'fill', 'fill', 'pattern')
    expect(fill?.ops.map(([id]) => id)).toEqual(['r1', 'r2'])
    const [width] = expectOneStep(k, 'stroke-width', 'stroke-width', 'xl')
    expect(width?.ops).toEqual([
      ['r1', { strokeWidth: 8 }],
      ['r2', { strokeWidth: 8 }],
    ])
    const [dash] = expectOneStep(k, 'stroke-style', 'stroke-style', 'dotted')
    expect(dash?.ops[0]).toEqual(['r1', { strokeStyle: 'dotted', roughness: 0 }])
    const [opacity] = expectOneStep(k, 'opacity', 'opacity', '50')
    expect(opacity?.ops).toEqual([
      ['r1', { opacity: 50 }],
      ['r2', { opacity: 50 }],
    ])
  })
})

describe('arrows and lines: colour, stroke width and style, arrowheads; never geometry', () => {
  const GEOMETRY = [
    'x',
    'y',
    'points',
    'width',
    'height',
    'angle',
    'fixedSegments',
    'startIsSpecial',
    'endIsSpecial',
    'elbowed',
    'polygon',
    'roundness',
    'startBinding',
    'endBinding',
  ]
  const arrows = () =>
    kit(
      [
        base('a1', 'arrow', {
          startArrowhead: null,
          endArrowhead: 'arrow',
          points: [
            [0, 0],
            [200, 0],
          ],
        }),
        base('a2', 'arrow', {
          startArrowhead: 'dot',
          endArrowhead: 'arrow',
          strokeWidth: 4,
          points: [
            [0, 0],
            [0, 90],
          ],
        }),
      ],
      ['a1', 'a2'],
    )

  it('an arrow has the arrowheads (two rows); a line has none; mixed reads mixed', () => {
    const k = arrows()
    expect(tierModel(k.canvas)?.controls.map((c) => c.id)).toEqual([
      'stroke-colour',
      'stroke-width',
      'stroke-style',
      'arrowheads',
    ])
    expect(control(tierModel(k.canvas)?.controls, 'arrowheads').rows.map((r) => r.id)).toEqual([
      'start',
      'end',
    ])
    expect(readValue(k, 'arrowheads', 'start')).toBe('mixed')
    expect(readValue(k, 'arrowheads', 'end')).toBe('arrow')
    expect(readValue(k, 'stroke-width')).toBe('mixed')
    const line = kit([base('l1', 'line'), base('l2', 'line')], ['l1', 'l2'])
    expect(tierModel(line.canvas)?.controls.map((c) => c.id)).toEqual([
      'stroke-colour',
      'stroke-width',
      'stroke-style',
    ])
  })

  it('every pick is one transact of style fields only (no point moves: the geometry unit rule is untouched)', () => {
    const k = arrows()
    const steps = [
      ...expectOneStep(k, 'stroke-colour', 'stroke-colour', 'green'),
      ...expectOneStep(k, 'stroke-width', 'stroke-width', 'l'),
      ...expectOneStep(k, 'stroke-style', 'stroke-style', 'dashed'),
      ...expectOneStep(k, 'arrowheads', 'start', 'triangle'),
      ...expectOneStep(k, 'arrowheads', 'end', 'none'),
    ]
    const written = new Set(steps.flatMap((s) => s.ops.flatMap(([, p]) => Object.keys(p))))
    for (const f of GEOMETRY) expect(written.has(f), f).toBe(false)
    expect([...written].sort()).toEqual(
      ['endArrowhead', 'roughness', 'startArrowhead', 'strokeColor', 'strokeStyle', 'strokeWidth'].sort(),
    )
    expect(steps[3]?.ops).toEqual([
      ['a1', { startArrowhead: 'triangle' }],
      ['a2', { startArrowhead: 'triangle' }],
    ])
  })
})

describe('text: size, alignment, colour', () => {
  const two = (a: Record<string, unknown>, b: Record<string, unknown>) =>
    kit([base('t1', 'text', a), base('t2', 'text', b)], ['t1', 't2'])

  it('mixed values read mixed; size and alignment are styles.apply, colour one transact', () => {
    const k = two(
      { fontSize: 24, textAlign: 'left', strokeColor: '#1d1d1d' },
      { fontSize: 44, textAlign: 'center', strokeColor: '#e03131' },
    )
    expect(tierModel(k.canvas)?.controls.map((c) => c.id)).toEqual(['font-size', 'text-align', 'text-colour'])
    expect(readValue(k, 'font-size')).toBe('mixed')
    expect(readValue(k, 'text-align')).toBe('mixed')
    expect(readValue(k, 'text-colour')).toBe('mixed')
    expectOneStep(k, 'font-size', 'font-size', 's')
    expectOneStep(k, 'text-align', 'text-align', 'right')
    expect(k.applies).toEqual([
      { patch: { fontSize: 18 }, ids: ['t1', 't2'] },
      { patch: { textAlign: 'right' }, ids: ['t1', 't2'] },
    ])
    const [colour] = expectOneStep(k, 'text-colour', 'text-colour', 'violet')
    expect(colour?.ops).toEqual([
      ['t1', { strokeColor: '#ae3ec9' }],
      ['t2', { strokeColor: '#ae3ec9' }],
    ])
    const same = two({ fontSize: 36, textAlign: 'center' }, { fontSize: 36, textAlign: 'center' })
    expect(readValue(same, 'font-size')).toBe('l')
    expect(readValue(same, 'text-align')).toBe('center')
  })
})
