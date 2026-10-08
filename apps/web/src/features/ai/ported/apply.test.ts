// The ported AI apply and target code on a small in-memory canvas (the LobbyCanvas members they use).
import { describe, expect, it } from 'vitest'
import type { CanvasElement, LobbyCanvas } from '../../../canvas/api/index.ts'
import { aiCustomData, aiKindOf, applyNotes, applySummary, applyThemes, wrapLines } from './apply.ts'
import { idOfRef, refOf, selectionTarget, targetAt } from './target.ts'

type El = Record<string, unknown> & {
  id: string
  type: string
  x: number
  y: number
  width: number
  height: number
}

/** 10 px per character, 20 px per line: easy to reason about. */
const measure = (text: string, style: { fontSize: number }) => {
  const lines = text.split('\n')
  return { width: Math.max(...lines.map((l) => l.length)) * 10, height: lines.length * style.fontSize * 1.25 }
}

function fakeCanvas(seed: El[]) {
  const els = new Map<string, El>(
    seed.map((e) => [e.id, { frameId: null, groupIds: [], isDeleted: false, ...e }]),
  )
  let selection: string[] = []
  const steps: string[] = []
  const live = () => [...els.values()].filter((e) => !e.isDeleted)
  const labelOf = (e: El) =>
    ((e.boundElements as { id: string; type: string }[] | null) ?? []).find((b) => b.type === 'text')?.id
  const canvas = {
    items: () => live() as unknown as CanvasElement[],
    get: (id: string) => els.get(id) as unknown as CanvasElement | undefined,
    bounds: (id: string) => {
      const e = els.get(id)
      return e ? { x: e.x, y: e.y, width: e.width, height: e.height } : null
    },
    boundsOf: (ids: readonly string[]) => {
      const bs = ids.map((id) => els.get(id)).filter((e): e is El => !!e)
      if (!bs.length) return null
      const x = Math.min(...bs.map((e) => e.x))
      const y = Math.min(...bs.map((e) => e.y))
      return {
        x,
        y,
        width: Math.max(...bs.map((e) => e.x + e.width)) - x,
        height: Math.max(...bs.map((e) => e.y + e.height)) - y,
      }
    },
    isLocked: (id: string) => els.get(id)?.locked === true,
    isHidden: () => false,
    readOnly: () => false,
    get selection() {
      return selection
    },
    select: (ids: readonly string[]) => {
      selection = [...ids]
    },
    viewport: {
      get: () => ({ x: -500, y: -500, width: 4000, height: 3000, zoom: 1 }),
      zoomTo: () => {},
    },
    text: {
      of: (id: string) => {
        const e = els.get(id)
        if (!e) return ''
        if (e.type === 'text') return String(e.originalText ?? '')
        if (e.type === 'frame') return String(e.name ?? '')
        const l = labelOf(e)
        return l ? String(els.get(l)?.originalText ?? '') : ''
      },
      measure,
    },
    transact<T>(label: string, fn: (tx: unknown) => T, opts?: { joinPrevious?: boolean }): T {
      steps.push(opts?.joinPrevious ? `${label} (joined)` : label)
      const tx = {
        create(kind: string, props: Record<string, unknown>) {
          const id = String(props.id)
          if (kind === 'note') {
            const size = Number(props.size ?? 200)
            const labelId = String(props.labelId ?? `${id}.t`)
            els.set(id, {
              ...props,
              id,
              type: 'stickynote',
              x: Number(props.x),
              y: Number(props.y),
              width: size,
              height: size,
              frameId: null,
              boundElements: props.text ? [{ id: labelId, type: 'text' }] : null,
            })
            if (props.text)
              els.set(labelId, {
                id: labelId,
                type: 'text',
                containerId: id,
                originalText: props.text,
                x: Number(props.x) + 10,
                y: Number(props.y) + 90,
                width: size - 20,
                height: 20,
                frameId: null,
              })
            return id
          }
          const m =
            kind === 'text'
              ? measure(String(props.text ?? ''), { fontSize: Number(props.fontSize ?? 20) })
              : null
          els.set(id, {
            width: m?.width ?? 100,
            height: m?.height ?? 100,
            ...props,
            id,
            type: kind,
            x: Number(props.x),
            y: Number(props.y),
          } as El)
          return id
        },
        update(id: string, patch: Record<string, unknown>) {
          const e = els.get(id)
          if (!e) throw new Error(`no ${id}`)
          els.set(id, { ...e, ...patch })
        },
        delete(id: string) {
          const e = els.get(id)
          if (e) els.set(id, { ...e, isDeleted: true })
        },
        setFrame(ids: readonly string[], frameId: string | null) {
          for (const id of ids) {
            const e = els.get(id)
            if (!e) continue
            els.set(id, { ...e, frameId })
            const l = labelOf(e)
            if (l) els.set(l, { ...(els.get(l) as El), frameId })
          }
        },
      }
      return fn(tx)
    },
  }
  return { canvas: canvas as unknown as LobbyCanvas, els, steps }
}

const note = (id: string, x: number, y: number, text: string, extra: Record<string, unknown> = {}): El[] => [
  {
    id,
    type: 'stickynote',
    x,
    y,
    width: 200,
    height: 200,
    boundElements: [{ id: `${id}.t`, type: 'text' }],
    ...extra,
  },
  {
    id: `${id}.t`,
    type: 'text',
    containerId: id,
    originalText: text,
    x: x + 10,
    y: y + 90,
    width: 180,
    height: 20,
    frameId: (extra.frameId as string | undefined) ?? null,
  },
]

const overlap = (a: El, b: El) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

describe('the ported AI helpers', () => {
  it('wraps words to a width and cuts a word longer than a line', () => {
    const m = (l: string) => l.length * 10
    expect(wrapLines(m, 'one two three four', 90)).toEqual(['one two', 'three', 'four'])
    expect(wrapLines(m, 'abcdefghijkl', 50)).toEqual(['abcde', 'fghij', 'kl'])
    expect(wrapLines(m, 'a\nb c', null)).toEqual(['a', 'b c'])
  })

  it('stamps what AI made and reads it back', () => {
    const el = { id: 'x', customData: aiCustomData('usr_1', 'idea') } as unknown as CanvasElement
    expect(el.customData?.lobby).toEqual({ ai: { by: 'usr_1' }, kind: 'ai-idea' })
    expect(aiKindOf(el)).toBe('idea')
    expect(
      aiKindOf({ id: 'y', customData: { lobby: { kind: 'ai-idea' } } } as unknown as CanvasElement),
    ).toBeNull()
    expect(refOf('abc')).toBe('shape:abc')
    expect(idOfRef('shape:abc')).toBe('abc')
  })

  it('a target counts notes, prompt notes and texts; a selected label stands for its note', () => {
    const { canvas } = fakeCanvas([
      ...note('a', 0, 0, 'One'),
      ...note('b', 300, 0, 'Two'),
      ...note('p', 600, 0, 'A prompt?', { customData: { lobby: { prompt: true } } }),
      { id: 't', type: 'text', originalText: 'free words', x: 0, y: 400, width: 100, height: 20 },
    ])
    canvas.select(['a.t', 'b', 'p', 't'])
    const t = selectionTarget(canvas)
    expect(t?.ids.sort()).toEqual(['a', 'b', 'p', 't'])
    expect([t?.notes, t?.prompts, t?.texts]).toEqual([2, 1, 4])
    expect(t?.label).toBe('4 selected items')
    canvas.select([])
    expect(targetAt(canvas, { x: 10, y: 10 }).kind).toBe('none')
  })

  it('a frame under the point is the target when nothing is selected; its boxes are existing groups', () => {
    const { canvas } = fakeCanvas([
      { id: 'f', type: 'frame', name: 'Ideas', x: 0, y: 0, width: 1200, height: 800 },
      ...note('a', 40, 100, 'One', { frameId: 'f' }),
      ...note('b', 300, 100, 'Two', { frameId: 'f' }),
      {
        id: 'g1',
        type: 'rectangle',
        x: 600,
        y: 100,
        width: 200,
        height: 60,
        frameId: 'f',
        boundElements: [{ id: 'g1.t', type: 'text' }],
      },
      {
        id: 'g1.t',
        type: 'text',
        containerId: 'g1',
        originalText: 'Gameplay',
        x: 610,
        y: 110,
        width: 80,
        height: 20,
        frameId: 'f',
      },
      {
        id: 'g2',
        type: 'rectangle',
        x: 600,
        y: 300,
        width: 200,
        height: 60,
        frameId: 'f',
        boundElements: [{ id: 'g2.t', type: 'text' }],
      },
      {
        id: 'g2.t',
        type: 'text',
        containerId: 'g2',
        originalText: 'Story',
        x: 610,
        y: 310,
        width: 80,
        height: 20,
        frameId: 'f',
      },
    ])
    const t = targetAt(canvas, { x: 50, y: 50 })
    expect(t.kind).toBe('frame')
    expect(t.label).toBe('the frame “Ideas”')
    expect(t.notes).toBe(2)
    expect(t.groups).toEqual(['Gameplay', 'Story'])
  })

  it('ideas land in the target’s frame as one step: a heading and notes, stamped, frame membership on note and label', () => {
    const { canvas, els, steps } = fakeCanvas([
      { id: 'f', type: 'frame', name: 'Ideas', x: 1000, y: 0, width: 1200, height: 800 },
      ...note('a', 1040, 100, 'One', { frameId: 'f' }),
    ])
    canvas.select(['a'])
    const target = selectionTarget(canvas)
    if (!target) throw new Error('no target')
    const ids = applyNotes(
      canvas,
      target,
      { heading: 'Ideas: x', texts: ['p', 'q', 'r'], color: 'yellow', kind: 'idea' },
      'usr_1',
    )
    // one undo step: the notes join their frame as a derived write of it
    expect(steps).toEqual(['ai: generate ideas', 'ai: generate ideas (joined)'])
    expect(ids).toHaveLength(4)
    const made = ids.map((id) => els.get(id) as El)
    expect(made.map((e) => aiKindOf(e as unknown as CanvasElement))).toEqual([
      'heading',
      'idea',
      'idea',
      'idea',
    ])
    for (const e of made) {
      expect(e.frameId).toBe('f')
      expect(e.x).toBeGreaterThanOrEqual(1000)
      expect(e.x + e.width).toBeLessThanOrEqual(2200)
      expect(overlap(e, els.get('a') as El)).toBe(false)
      expect((e.customData as { lobby: { ai: { by: string } } }).lobby.ai.by).toBe('usr_1')
    }
    for (const n of made.slice(1)) expect(els.get(`${n.id}.t`)?.frameId).toBe('f')
    expect(canvas.selection).toEqual(ids)
  })

  it('a summary is a card with its words as the bound label, "Summary" first', () => {
    const { canvas, els } = fakeCanvas([...note('a', 0, 0, 'One')])
    canvas.select(['a'])
    const target = selectionTarget(canvas)
    if (!target) throw new Error('no target')
    const [card] = applySummary(canvas, target, 'First point.\n\nSecond point.', 'usr_1')
    const c = els.get(card as string) as El
    expect(c.type).toBe('rectangle')
    expect(c.boundElements).toEqual([{ id: `${card}.t`, type: 'text' }])
    const label = els.get(`${card}.t`) as El
    expect(label.containerId).toBe(card)
    expect(label.originalText).toBe('Summary\nFirst point.\nSecond point.')
    expect(label.x).toBe(c.x + 5)
    expect(c.height).toBeGreaterThanOrEqual(120)
    expect(overlap(c, els.get('a') as El)).toBe(false)
  })

  it('themes: labelled clusters in the frame in one step, notes move with their labels; grouping again replaces the labels', () => {
    const { canvas, els, steps } = fakeCanvas([
      { id: 'f', type: 'frame', name: 'Ideas', x: 0, y: 0, width: 1600, height: 1000 },
      ...note('a', 60, 100, 'One', { frameId: 'f' }),
      ...note('b', 300, 100, 'Two', { frameId: 'f' }),
      ...note('c', 540, 100, 'Three', { frameId: 'f' }),
      ...note('d', 780, 100, 'Four', { frameId: 'f' }),
    ])
    const themes = [
      { name: 'Odd', noteIds: ['shape:a', 'shape:c'] },
      { name: 'Even', noteIds: ['shape:b', 'shape:d', 'shape:gone'] },
    ]
    const out = applyThemes(canvas, themes, 'usr_1')
    expect(steps).toEqual(['ai: group into themes'])
    expect(out).toMatchObject({ moved: 4, themes: 2, skipped: 1 })
    const labels = [...els.values()].filter(
      (e) => !e.isDeleted && aiKindOf(e as unknown as CanvasElement) === 'theme-label',
    )
    expect(labels.map((l) => l.originalText).sort()).toEqual(['Even', 'Odd'])
    for (const id of ['a', 'b', 'c', 'd']) {
      const n = els.get(id) as El
      const l = els.get(`${id}.t`) as El
      expect([l.x - n.x, l.y - n.y]).toEqual([10, 90])
      expect(n.frameId).toBe('f')
    }
    const placed = [...labels, ...['a', 'b', 'c', 'd'].map((id) => els.get(id) as El)]
    for (let i = 0; i < placed.length; i++)
      for (let j = i + 1; j < placed.length; j++)
        expect(overlap(placed[i] as El, placed[j] as El)).toBe(false)
    const at = () =>
      Object.fromEntries(['a', 'b', 'c', 'd'].map((id) => [id, [els.get(id)?.x, els.get(id)?.y]]))
    const first = at()
    expect(canvas.selection).toEqual([])
    applyThemes(canvas, themes, 'usr_1')
    const again = [...els.values()].filter(
      (e) => !e.isDeleted && aiKindOf(e as unknown as CanvasElement) === 'theme-label',
    )
    expect(again).toHaveLength(2)
    expect(at()).toEqual(first)
  })
})

describe('W5-04: frame membership read from where notes lie when it is mixed or missing', () => {
  const frame = (id: string, x: number, y: number, width: number, height: number, extra = {}): El => ({
    id,
    type: 'frame',
    name: id.toUpperCase(),
    x,
    y,
    width,
    height,
    ...extra,
  })
  const box = (id: string, x: number, y: number, text: string, frameId: string): El[] => [
    {
      id,
      type: 'rectangle',
      x,
      y,
      width: 200,
      height: 60,
      frameId,
      boundElements: [{ id: `${id}.t`, type: 'text' }],
    },
    {
      id: `${id}.t`,
      type: 'text',
      containerId: id,
      originalText: text,
      x: x + 10,
      y: y + 20,
      width: 80,
      height: 20,
      frameId,
    },
  ]
  const labelsOf = (els: Map<string, El>) =>
    [...els.values()].filter((e) => !e.isDeleted && aiKindOf(e as unknown as CanvasElement) === 'theme-label')
  const within = (outer: El, e: El) =>
    e.x >= outer.x &&
    e.y >= outer.y &&
    e.x + e.width <= outer.x + outer.width &&
    e.y + e.height <= outer.y + outer.height

  it('a note made with N inside the frame (no frameId) joins the others there: nobody leaves the frame, and the frame grows to fit', () => {
    const { canvas, els } = fakeCanvas([
      frame('f', 0, 0, 900, 400),
      ...note('a', 60, 100, 'One', { frameId: 'f' }),
      ...note('b', 300, 100, 'Two', { frameId: 'f' }),
      ...note('c', 540, 100, 'Three', { frameId: 'f' }),
      // the note N made: inside the frame's area, not its member (W5-01)
      ...note('d', 640, 160, 'Four'),
    ])
    const out = applyThemes(
      canvas,
      [
        { name: 'Odd', noteIds: ['shape:a', 'shape:c'] },
        { name: 'Even', noteIds: ['shape:b', 'shape:d'] },
      ],
      'usr_1',
    )
    expect(out).toMatchObject({ moved: 4, themes: 2, grew: true })
    const f = els.get('f') as El
    expect(f.height).toBeGreaterThan(400)
    for (const id of ['a', 'b', 'c', 'd']) {
      expect(els.get(id)?.frameId, id).toBe('f')
      expect(els.get(`${id}.t`)?.frameId, `${id}'s label`).toBe('f')
      expect(within(f, els.get(id) as El), `${id} inside the frame`).toBe(true)
    }
    const labels = labelsOf(els)
    expect(labels).toHaveLength(2)
    for (const l of labels) {
      expect(l.frameId).toBe('f')
      expect(within(f, l)).toBe(true)
    }
  })

  it('a note on the open canvas joins the frame most of the notes are in', () => {
    const { canvas, els } = fakeCanvas([
      frame('f', 0, 0, 1600, 1000),
      ...note('a', 60, 100, 'One', { frameId: 'f' }),
      ...note('b', 300, 100, 'Two', { frameId: 'f' }),
      ...note('c', 540, 100, 'Three', { frameId: 'f' }),
      ...note('d', 1800, 100, 'Four'),
    ])
    applyThemes(canvas, [{ name: 'All', noteIds: ['shape:a', 'shape:b', 'shape:c', 'shape:d'] }], 'usr_1')
    for (const id of ['a', 'b', 'c', 'd']) {
      expect(els.get(id)?.frameId, id).toBe('f')
      expect(within(els.get('f') as El, els.get(id) as El), `${id} inside the frame`).toBe(true)
    }
  })

  it('notes of two frames are grouped each in its own frame', () => {
    const { canvas, els } = fakeCanvas([
      frame('f', 0, 0, 1600, 1000),
      frame('g', 2000, 0, 1600, 1000),
      ...note('a', 60, 100, 'One', { frameId: 'f' }),
      ...note('b', 300, 100, 'Two', { frameId: 'f' }),
      ...note('c', 2060, 100, 'Three', { frameId: 'g' }),
    ])
    const out = applyThemes(
      canvas,
      [
        { name: 'X', noteIds: ['shape:a', 'shape:c'] },
        { name: 'Y', noteIds: ['shape:b'] },
      ],
      'usr_1',
    )
    expect(out).toMatchObject({ moved: 3, themes: 2 })
    expect([els.get('a')?.frameId, els.get('b')?.frameId, els.get('c')?.frameId]).toEqual(['f', 'f', 'g'])
    for (const id of ['a', 'b']) expect(within(els.get('f') as El, els.get(id) as El), id).toBe(true)
    expect(within(els.get('g') as El, els.get('c') as El)).toBe(true)
    const labels = labelsOf(els)
    expect(
      labels
        .filter((l) => l.frameId === 'f')
        .map((l) => l.originalText)
        .sort(),
    ).toEqual(['X', 'Y'])
    expect(labels.filter((l) => l.frameId === 'g').map((l) => l.originalText)).toEqual(['X'])
  })

  it('a frame as the target names the notes made with N in it, so they are counted, sent and grouped there', () => {
    const { canvas, els } = fakeCanvas([
      frame('f', 0, 0, 1600, 1000),
      ...note('a', 60, 100, 'One', { frameId: 'f' }),
      ...note('d', 300, 100, 'Two'),
      // outside the frame: not part of it
      ...note('x', 1800, 100, 'Three'),
    ])
    const t = targetAt(canvas, { x: 800, y: 900 })
    expect(t.kind).toBe('frame')
    expect(t.ids).toEqual(['f', 'd'])
    expect(t.notes).toBe(2)
    expect(t.label).toBe('the frame “F”')
    applyThemes(canvas, [{ name: 'Both', noteIds: ['shape:a', 'shape:d'] }], 'usr_1')
    expect([els.get('a')?.frameId, els.get('d')?.frameId]).toEqual(['f', 'f'])
    const ids = applyNotes(
      canvas,
      t,
      { heading: 'Action items', texts: ['p'], color: 'light-green', kind: 'action-item' },
      'usr_1',
    )
    for (const id of ids) expect(els.get(id)?.frameId).toBe('f')
  })

  it('reads where loose elements lie from their own fields, not the port’s per-call bounds scan (CR 3b-7)', () => {
    const seed: El[] = [frame('f', 0, 0, 4000, 4000)]
    for (let i = 0; i < 150; i++)
      seed.push(...note(`n${i}`, (i % 15) * 250, Math.floor(i / 15) * 250, `Idea ${i}`))
    // a loose line whose points reach left of its origin: its middle is inside the frame
    seed.push({
      id: 'line',
      type: 'line',
      x: 4100,
      y: 100,
      width: 400,
      height: 0,
      points: [
        [0, 0],
        [-400, 0],
      ],
    })
    const { canvas } = fakeCanvas(seed)
    let calls = 0
    const bounds = canvas.bounds.bind(canvas)
    ;(canvas as { bounds: typeof bounds }).bounds = (id) => {
      calls++
      return bounds(id)
    }
    const t = targetAt(canvas, { x: 10, y: 10 })
    expect(t.ids).toHaveLength(152)
    expect(t.ids).toContain('line')
    expect(t.notes).toBe(150)
    expect(calls).toBeLessThanOrEqual(2)
  })

  it('the regroup question still sees the frame’s groups with a note made with N among the notes', () => {
    const { canvas } = fakeCanvas([
      frame('f', 0, 0, 1600, 1000),
      ...box('g1', 600, 100, 'Gameplay', 'f'),
      ...box('g2', 600, 300, 'Story', 'f'),
      ...note('a', 60, 100, 'One', { frameId: 'f' }),
      ...note('b', 300, 100, 'Two', { frameId: 'f' }),
      ...note('d', 60, 400, 'Three'),
    ])
    canvas.select(['a', 'b', 'd'])
    expect(selectionTarget(canvas)?.groups).toEqual(['Gameplay', 'Story'])
  })

  it('ideas for notes with a note made with N among them land in the frame, clear of that note', () => {
    const { canvas, els } = fakeCanvas([
      frame('f', 1000, 0, 1200, 800),
      ...note('a', 1040, 100, 'One', { frameId: 'f' }),
      ...note('d', 1280, 100, 'Two'),
      // a loose note in the frame, not selected: in the way
      ...note('e', 1520, 100, 'Three'),
    ])
    canvas.select(['a', 'd'])
    const target = selectionTarget(canvas)
    if (!target) throw new Error('no target')
    const ids = applyNotes(
      canvas,
      target,
      { heading: 'Ideas: x', texts: ['p', 'q'], color: 'yellow', kind: 'idea' },
      'usr_1',
    )
    for (const id of ids) {
      const e = els.get(id) as El
      expect(e.frameId, id).toBe('f')
      expect(within(els.get('f') as El, e)).toBe(true)
      for (const o of ['a', 'd', 'e']) expect(overlap(e, els.get(o) as El), `${id} over ${o}`).toBe(false)
    }
  })
})

describe('W5-04: the theme labels on one line', () => {
  it('a card hanging into the row does not hold one cluster lower than its neighbours', () => {
    const seed: El[] = [{ id: 'card', type: 'rectangle', x: 630, y: -251, width: 375, height: 270 }]
    const ids = 'abcdefghi'.split('')
    ids.forEach((id, i) => {
      seed.push(...note(id, i * 216, 0, `Idea ${id}`))
    })
    const { canvas, els } = fakeCanvas(seed)
    applyThemes(
      canvas,
      [
        { name: 'Big Gameplay Moments', noteIds: ['shape:a', 'shape:b', 'shape:c'] },
        { name: 'Story Twists', noteIds: ['shape:d', 'shape:e', 'shape:f'] },
        { name: 'Made With Players', noteIds: ['shape:g', 'shape:h', 'shape:i'] },
      ],
      'usr_1',
    )
    const labels = [...els.values()].filter(
      (e) => !e.isDeleted && aiKindOf(e as unknown as CanvasElement) === 'theme-label',
    )
    expect(labels).toHaveLength(3)
    expect(new Set(labels.map((l) => l.y)).size).toBe(1)
    for (const l of labels) expect(overlap(l, els.get('card') as El)).toBe(false)
  })
})

describe('a mind-map topic as the target (K7-1)', () => {
  const topic = (id: string, text: string, lobby: Record<string, unknown>): El[] => [
    {
      id,
      type: 'rectangle',
      x: 0,
      y: 0,
      width: 200,
      height: 80,
      boundElements: [{ id: `${id}.t`, type: 'text' }],
      customData: { lobby },
    },
    {
      id: `${id}.t`,
      type: 'text',
      containerId: id,
      originalText: text,
      x: 10,
      y: 20,
      width: 180,
      height: 40,
    },
  ]
  const MAP = { mindmap: { rootId: 'r', parentId: null, side: 'right', collapsed: false } }

  it('one selected topic names itself, so "Expand with AI" is offered', () => {
    const { canvas } = fakeCanvas(topic('r', 'Launch', MAP))
    canvas.select(['r'])
    expect(selectionTarget(canvas)).toMatchObject({ topicId: 'r', texts: 1 })
    // its label stands for it
    canvas.select(['r.t'])
    expect(selectionTarget(canvas)?.topicId).toBe('r')
  })

  it('a plain shape, two topics or an empty topic: no topic target (the empty one has no words to send)', () => {
    const { canvas } = fakeCanvas([
      ...topic('r', 'Launch', MAP),
      ...topic('p', 'Plain', {}),
      ...topic('e', '', MAP),
    ])
    canvas.select(['p'])
    expect(selectionTarget(canvas)?.topicId).toBeUndefined()
    canvas.select(['r', 'e'])
    expect(selectionTarget(canvas)?.topicId).toBeUndefined()
    canvas.select(['e'])
    expect(selectionTarget(canvas)).toMatchObject({ topicId: 'e', texts: 0 })
  })
})
