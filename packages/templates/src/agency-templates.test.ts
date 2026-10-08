// Wave K (K4-2): the six agency templates (creative brief, client feedback round, shot list, launch timeline,
// 2x2 prioritisation, Kanban columns). Each has a plan test (what it builds, from notes, frames, text, boxes
// and arrows only, with no assets) and a reading-order test (the keyboard reads each frame in the order the
// template was written). The dark-safe rule is checked for every template: no white label on a saturated
// fill, on the plan and on the elements the new canvas stores.
//
// Every template here is original work written for Dark Burn's daily jobs; none is a copy of a Miro or a
// community template.

import { LOBBY_PALETTE, lobbyColor } from '@draftroom/board-ops/elements'
import { describe, expect, it } from 'vitest'
import { keyboardReadingOrder, must } from '../../tldraw-import/src/templates/test-utils.ts'
import { IMAGE_SLOT_META, type PlanFrame, type PlanNode } from './builder.ts'
import type { TemplateId } from './common.ts'
import { getTemplateSource, isTemplateId, planTemplate, TEMPLATE_INFOS } from './plan.ts'
import { alignedTemplate } from './scene/test-kit.ts'

const ORIGIN = { x: 0, y: 0 }

/** The six templates wave K adds, with the sections each one is written in. */
const AGENCY_TEMPLATES = {
  'creative-brief': [
    '1 · The ask',
    '2 · Audience',
    '3 · Message and tone',
    '4 · Look and feel',
    '5 · Deliverables and dates',
  ],
  'client-feedback': [
    '1 · The work',
    '2 · Their feedback',
    '3 · Do now',
    '4 · Discuss',
    '5 · Park',
    '6 · Next version',
  ],
  'shot-list': ['1 · Shoot day', '2 · Scene 1', '3 · Scene 2', '4 · Scene 3'],
  'launch-timeline': ['1 · The road to launch', '2 · Prepare', '3 · Lock', '4 · Launch', '5 · Learn'],
  'prioritisation-2x2': [
    '1 · Ideas to place',
    '2 · Quick wins',
    '3 · Big bets',
    '4 · Fill-ins',
    '5 · Park it',
  ],
  kanban: ['1 · Backlog', '2 · This week', '3 · In progress', '4 · In review', '5 · Done'],
} as const satisfies Record<string, readonly string[]>

const IDS = Object.keys(AGENCY_TEMPLATES) as (keyof typeof AGENCY_TEMPLATES)[]

describe('the agency templates are in the catalogue', () => {
  it('lists all six, each with one-sentence copy, a category and its sections', () => {
    for (const id of IDS) {
      expect(isTemplateId(id), id).toBe(true)
      const info = must(
        TEMPLATE_INFOS.find((t) => t.id === id),
        id,
      )
      expect(info.name.length).toBeGreaterThan(2)
      expect(info.description, id).toMatch(/^[A-Z].*\.$/)
      expect(info.description.length).toBeLessThan(140)
      expect(['ideate', 'visual', 'plan', 'review']).toContain(info.category)
      expect([...info.sections], id).toEqual([...AGENCY_TEMPLATES[id]])
    }
    expect(TEMPLATE_INFOS.map((t) => t.id)).toEqual([
      'brainstorm',
      'mood-board',
      'storyboard',
      'pitch-outline',
      'retrospective',
      'production-plan',
      ...IDS,
      'lobby-tour',
    ])
  })

  it('has unique ids and names', () => {
    expect(new Set(TEMPLATE_INFOS.map((t) => t.id)).size).toBe(TEMPLATE_INFOS.length)
    expect(new Set(TEMPLATE_INFOS.map((t) => t.name.toLowerCase())).size).toBe(TEMPLATE_INFOS.length)
  })
})

describe.each(IDS.map((id) => [id] as const))('%s: plan', (id) => {
  const plan = planTemplate(id as TemplateId, ORIGIN)
  const frames = plan.nodes.filter((n): n is PlanFrame => n.kind === 'frame')

  it('builds one frame per section, in the sections’ order, from frames, text, notes, boxes and arrows only', () => {
    expect(frames.map((f) => f.name)).toEqual([...AGENCY_TEMPLATES[id]])
    for (const n of plan.nodes) expect(['frame', 'text', 'note', 'geo', 'arrow'], n.kind).toContain(n.kind)
    // frames hold everything; only arrows between frames sit on the page
    for (const n of plan.nodes) if (n.kind !== 'frame' && n.kind !== 'arrow') expect(n.parent).not.toBeNull()
    for (const f of frames) expect(f.parent).toBeNull()
  })

  it('opens every frame with a locked heading, then a locked grey instruction line when it has one', () => {
    for (const f of frames) {
      const kids = plan.nodes.filter((n) => n.parent === f)
      const [heading, intro] = kids
      expect(heading?.kind === 'text' && heading.heading && heading.locked, f.name).toBe(true)
      if (intro?.kind === 'text') expect([intro.locked, intro.color], f.name).toEqual([true, 'grey'])
    }
  })

  it('marks every note a prompt (a placeholder for the team, not an idea)', () => {
    const notes = plan.nodes.filter((n) => n.kind === 'note')
    expect(notes.length).toBeGreaterThan(0)
    for (const n of notes) expect(n.kind === 'note' && n.prompt).toBe(true)
  })

  it('has image slots only as empty, locked, dashed boxes that carry no file and no address', () => {
    const slots = plan.nodes.filter((n) => n.kind === 'geo' && n.meta.draftroomSlot !== undefined)
    for (const s of slots) {
      expect(s.kind === 'geo' && s.meta).toEqual(IMAGE_SLOT_META)
      expect(s.kind === 'geo' && [s.locked, s.dash]).toEqual([true, 'dashed'])
    }
    const json = JSON.stringify(
      plan.nodes.map((n) => ({ ...n, parent: undefined, from: undefined, to: undefined })),
    )
    expect(json).not.toMatch(/https?:|data:|blob:|\/\/|base64|fileId|assetId/i)
    // a box without words is allowed only as a swatch (none here)
    for (const n of plan.nodes)
      if (n.kind === 'geo') expect(n.text.length, 'a box says something').toBeGreaterThan(0)
  })

  it('keeps every node inside its frame, in a plan that is the same at any origin', () => {
    for (const n of plan.nodes) {
      if (n.kind === 'frame' || n.kind === 'arrow' || !n.parent) continue
      const p = n.parent.page
      expect(n.page.x).toBeGreaterThanOrEqual(p.x)
      expect(n.page.y).toBeGreaterThanOrEqual(p.y)
      expect(n.page.x + n.page.w).toBeLessThanOrEqual(p.x + p.w)
      expect(n.page.y + n.page.h).toBeLessThanOrEqual(p.y + p.h)
    }
    const moved = planTemplate(id as TemplateId, { x: 500, y: -300 })
    expect(moved.nodes).toHaveLength(plan.nodes.length)
    plan.nodes.forEach((n, i) => {
      const m = must(moved.nodes[i])
      expect([m.page.x - n.page.x, m.page.y - n.page.y]).toEqual([500, -300])
    })
  })

  it('stays small enough to read and paste: under 120 elements, 2,600 wide at most', () => {
    expect(plan.nodes.length).toBeLessThan(120)
    const top = plan.nodes.filter((n) => n.parent === null)
    const x1 = Math.max(...top.map((n) => n.page.x + n.page.w))
    expect(x1).toBeLessThanOrEqual(2600)
  })
})

describe.each(IDS.map((id) => [id] as const))('%s: reading order', (id) => {
  const { plan, elements, idOf } = alignedTemplate(id as TemplateId, ORIGIN)

  it('reads the frames in the sections’ order (rows top to bottom, then left to right)', () => {
    const frames = elements.filter((e) => e.type === 'frame')
    const entries = frames.map((f) => ({ f, rect: { x: f.x, y: f.y, w: f.width, h: f.height } }))
    // frames in one row start at the same height; the keyboard sorts by centre
    const order = keyboardReadingOrder(entries)
    expect(order.map((o) => (o.f.type === 'frame' ? o.f.name : ''))).toEqual([...AGENCY_TEMPLATES[id]])
  })

  it('reads each frame’s contents in the order they were written: heading, instruction, then the cards', () => {
    for (const frame of plan.nodes.filter((n): n is PlanFrame => n.kind === 'frame')) {
      const written = plan.nodes.filter((n) => n.parent === frame && n.kind !== 'arrow')
      const els = written.map((n) => ({
        n,
        e: must(
          elements.find((e) => e.id === idOf.get(n)),
          n.kind,
        ),
      }))
      const read = keyboardReadingOrder(
        els.map(({ n, e }) => ({ n, rect: { x: e.x, y: e.y, w: e.width, h: e.height } })),
      )
      expect(
        read.map((r) => wordsOfNode(r.n)),
        frame.name,
      ).toEqual(written.map(wordsOfNode))
    }
  })
})

function wordsOfNode(n: PlanNode): string {
  if (n.kind === 'text') return n.text
  if (n.kind === 'note') return n.text
  if (n.kind === 'geo') return n.text
  return ''
}

// ---- dark-safe labels --------------------------------------------------------------------------------

/**
 * In the dark theme the canvas filter inverts every colour, so a white label on a saturated fill comes out
 * as a near-black label on a bright one (the Brainstorm's centre question, K4-3). Words sit on pale tints
 * in the dark ink instead, and a swatch (a full-colour block) carries no words at all.
 */
const SATURATED = Object.keys(LOBBY_PALETTE).filter((c) => c !== 'white')

describe.each(TEMPLATE_INFOS.map((t) => [t.id] as const))('%s: dark-safe labels', (id) => {
  const { plan, elements, idOf } = alignedTemplate(id as TemplateId, ORIGIN)

  it('puts no white label on a saturated fill (plan)', () => {
    for (const n of plan.nodes) {
      if (n.kind !== 'geo' || n.fill !== 'fill' || n.meta.draftroomSwatch !== undefined) continue
      expect(n.labelColor, `"${n.text}" on a full ${n.color} fill`).not.toBe('white')
      // and no label at all on a full-colour fill: the tinted fills carry words in both themes
      expect(n.text, `a full ${n.color} fill carries no words`).toBe('')
    }
    for (const n of plan.nodes) if (n.kind === 'text') expect(n.color, n.text).not.toBe('white')
  })

  it('stores the same on the new canvas: no white stroke on a full-colour background', () => {
    const white = lobbyColor('white').solid
    const fills = new Set(SATURATED.map((c) => lobbyColor(c).fill))
    for (const e of elements) {
      if (e.type !== 'text' || !e.containerId) continue
      const container = must(elements.find((c) => c.id === e.containerId))
      const fullColour = fills.has(container.backgroundColor)
      expect(
        e.strokeColor.toLowerCase() === white && fullColour,
        `"${e.originalText}" is white on ${container.backgroundColor}`,
      ).toBe(false)
    }
    for (const n of plan.nodes) {
      if (n.kind !== 'geo') continue
      const el = must(elements.find((e) => e.id === idOf.get(n)))
      // the plan's fill names map onto the stored backgrounds
      if (n.fill === 'fill') expect(el.backgroundColor).toBe(lobbyColor(n.color).fill)
    }
  })
})

describe('getTemplateSource', () => {
  it('knows the new ids and refuses lookalikes', () => {
    for (const id of IDS) expect(getTemplateSource(id)?.id).toBe(id)
    for (const id of ['creative_brief', 'Kanban', 'kanban ', '2x2', 'shotlist'])
      expect(getTemplateSource(id)).toBeUndefined()
  })
})
