// The "Lobby tour" sample board (docs/WAVE3-CONTRACTS.md §2 sample-board): six named frames left to right
// in presentation order, what each one must show, bindings that resolve, no overlaps, and labels that
// stay readable in both themes. templates.test.ts runs the generic template checks on it as well.

import { frameOutline, plainTextOf, presentationOrder, searchBoard } from '@draftroom/board-ops'
import type {
  TLArrowBinding,
  TLFrameShape,
  TLGeoShape,
  TLNoteShape,
  TLRecord,
  TLShape,
  TLTextShape,
} from '@tldraw/tlschema'
import { describe, expect, it } from 'vitest'
import { getTemplate, IMAGE_SLOT_META, instantiateTemplate } from './index.ts'
import { estimateTextHeight, LABEL_FONT_PX, LABEL_PADDING } from './layout.ts'
import { LOBBY_TOUR_SECTIONS, TOUR_FRAME_H, TOUR_FRAME_W } from './templates/lobby-tour.ts'
import {
  arrowsOf,
  bindingsOf,
  byId,
  childrenOf,
  framesOf,
  must,
  PAGE,
  pageRect,
  rectContains,
  rectGap,
  rectsOverlap,
  shapesOf,
  textOf,
} from './test-utils.ts'

const SECTIONS = [
  '1 · Welcome',
  '2 · Brainstorm',
  '3 · Plan',
  '4 · Mood board',
  '5 · Retro',
  '6 · Tips and shortcuts',
]

const { records, bounds } = instantiateTemplate('lobby-tour', { pageId: PAGE, origin: { x: 0, y: 0 } })
const shapes = byId(records)

function frame(name: string): TLFrameShape {
  return must(
    framesOf(records).find((f) => f.props.name === name),
    name,
  )
}
const kids = <T extends TLShape['type']>(f: TLFrameShape, type: T) =>
  childrenOf(records, f.id).filter((s): s is Extract<TLShape, { type: T }> => s.type === type)

/** [start target, end target] of an arrow. */
function ends(arrowId: string): [TLShape, TLShape] {
  const mine = bindingsOf(records).filter((b: TLArrowBinding) => b.fromId === arrowId)
  const start = must(mine.find((b) => b.props.terminal === 'start'))
  const end = must(mine.find((b) => b.props.terminal === 'end'))
  return [must(shapes.get(start.toId)), must(shapes.get(end.toId))]
}

/** Does the first paragraph of this shape's rich text carry a bold mark? */
function firstLineBold(shape: TLGeoShape): boolean {
  const first = (
    shape.props.richText.content as Array<{ content?: Array<{ marks?: Array<{ type: string }> }> }>
  )[0]
  return !!first?.content?.every((n) => n.marks?.some((m) => m.type === 'bold'))
}

describe('Lobby tour: the board', () => {
  it('is registered as the sample, with six sections in presentation order', () => {
    const def = must(getTemplate('lobby-tour'))
    expect(def.name).toBe('Lobby tour')
    expect(def.category).toBe('sample')
    expect([...def.sections]).toEqual(SECTIONS)
    expect([...LOBBY_TOUR_SECTIONS]).toEqual(SECTIONS)
  })

  it('has six named, equal 16:10 frames in one row, left to right in presentation order', () => {
    const top = framesOf(records).filter((f) => f.parentId === PAGE)
    expect(top).toHaveLength(6)
    const byX = [...top].sort((a, b) => a.x - b.x)
    expect(byX.map((f) => f.props.name)).toEqual(SECTIONS)
    for (const f of top) {
      expect(f.y).toBe(0)
      expect([f.props.w, f.props.h]).toEqual([TOUR_FRAME_W, TOUR_FRAME_H])
      expect(f.props.w / f.props.h).toBeCloseTo(16 / 10, 5)
    }
    // What the Frames panel and Present use (board-ops), with no presentationIndex needed.
    expect(presentationOrder(records, PAGE).map((e) => e.name)).toEqual(SECTIONS)
    expect(frameOutline(records, PAGE).map((e) => e.name)).toEqual(SECTIONS)
    for (const f of top) expect(f.meta).toEqual({})
    expect(bounds).toEqual({ x: 0, y: 0, w: 6 * TOUR_FRAME_W + 5 * 160, h: TOUR_FRAME_H })
  })

  it('never overlaps two frames, and keeps every shape inside its own frame', () => {
    const top = framesOf(records)
    expect(top).toHaveLength(6) // no nested frames: every frame is a slide
    for (let i = 0; i < top.length; i++) {
      for (let j = i + 1; j < top.length; j++) {
        const a = pageRect(must(top[i]), shapes)
        const b = pageRect(must(top[j]), shapes)
        expect(rectsOverlap(a, b)).toBe(false)
        expect(rectGap(a, b)).toBeGreaterThanOrEqual(120)
      }
    }
    for (const s of shapesOf(records)) {
      if (s.type === 'frame') continue
      const parent = must(shapes.get(s.parentId), `parent of ${s.id}`)
      expect(parent.type).toBe('frame')
      expect(rectContains(pageRect(parent, shapes), pageRect(s, shapes)), textOf(s) || s.type).toBe(true)
    }
  })

  it('resolves every binding to a shape of this board, inside the same frame as its arrow', () => {
    const bindings = bindingsOf(records)
    expect(bindings.length).toBe(arrowsOf(records).length * 2)
    for (const b of bindings) {
      const arrow = must(shapes.get(b.fromId))
      const target = must(shapes.get(b.toId), `binding ${b.id} target`)
      expect(arrow.type).toBe('arrow')
      expect(target.type).not.toBe('arrow')
      expect(target.parentId).toBe(arrow.parentId)
    }
  })
})

describe('Lobby tour: the frames', () => {
  it('1 · Welcome says what Lobby is for DBC and offers three "try this" notes', () => {
    const f = frame('1 · Welcome')
    const texts = kids(f, 'text').map(textOf)
    expect(texts[0]).toBe('Welcome to Lobby')
    expect(texts.join(' ')).toMatch(/Dark Burn Creative/)
    expect(texts).toContain('Try this')
    const notes = kids(f, 'note').map(textOf)
    expect(notes).toHaveLength(3)
    expect(notes[0]).toMatch(/^Press N\b/)
    expect(notes[1]).toMatch(/^Press C\b/)
    expect(notes[2]).toMatch(/^Click Present\b/)
    const pillars = kids(f, 'geo')
    expect(pillars.map((g) => textOf(g).split('\n')[0])).toEqual(['Kick off', 'Make', 'Review'])
    for (const p of pillars) expect(firstLineBold(p)).toBe(true)
  })

  it('2 · Brainstorm has note clusters under themes, tied to one question by bound connectors', () => {
    const f = frame('2 · Brainstorm')
    const question = must(kids(f, 'geo').find((g) => g.props.geo === 'ellipse'))
    expect(textOf(question)).toMatch(/hook\?$/)
    const arrows = arrowsOf(records).filter((a) => a.parentId === f.id)
    expect(arrows.length).toBeGreaterThanOrEqual(3)
    const themes = arrows.map((a) => {
      const [from, to] = ends(a.id)
      expect(from.id).toBe(question.id)
      expect(to.type).toBe('geo')
      return to as TLGeoShape
    })
    expect(themes.map(textOf)).toEqual(['Gameplay', 'Story', 'Community'])
    for (const theme of themes) {
      const t = pageRect(theme, shapes)
      const cluster = kids(f, 'note').filter((n) => {
        const r = pageRect(n, shapes)
        return r.x >= t.x - 1 && r.x + r.w <= t.x + t.w + 1 && r.y > t.y + t.h && r.y - (t.y + t.h) < 60
      })
      expect(cluster, `notes under ${textOf(theme)}`).toHaveLength(2)
      for (const n of cluster) expect(n.props.color).toBe(theme.props.color)
    }
  })

  it('3 · Plan is a process diagram whose arrows are bound at both ends, with a review loop', () => {
    const f = frame('3 · Plan')
    const steps = kids(f, 'geo')
    const named = (text: string) =>
      must(
        steps.find((g) => textOf(g) === text),
        text,
      )
    const flow = ['Brief', 'Concepts', 'Client\nreview', 'Production', 'Delivery'].map(named)
    expect(named('Client\nreview').props.geo).toBe('diamond')
    const arrows = arrowsOf(records).filter((a) => a.parentId === f.id)
    const links = arrows.map((a) => ends(a.id).map((s) => s.id))
    for (let i = 0; i + 1 < flow.length; i++) {
      expect(links).toContainEqual([must(flow[i]).id, must(flow[i + 1]).id])
      // Left to right, on one row.
      const a = pageRect(must(flow[i]), shapes)
      const b = pageRect(must(flow[i + 1]), shapes)
      expect(b.x).toBeGreaterThan(a.x + a.w)
      expect(b.y + b.h / 2).toBeCloseTo(a.y + a.h / 2, 5)
    }
    const changes = named('Changes')
    expect(links).toContainEqual([named('Client\nreview').id, changes.id])
    expect(links).toContainEqual([changes.id, named('Concepts').id])
    for (const a of arrows) {
      const [from, to] = ends(a.id)
      expect(from.parentId).toBe(f.id)
      expect(to.parentId).toBe(f.id)
      expect(a.props.arrowheadEnd).toBe('arrow')
    }
    // The loop is routed with elbows and drawn dashed; the main flow is solid and straight.
    const loop = arrows.filter((a) => ends(a.id).some((s) => s.id === changes.id))
    expect(loop).toHaveLength(2)
    for (const a of loop) expect([a.props.kind, a.props.dash]).toEqual(['elbow', 'dashed'])
    for (const a of arrows.filter((x) => !loop.includes(x)))
      expect([a.props.kind, a.props.dash]).toEqual(['arc', 'solid'])
  })

  it('4 · Mood board has six 16:9 image slots, each with an editable caption right under it', () => {
    const f = frame('4 · Mood board')
    const slots = kids(f, 'geo')
    expect(slots).toHaveLength(6)
    const captions = kids(f, 'text').slice(2) // after the heading and the intro
    expect(captions).toHaveLength(6)
    for (const slot of slots) {
      expect(slot.meta).toEqual(IMAGE_SLOT_META)
      expect(slot.isLocked).toBe(true)
      expect(slot.props.dash).toBe('dashed')
      expect(slot.props.w / slot.props.h).toBeCloseTo(16 / 9, 1)
      const s = pageRect(slot, shapes)
      const caption = captions.filter((c) => {
        const r = pageRect(c, shapes)
        return Math.abs(r.x - s.x) < 1 && r.y > s.y + s.h && r.y - (s.y + s.h) < 40
      })
      expect(caption, `caption under slot at ${s.x},${s.y}`).toHaveLength(1)
      expect(must(caption[0]).isLocked).toBe(false)
    }
    expect(new Set(captions.map(textOf)).size).toBe(6)
  })

  it('5 · Retro has Went well, To improve and Actions, left to right, each with its own notes', () => {
    const f = frame('5 · Retro')
    const headers = kids(f, 'geo')
    expect(headers.map(textOf)).toEqual(['Went well', 'To improve', 'Actions'])
    expect(new Set(headers.map((h) => h.y)).size).toBe(1)
    const xs = headers.map((h) => h.x)
    expect([...xs].sort((a, b) => a - b)).toEqual(xs)
    const notes = kids(f, 'note')
    for (const h of headers) {
      expect(firstLineBold(h)).toBe(true)
      const r = pageRect(h, shapes)
      const column = notes.filter((n) => {
        const nr = pageRect(n, shapes)
        return nr.x >= r.x - 1 && nr.x + nr.w <= r.x + r.w + 1 && nr.y > r.y + r.h
      })
      expect(column.length, textOf(h)).toBeGreaterThanOrEqual(3)
      for (const n of column) expect(n.props.color).toBe(h.props.color)
    }
    expect(new Set(headers.map((h) => h.props.color)).size).toBe(3)
    const actionColor = must(headers[2]).props.color
    const actions = notes.filter((n) => n.props.color === actionColor).map(textOf)
    expect(actions.filter((t) => /\nOwner: /.test(t)).length).toBeGreaterThanOrEqual(3)
  })

  it('6 · Tips and shortcuts lists real bindings, the key in bold over what it does', () => {
    // Each key is bound in Lobby: tldraw 5.4.2 defaults (N T F P, Space, Ctrl+Z), canvas-ux (L, M,
    // Alt+1, Ctrl+F), comments (C), present-export (Ctrl+Alt+Enter); docs/FEATURES-M2-CONTRACTS.md §1.
    const expected: Record<string, string> = {
      N: 'Sticky note',
      T: 'Text',
      F: 'Frame',
      L: 'Connector',
      C: 'Comment',
      P: 'Pen',
      'Space + drag': 'Pan around',
      'Ctrl + F': 'Search the board',
      'Alt + 1': 'Zoom to fit',
      'Ctrl + Alt + Enter': 'Present',
      'Ctrl + Z': 'Undo',
      M: 'Minimap',
    }
    const cards = kids(frame('6 · Tips and shortcuts'), 'geo')
    expect(Object.fromEntries(cards.map((c) => textOf(c).split('\n') as [string, string]))).toEqual(expected)
    for (const c of cards) expect(firstLineBold(c)).toBe(true)
    const texts = kids(frame('6 · Tips and shortcuts'), 'text').map(textOf).join(' ')
    expect(texts).toMatch(/On a Mac, Ctrl is Cmd and Alt is Option/)
  })
})

describe('Lobby tour: legible in light and dark mode', () => {
  it('uses DBC orange headings (xl) and orange accents', () => {
    for (const f of framesOf(records)) {
      const heading = must(childrenOf(records, f.id)[0]) as TLTextShape
      expect(heading.type).toBe('text')
      expect([heading.props.color, heading.props.size]).toEqual(['orange', 'xl'])
      expect(heading.isLocked).toBe(true)
    }
    const colors = shapesOf(records).map((s) => (s.props as { color?: string }).color)
    expect(colors.filter((c) => c === 'orange').length).toBeGreaterThanOrEqual(20)
  })

  it('never puts text on a full-colour fill (tldraw has no dark label colour in dark mode)', () => {
    for (const s of shapesOf(records)) {
      if (s.type === 'geo') {
        expect(textOf(s).length).toBeGreaterThan(0)
        expect(s.props.fill, textOf(s)).not.toBe('fill')
        // The label is 'black' (tldraw inverts it in dark mode), or grey for image-slot placeholders.
        expect(s.props.labelColor).toBe(s.meta.draftroomSlot === 'image' ? 'grey' : 'black')
      }
      // Notes keep the default label colour so Lobby's note palette sets an AA text colour.
      if (s.type === 'note') expect((s as TLNoteShape).props.labelColor).toBe('black')
      if (s.type === 'text') expect(['black', 'grey', 'orange']).toContain(s.props.color)
    }
  })

  it('keeps bold titles inside their cards and searchable as plain text', () => {
    for (const g of shapesOf(records).filter((s): s is TLGeoShape => s.type === 'geo')) {
      const text = textOf(g)
      // Bold glyphs run ~6% wider: estimate at a slightly larger font to stay conservative.
      const h = estimateTextHeight(text, LABEL_FONT_PX[g.props.size] * 1.06, g.props.w - LABEL_PADDING * 2)
      expect(h, text).toBeLessThanOrEqual(g.props.h - LABEL_PADDING * 2)
      expect(plainTextOf(g.props.richText)).toBe(text)
    }
    const hit = searchBoard(records as TLRecord[], 'Kick off')
    expect(hit[0]?.text).toMatch(/^Kick off/)
  })
})
