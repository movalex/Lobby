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
import { getTemplate, IMAGE_SLOT_META, instantiateTemplate, SWATCH_META } from './index.ts'
import { estimateTextHeight, LABEL_FONT_PX, LABEL_PADDING, NOTE_SIZE } from './layout.ts'
import {
  BRAINSTORM_MAP_RIGHT,
  LOBBY_TOUR_SECTIONS,
  TOUR_FRAME_H,
  TOUR_FRAME_W,
} from './templates/lobby-tour.ts'
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
    expect(notes[0]).toMatch(/^Can edit\? Press N\b/)
    expect(notes[1]).toMatch(/^Press C\b/)
    expect(notes[2]).toMatch(/^Click Present\b/)
    // DANA-11: nothing on it tells a commenting client the board is theirs to edit.
    expect(texts.join(' ')).not.toMatch(/yours to play with/)
    const pillars = kids(f, 'geo')
    expect(pillars.map((g) => textOf(g).split('\n')[0])).toEqual(['Kick off', 'Make', 'Review'])
    for (const p of pillars) expect(firstLineBold(p)).toBe(true)
  })

  /** The question, and its three themes in connector order. */
  function brainstormParts() {
    const f = frame('2 · Brainstorm')
    const question = must(kids(f, 'geo').find((g) => g.props.geo === 'ellipse'))
    const arrows = arrowsOf(records).filter((a) => a.parentId === f.id)
    const themes = arrows.map((a) => {
      const [from, to] = ends(a.id)
      expect(from.id).toBe(question.id)
      expect(to.type).toBe('geo')
      return to as TLGeoShape
    })
    return { f, question, arrows, themes }
  }

  it('2 · Brainstorm is a left-to-right map: one question, three themes, each theme with its ideas in a row', () => {
    const { f, question, arrows, themes } = brainstormParts()
    expect(textOf(question)).toMatch(/hook\?$/)
    expect(arrows).toHaveLength(3)
    expect(themes.map(textOf)).toEqual(['Gameplay', 'Story', 'Community'])
    const q = pageRect(question, shapes)
    const rows = themes.map((theme) => {
      const t = pageRect(theme, shapes)
      expect(t.x, `${textOf(theme)} right of the question`).toBeGreaterThan(q.x + q.w)
      // Its ideas: the notes on its row (vertically centred on it), to its right.
      const row = kids(f, 'note').filter((n) => {
        const r = pageRect(n, shapes)
        return Math.abs(r.y + r.h / 2 - (t.y + t.h / 2)) < 1 && r.x > t.x + t.w
      })
      for (const n of row) expect(n.props.color).toBe(theme.props.color)
      const first = Math.min(...row.map((n) => pageRect(n, shapes).x))
      expect(first - (t.x + t.w), `ideas next to ${textOf(theme)}`).toBeLessThan(80)
      return row.length
    })
    expect(rows).toEqual([3, 2, 3])
    // Every note belongs to one of the rows.
    expect(kids(f, 'note')).toHaveLength(8)
  })

  it('2 · Brainstorm: a theme dragged 120 down lands on empty canvas, and the Story row has room for one more idea (DEMO.md 1:00)', () => {
    const { f, themes } = brainstormParts()
    const solid = childrenOf(records, f.id).filter((s) => s.type !== 'arrow')
    const frameRect = pageRect(f, shapes)
    for (const theme of themes) {
      const t = pageRect(theme, shapes)
      const moved = { ...t, y: t.y + 120 }
      expect(rectContains(frameRect, moved), `${textOf(theme)} stays in the frame`).toBe(true)
      for (const s of solid) {
        if (s.id === theme.id) continue
        expect(rectsOverlap(moved, pageRect(s, shapes)), `${textOf(theme)} dragged onto "${textOf(s)}"`).toBe(
          false,
        )
      }
    }
    // The Story row's third place is empty: B's note goes there in the demo.
    const story = pageRect(must(themes[1]), shapes)
    const notes = kids(f, 'note').map((n) => pageRect(n, shapes))
    const storyNotes = notes.filter((r) => Math.abs(r.y + r.h / 2 - (story.y + story.h / 2)) < 1)
    const last = storyNotes.reduce((a, b) => (a.x > b.x ? a : b))
    const slot = { x: last.x + last.w + 20, y: last.y, w: last.w, h: last.h }
    expect(rectContains(frameRect, slot)).toBe(true)
    for (const s of solid) expect(rectsOverlap(slot, pageRect(s, shapes)), textOf(s)).toBe(false)
  })

  it('2 · Brainstorm keeps a column one note wide free on its right, for a private brainstorm revealed into it (round-2 F5)', () => {
    const { f } = brainstormParts()
    const frameRect = pageRect(f, shapes)
    const [heading, intro, ...map] = childrenOf(records, f.id).filter((s) => s.type !== 'arrow')
    expect([heading, intro].map((t) => must(t).type)).toEqual(['text', 'text'])
    // The map ends at BRAINSTORM_MAP_RIGHT; the column after it (40 px clear of it, as apps/sync
    // place-notes keeps) ends on the frame's 80 px margin.
    for (const s of map) {
      const r = pageRect(s, shapes)
      expect(r.x + r.w - frameRect.x, textOf(s) || s.type).toBeLessThanOrEqual(BRAINSTORM_MAP_RIGHT)
    }
    expect(BRAINSTORM_MAP_RIGHT + 40 + NOTE_SIZE).toBe(TOUR_FRAME_W - 80)
    // Three stacked sticky notes fit in it under the intro, above the frame's bottom padding.
    const introBottom = pageRect(must(intro), shapes).y + pageRect(must(intro), shapes).h - frameRect.y
    const column = {
      x: frameRect.x + BRAINSTORM_MAP_RIGHT + 40,
      y: frameRect.y + introBottom + 40,
      w: NOTE_SIZE,
      h: 3 * NOTE_SIZE + 2 * 24,
    }
    expect(rectContains(frameRect, { ...column, h: column.h + 40 })).toBe(true)
    for (const s of map) expect(rectsOverlap(column, pageRect(s, shapes)), textOf(s)).toBe(false)
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

  it('4 · Mood board is a finished-looking direction, not a wall of empty boxes (F10)', () => {
    const f = frame('4 · Mood board')
    const texts = kids(f, 'text')
    const geos = kids(f, 'geo')
    const slots = geos.filter((g) => g.meta.draftroomSlot === 'image')
    const swatches = geos.filter((g) => g.meta.draftroomSwatch === 'color')
    // Nothing else: every geo shape is a slot or a swatch.
    expect(slots.length + swatches.length).toBe(geos.length)
    // Section labels, locked like headings.
    const labels = texts.filter((t) => ['References', 'Palette', 'Type'].includes(textOf(t)))
    expect(labels.map(textOf)).toEqual(['References', 'Palette', 'Type'])
    for (const l of labels) expect(l.isLocked).toBe(true)

    // A couple of reference slots with a clear call to action, each captioned right under it.
    expect(slots).toHaveLength(2)
    for (const slot of slots) {
      expect(slot.meta).toEqual(IMAGE_SLOT_META)
      expect(slot.isLocked).toBe(true)
      expect(slot.props.dash).toBe('dashed')
      expect(textOf(slot)).toBe('Drop a reference here')
      expect(slot.props.w / slot.props.h).toBeCloseTo(16 / 9, 1)
      const s = pageRect(slot, shapes)
      const caption = texts.filter((c) => {
        const r = pageRect(c, shapes)
        return Math.abs(r.x - s.x) < 1 && r.y > s.y + s.h && r.y - (s.y + s.h) < 40
      })
      expect(caption, `caption under slot at ${s.x},${s.y}`).toHaveLength(1)
      expect(must(caption[0]).isLocked).toBe(false)
    }

    // A palette: full-colour swatches, each named by a text right of it. Colours that keep their hue in
    // tldraw's dark theme (black and white swap there, so a "charcoal" swatch would turn white).
    expect(swatches.length).toBeGreaterThanOrEqual(4)
    const colors = swatches.map((s) => s.props.color)
    expect(new Set(colors).size).toBe(colors.length)
    expect(colors[0]).toBe('orange') // DBC orange leads
    for (const s of swatches) {
      expect(['black', 'white']).not.toContain(s.props.color)
      expect([s.props.fill, textOf(s), s.isLocked]).toEqual(['fill', '', false])
      const r = pageRect(s, shapes)
      const name = texts.filter((t) => {
        const tr = pageRect(t, shapes)
        return tr.x > r.x + r.w && tr.x - (r.x + r.w) < 40 && tr.y >= r.y - 1 && tr.y < r.y + r.h
      })
      expect(name.length, `name next to the ${s.props.color} swatch`).toBeGreaterThanOrEqual(1)
      expect(textOf(must(name[0])).length).toBeGreaterThan(2)
    }

    // Type samples in three of tldraw's fonts, each labelled with its role.
    const fonts = new Set(texts.map((t) => t.props.font))
    for (const font of ['serif', 'sans', 'mono'] as const) expect(fonts).toContain(font)
    const roles = texts.map(textOf).filter((t) => /^(Display|Body|HUD) · (serif|sans|mono)$/.test(t))
    expect(roles).toEqual(['Display · serif', 'Body · sans', 'HUD · mono'])
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
    // W5-59: the keyboard's way round the board too (tldraw's SelectTool Idle: Tab / Shift+Tab select the
    // next / previous shape in reading order, Ctrl+Shift+Down / Up go into a frame and back out).
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
      Tab: 'Next item',
      'Shift + Tab': 'Previous item',
      'Ctrl + Shift + Down': 'Into a frame',
      'Ctrl + Shift + Up': 'Out of a frame',
    }
    const cards = kids(frame('6 · Tips and shortcuts'), 'geo')
    expect(Object.fromEntries(cards.map((c) => textOf(c).split('\n') as [string, string]))).toEqual(expected)
    for (const c of cards) expect(firstLineBold(c)).toBe(true)
    const texts = kids(frame('6 · Tips and shortcuts'), 'text').map(textOf).join(' ')
    expect(texts).toMatch(/On a Mac, Ctrl is Cmd and Alt is Option/)
    // W5-59: the way to every other shortcut works on both pages ("?" and the menu at the top left: the
    // tldraw page's main menu, the new canvas's Board menu); "the main menu" named only tldraw's
    expect(texts).toMatch(/Press \? for every other shortcut/)
    expect(texts).toMatch(/Keyboard shortcuts from the menu at the top left/)
    expect(texts).not.toMatch(/main menu/i)
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
      // Colour swatches are the one full fill, and they carry no text (their names sit beside them).
      if (s.type === 'geo' && s.meta.draftroomSwatch === 'color') {
        expect(s.meta).toEqual(SWATCH_META)
        expect(textOf(s)).toBe('')
        continue
      }
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
