import type {
  TLArrowBinding,
  TLFrameShape,
  TLGeoShape,
  TLNoteShape,
  TLRecord,
  TLShape,
} from '@tldraw/tlschema'
import { describe, expect, it } from 'vitest'
import { getTemplate, instantiateTemplate, isTemplateId, TEMPLATES, type TemplateId } from './index.ts'
import {
  arrowsOf,
  bindingsOf,
  byId,
  childrenOf,
  framesOf,
  must,
  PAGE,
  pageRect,
  readingOrder,
  textOf,
} from './test-utils.ts'

function build(id: TemplateId) {
  return instantiateTemplate(id, { pageId: PAGE, origin: { x: 0, y: 0 } }).records
}

function frameNamed(records: TLRecord[], name: string): TLFrameShape {
  const f = framesOf(records).find((x) => x.props.name === name)
  if (!f) throw new Error(`no frame ${name}`)
  return f
}

function kidsOfType<T extends TLShape['type']>(records: TLRecord[], frame: TLFrameShape, type: T) {
  return childrenOf(records, frame.id).filter((s): s is Extract<TLShape, { type: T }> => s.type === type)
}

/** For every arrow: [start target id, end target id]. */
function connections(records: TLRecord[]): Array<[string, string]> {
  const bindings = bindingsOf(records)
  return arrowsOf(records).map((a) => {
    const mine = bindings.filter((b: TLArrowBinding) => b.fromId === a.id)
    return [
      must(mine.find((b) => b.props.terminal === 'start')).toId,
      must(mine.find((b) => b.props.terminal === 'end')).toId,
    ]
  })
}

/** Asserts the arrows chain the given frames in order, left to right, and nothing else. */
function expectChain(records: TLRecord[], frames: TLFrameShape[]) {
  const shapes = byId(records)
  const links = connections(records)
  expect(links).toHaveLength(frames.length - 1)
  for (let i = 0; i + 1 < frames.length; i++) {
    expect(links).toContainEqual([must(frames[i]).id, must(frames[i + 1]).id])
    expect(pageRect(must(frames[i + 1]), shapes).x).toBeGreaterThan(pageRect(must(frames[i]), shapes).x)
  }
  for (const a of arrowsOf(records)) {
    expect(a.parentId).toBe(PAGE)
    expect(a.props.arrowheadEnd).toBe('arrow')
  }
}

describe('template catalogue', () => {
  it('exposes the six contract templates with picker metadata', () => {
    expect(TEMPLATES.map((t) => t.id)).toEqual([
      'brainstorm',
      'mood-board',
      'storyboard',
      'pitch-outline',
      'retrospective',
      'production-plan',
    ])
    for (const t of TEMPLATES) {
      expect(['ideate', 'visual', 'plan', 'review']).toContain(t.category)
      expect(t.name.trim()).not.toBe('')
      // One sentence for the picker.
      expect(t.description).toMatch(/^[A-Z][^.!?]*[.]$/)
      expect(t.description.length).toBeLessThanOrEqual(120)
      expect(t.sections.length).toBeGreaterThanOrEqual(3)
      expect(getTemplate(t.id)).toBe(t)
      expect(isTemplateId(t.id)).toBe(true)
    }
    expect(new Set(TEMPLATES.map((t) => t.category))).toEqual(new Set(['ideate', 'visual', 'plan', 'review']))
  })

  it('is frozen so consumers cannot rewrite shared definitions', () => {
    expect(Object.isFrozen(TEMPLATES)).toBe(true)
    for (const t of TEMPLATES) {
      expect(Object.isFrozen(t)).toBe(true)
      expect(Object.isFrozen(t.sections)).toBe(true)
    }
    expect(() => (TEMPLATES as unknown as unknown[]).push('brainstorm')).toThrow()
    expect(() => {
      ;(TEMPLATES[0] as unknown as { name: string }).name = 'hijacked'
    }).toThrow()
    expect(TEMPLATES[0]?.name).toBe('Brainstorm')
  })

  it('does not share structure between instantiations', () => {
    const a = build('retrospective')
    const b = build('retrospective')
    const noteA = must(a.find((r): r is TLNoteShape => r.typeName === 'shape' && r.type === 'note'))
    const noteB = must(b.find((r): r is TLNoteShape => r.typeName === 'shape' && r.type === 'note'))
    expect(textOf(noteA)).toBe(textOf(noteB))
    ;(noteA.props.richText.content as Array<Record<string, unknown>>).length = 0
    expect(textOf(noteB)).not.toBe('')
    expect(
      textOf(
        must(
          build('retrospective').find((r): r is TLNoteShape => r.typeName === 'shape' && r.type === 'note'),
        ),
      ),
    ).toBe(textOf(noteB))
  })
})

describe('brainstorm', () => {
  const records = build('brainstorm')
  const map = frameNamed(records, '1 · Brainstorm')

  it('puts one question at the centre, connected to four named themes', () => {
    const question = must(kidsOfType(records, map, 'geo').find((g) => g.props.geo === 'ellipse'))
    expect(textOf(question)).toMatch(/^How might we/)
    const shapes = byId(records)
    const q = pageRect(question, shapes)
    const m = pageRect(map, shapes)
    expect(q.x + q.w / 2).toBeCloseTo(m.x + m.w / 2, 0)

    const links = connections(records)
    expect(links).toHaveLength(4)
    const themes = links.map(([from, to]) => {
      expect(from).toBe(question.id)
      return shapes.get(to) as TLGeoShape
    })
    for (const theme of themes) {
      expect(theme.type).toBe('geo')
      expect(textOf(theme)).toMatch(/^Theme \d: name it$/)
      // Two starter notes directly below the theme label, in the theme's color.
      const t = pageRect(theme, shapes)
      const notes = kidsOfType(records, map, 'note').filter((n) => {
        const r = pageRect(n, shapes)
        return r.x >= t.x - 1 && r.x + r.w <= t.x + t.w + 1 && r.y > t.y && r.y - (t.y + t.h) < 60
      })
      expect(notes).toHaveLength(2)
      for (const n of notes) expect(n.props.color).toBe(theme.props.color)
    }
    expect(new Set(themes.map((t) => t.props.color)).size).toBe(4)
    // Mind-map connectors: no arrowheads, kept inside the brainstorm frame.
    for (const a of arrowsOf(records)) {
      expect(a.parentId).toBe(map.id)
      expect(a.props.arrowheadEnd).toBe('none')
    }
  })

  it('offers a shortlist and a parking lot', () => {
    const shortlist = frameNamed(records, '2 · Shortlist')
    expect(kidsOfType(records, shortlist, 'note').map(textOf)).toContain('Runner-up')
    expect(kidsOfType(records, frameNamed(records, '3 · Parking lot'), 'note')).toHaveLength(1)
  })
})

describe('mood board', () => {
  const records = build('mood-board')

  it('has a palette of distinct full-color swatches', () => {
    const swatches = kidsOfType(records, frameNamed(records, '2 · Palette'), 'geo').filter(
      (g) => g.props.fill === 'fill',
    )
    expect(swatches.length).toBe(6)
    expect(new Set(swatches.map((s) => s.props.color)).size).toBe(6)
    for (const s of swatches) expect(textOf(s).length).toBeGreaterThan(0)
  })

  it('has dashed image slots and keyword prompts', () => {
    const slots = kidsOfType(records, frameNamed(records, '3 · Imagery'), 'geo')
    expect(slots).toHaveLength(6)
    for (const s of slots) {
      expect(s.props.dash).toBe('dashed')
      expect(s.props.w / s.props.h).toBeCloseTo(3 / 2, 1)
    }
    const keywords = kidsOfType(records, frameNamed(records, '1 · Direction'), 'note').map(textOf)
    expect(keywords.some((k) => k.startsWith('Texture'))).toBe(true)
  })

  it('pairs "this" and "not that" notes side by side', () => {
    const frame = frameNamed(records, '4 · This, not that')
    const shapes = byId(records)
    const notes = kidsOfType(records, frame, 'note')
    const yes = notes.filter((n) => n.props.color === 'light-green')
    const no = notes.filter((n) => n.props.color === 'light-red')
    expect(yes.length).toBe(no.length)
    yes.forEach((n, i) => {
      expect(pageRect(n, shapes).y).toBe(pageRect(must(no[i]), shapes).y)
      expect(pageRect(n, shapes).x).toBeLessThan(pageRect(must(no[i]), shapes).x)
    })
  })
})

describe('storyboard', () => {
  const records = build('storyboard')
  const panels = readingOrder(records, PAGE).filter((f) => f.props.name.startsWith('Panel'))

  it('chains six numbered panels with arrows, in reading order', () => {
    expect(panels.map((p) => p.props.name)).toEqual([
      'Panel 1',
      'Panel 2',
      'Panel 3',
      'Panel 4',
      'Panel 5',
      'Panel 6',
    ])
    expectChain(records, panels)
    const shapes = byId(records)
    // One row: every panel shares the same top edge.
    expect(new Set(panels.map((p) => pageRect(p, shapes).y)).size).toBe(1)
  })

  it('gives each panel a 16:9 image slot, a shot note, an action note and a timing', () => {
    panels.forEach((panel, i) => {
      const heading = must(childrenOf(records, panel.id)[0])
      expect(textOf(heading)).toMatch(new RegExp(`^${i + 1} · `))
      const geos = kidsOfType(records, panel, 'geo')
      expect(geos).toHaveLength(1)
      const slot = must(geos[0])
      expect(slot.props.dash).toBe('dashed')
      expect(slot.props.w / slot.props.h).toBeCloseTo(16 / 9, 1)
      const notes = kidsOfType(records, panel, 'note').map(textOf)
      expect(notes).toHaveLength(2)
      expect(notes[0]).toMatch(/^Shot: /)
      expect(notes[1]).toMatch(/We see/)
      const texts = kidsOfType(records, panel, 'text').map(textOf)
      expect(texts.some((t) => /^Time: \d:\d\d – \d:\d\d$/.test(t))).toBe(true)
    })
  })
})

describe('pitch outline', () => {
  const records = build('pitch-outline')

  it('runs problem, insight, idea, proof, ask left to right with arrows', () => {
    const steps = ['1 · Problem', '2 · Insight', '3 · Idea', '4 · Proof', '5 · Ask'].map((n) =>
      frameNamed(records, n),
    )
    expectChain(records, steps)
    for (const s of steps) expect(kidsOfType(records, s, 'note').length).toBeGreaterThanOrEqual(2)
    expect(kidsOfType(records, frameNamed(records, '3 · Idea'), 'geo')).toHaveLength(1)
  })
})

describe('retrospective', () => {
  const records = build('retrospective')

  it('has went-well, to-improve and actions columns in one row', () => {
    const shapes = byId(records)
    const cols = ['2 · What went well', '3 · What to improve', '4 · Actions'].map((n) =>
      frameNamed(records, n),
    )
    const tops = cols.map((c) => pageRect(c, shapes).y)
    expect(new Set(tops).size).toBe(1)
    const colors = cols.map((c) => new Set(kidsOfType(records, c, 'note').map((n) => n.props.color)))
    for (const c of colors) expect(c.size).toBe(1)
    expect(new Set(colors.map((c) => [...c][0])).size).toBe(3)
    for (const n of kidsOfType(records, must(cols[2]), 'note')) {
      expect(textOf(n)).toMatch(/Action:[\s\S]*Owner:[\s\S]*Due:/)
    }
    expect(arrowsOf(records)).toHaveLength(0)
  })

  it('starts with a check-in that reviews the last actions', () => {
    const notes = kidsOfType(records, frameNamed(records, '1 · Check-in'), 'note').map(textOf)
    expect(notes.some((n) => n.startsWith("Last time's actions"))).toBe(true)
  })
})

describe('production plan', () => {
  const records = build('production-plan')
  const phaseNames = [
    '1 · Brief',
    '2 · Pre-production',
    '3 · Production',
    '4 · Post-production',
    '5 · Delivery',
  ]

  it('chains five phases left to right', () => {
    expectChain(
      records,
      phaseNames.map((n) => frameNamed(records, n)),
    )
  })

  it('gives every phase an owner, dates, tasks and one deliverable', () => {
    for (const name of phaseNames) {
      const notes = kidsOfType(records, frameNamed(records, name), 'note').map(textOf)
      expect(notes.filter((n) => n.startsWith('Owner:'))).toHaveLength(1)
      expect(notes.filter((n) => n.startsWith('Dates:'))).toHaveLength(1)
      expect(notes.filter((n) => n.startsWith('Deliverable:'))).toHaveLength(1)
      expect(notes.length).toBeGreaterThanOrEqual(5)
    }
  })

  it('ends with risks and dependencies below the phases', () => {
    const shapes = byId(records)
    const risks = frameNamed(records, 'Risks & dependencies')
    const phases = frameNamed(records, '1 · Brief')
    const p = pageRect(phases, shapes)
    expect(pageRect(risks, shapes).y).toBeGreaterThan(p.y + p.h)
  })
})
