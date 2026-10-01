// The Lobby tour on the new canvas: the tldraw tour's checks (lobby-tour.test.ts) on its Excalidraw
// elements. Structure is read the Excalidraw way (frames hold children through `frameId`, a box's words are
// its bound label, bindings are FixedPointBindings), and text sizes are the engine's own measurements, not
// estimates, so "inside its frame" and "no overlap" are checked with the real text boxes.

import {
  frameOutlineOf,
  LOBBY_INK,
  lobbyColor,
  noteColorName,
  presentationOrderOf,
  searchElements,
  strokeColorName,
} from '@draftroom/board-ops/elements'
import type { WireElement } from '@draftroom/canvas-schema/elements'
import { describe, expect, it } from 'vitest'
import { NOTE_SIZE } from '../common.ts'
import { BRAINSTORM_MAP_RIGHT, TOUR_FRAME_H, TOUR_FRAME_W } from '../templates/lobby-tour.ts'
import { must, rectContains, rectGap, rectsOverlap } from '../test-utils.ts'
import { DISPLAY_FACE_AVAILABLE, FONT_FACE_NAME, FONT_FAMILY, instantiateSceneTemplate } from './index.ts'
import { labelOf, metrics, wordsOf } from './test-kit.ts'

void metrics
const SECTIONS = [
  '1 · Welcome',
  '2 · Brainstorm',
  '3 · Plan',
  '4 · Mood board',
  '5 · Retro',
  '6 · Tips and shortcuts',
]

const { elements, bounds } = instantiateSceneTemplate('lobby-tour', { origin: { x: 0, y: 0 } })
const byId = new Map(elements.map((e) => [e.id, e]))
const rect = (e: WireElement) => ({ x: e.x, y: e.y, w: e.width, h: e.height })
const words = (e: WireElement) => wordsOf(elements, e)
const frame = (name: string) =>
  must(
    elements.find((e) => e.type === 'frame' && e.name === name),
    name,
  )
/** A frame's children (labels excluded), in paint order. */
const kids = (f: WireElement) =>
  elements.filter((e) => e.frameId === f.id && !(e.type === 'text' && e.containerId))
const kidsOf = (f: WireElement, type: WireElement['type']) => kids(f).filter((e) => e.type === type)
const ends = (a: WireElement) =>
  a.type === 'arrow'
    ? [must(byId.get(must(a.startBinding).elementId)), must(byId.get(must(a.endBinding).elementId))]
    : []

describe('Lobby tour on the new canvas: the board', () => {
  it('has six named, equal 16:10 frames in one row, left to right in presentation order', () => {
    const frames = elements.filter((e) => e.type === 'frame')
    expect(frames).toHaveLength(6)
    expect([...frames].sort((a, b) => a.x - b.x).map(words)).toEqual(SECTIONS)
    for (const f of frames) {
      expect(f.y).toBe(0)
      expect([f.width, f.height]).toEqual([TOUR_FRAME_W, TOUR_FRAME_H])
      expect(f.customData).toBeUndefined()
    }
    expect(frameOutlineOf(elements).map((f) => f.name)).toEqual(SECTIONS)
    expect(presentationOrderOf(elements).map((f) => f.name)).toEqual(SECTIONS)
    expect(bounds).toEqual({ x: 0, y: 0, w: 6 * TOUR_FRAME_W + 5 * 160, h: TOUR_FRAME_H })
  })

  it('never overlaps two frames, and keeps every element inside its own frame (measured text)', () => {
    const frames = elements.filter((e) => e.type === 'frame')
    for (let i = 0; i < frames.length; i++)
      for (let j = i + 1; j < frames.length; j++) {
        expect(rectsOverlap(rect(must(frames[i])), rect(must(frames[j])))).toBe(false)
        expect(rectGap(rect(must(frames[i])), rect(must(frames[j])))).toBeGreaterThanOrEqual(120)
      }
    for (const e of elements) {
      if (e.type === 'frame') continue
      const f = must(byId.get(must(e.frameId, `frame of ${e.id}`)))
      expect(rectContains(rect(f), rect(e)), words(e) || e.type).toBe(true)
    }
  })

  it('never overlaps two elements inside a frame (measured text; arrows and labels aside)', () => {
    for (const f of elements.filter((e) => e.type === 'frame')) {
      const solids = kids(f).filter((e) => e.type !== 'arrow')
      for (let i = 0; i < solids.length; i++)
        for (let j = i + 1; j < solids.length; j++) {
          const a = must(solids[i])
          const b = must(solids[j])
          expect(rectsOverlap(rect(a), rect(b)), `"${words(a)}" overlaps "${words(b)}" in ${words(f)}`).toBe(
            false,
          )
        }
    }
  })

  it('binds every arrow at both ends to elements of its own frame', () => {
    for (const a of elements.filter((e) => e.type === 'arrow')) {
      const [from, to] = ends(a)
      expect(from?.frameId).toBe(a.frameId)
      expect(to?.frameId).toBe(a.frameId)
      for (const t of [from, to])
        expect(t?.boundElements?.some((b) => b.id === a.id && b.type === 'arrow')).toBe(true)
    }
  })
})

describe('Lobby tour on the new canvas: the frames', () => {
  it('1 · Welcome says what Lobby is for DBC and offers three "try this" notes', () => {
    const f = frame('1 · Welcome')
    const texts = kidsOf(f, 'text').map(words)
    expect(texts[0]).toBe('Welcome to Lobby')
    expect(texts.join(' ')).toMatch(/Dark Burn Creative/)
    expect(texts).toContain('Try this')
    const notes = kidsOf(f, 'stickynote').map(words)
    expect(notes).toHaveLength(3)
    expect(notes[0]).toMatch(/^Can edit\? Press N\b/)
    expect(notes[1]).toMatch(/^Press C\b/)
    expect(notes[2]).toMatch(/^Click Present\b/)
    expect(kidsOf(f, 'rectangle').map((g) => words(g).split('\n')[0])).toEqual(['Kick off', 'Make', 'Review'])
  })

  it('2 · Brainstorm is a left-to-right map: one question, three themes, each with its ideas in a row', () => {
    const f = frame('2 · Brainstorm')
    const question = must(kidsOf(f, 'ellipse')[0])
    expect(words(question)).toMatch(/hook\?$/)
    const arrows = kidsOf(f, 'arrow')
    expect(arrows).toHaveLength(3)
    const themes = arrows.map((a) => {
      const [from, to] = ends(a)
      expect(from?.id).toBe(question.id)
      return must(to)
    })
    expect(themes.map(words)).toEqual(['Gameplay', 'Story', 'Community'])
    const rows = themes.map((theme) => {
      expect(theme.x).toBeGreaterThan(question.x + question.width)
      const row = kidsOf(f, 'stickynote').filter(
        (n) => Math.abs(n.y + n.height / 2 - (theme.y + theme.height / 2)) < 1 && n.x > theme.x + theme.width,
      )
      for (const n of row) expect(noteColorName(n.backgroundColor)).toBe(strokeColorName(theme.strokeColor))
      return row.length
    })
    expect(rows).toEqual([3, 2, 3])
    expect(kidsOf(f, 'stickynote')).toHaveLength(8)
    // the map ends at BRAINSTORM_MAP_RIGHT: the column to its right stays free for a revealed brainstorm
    const [heading, intro, ...map] = kids(f).filter((e) => e.type !== 'arrow')
    expect([heading, intro].map((t) => must(t).type)).toEqual(['text', 'text'])
    for (const e of map) expect(e.x + e.width - f.x, words(e)).toBeLessThanOrEqual(BRAINSTORM_MAP_RIGHT)
    const column = {
      x: f.x + BRAINSTORM_MAP_RIGHT + 40,
      y: must(intro).y + must(intro).height + 40,
      w: NOTE_SIZE,
      h: 3 * NOTE_SIZE + 2 * 24,
    }
    expect(rectContains(rect(f), { ...column, h: column.h + 40 })).toBe(true)
  })

  it('3 · Plan is a process diagram whose arrows are bound at both ends, with an elbow review loop', () => {
    const f = frame('3 · Plan')
    const named = (text: string) =>
      must(
        kids(f).find((e) => words(e) === text && e.type !== 'text'),
        text,
      )
    const flow = ['Brief', 'Concepts', 'Client\nreview', 'Production', 'Delivery'].map(named)
    expect(named('Client\nreview').type).toBe('diamond')
    const arrows = kidsOf(f, 'arrow')
    const links = arrows.map((a) => ends(a).map((e) => e.id))
    for (let i = 0; i + 1 < flow.length; i++) {
      expect(links).toContainEqual([must(flow[i]).id, must(flow[i + 1]).id])
      expect(must(flow[i + 1]).x).toBeGreaterThan(must(flow[i]).x + must(flow[i]).width)
    }
    const changes = named('Changes')
    const loop = arrows.filter((a) => ends(a).some((e) => e.id === changes.id))
    expect(loop).toHaveLength(2)
    for (const a of arrows) {
      if (a.type !== 'arrow') continue
      expect(a.endArrowhead).toBe('arrow')
      const inLoop = loop.includes(a)
      expect([a.elbowed, a.strokeStyle]).toEqual(inLoop ? [true, 'dashed'] : [false, 'solid'])
    }
  })

  it('4 · Mood board: two captioned reference slots, a named palette, three type samples named after their faces', () => {
    const f = frame('4 · Mood board')
    const boxes = kidsOf(f, 'rectangle')
    const slots = boxes.filter((b) => b.customData?.lobby?.slot === 'image')
    const swatches = boxes.filter((b) => b.customData?.lobby?.swatch === 'color')
    expect(slots.length + swatches.length).toBe(boxes.length)
    expect(slots).toHaveLength(2)
    const texts = kidsOf(f, 'text')
    for (const s of slots) {
      expect([s.locked, s.strokeStyle, words(s)]).toEqual([true, 'dashed', 'Drop a reference here'])
      expect(s.width / s.height).toBeCloseTo(16 / 9, 1)
      const caption = texts.filter(
        (c) => Math.abs(c.x - s.x) < 1 && c.y > s.y + s.height && c.y - (s.y + s.height) < 40,
      )
      expect(caption).toHaveLength(1)
      expect(must(caption[0]).locked).toBe(false)
    }
    expect(swatches.length).toBeGreaterThanOrEqual(4)
    expect(must(swatches[0]).backgroundColor).toBe(lobbyColor('orange').fill)
    for (const s of swatches) {
      expect(labelOf(elements, s.id)).toBeUndefined()
      const name = texts.filter(
        (t) => t.x > s.x + s.width && t.x - (s.x + s.width) < 40 && t.y >= s.y - 1 && t.y < s.y + s.height,
      )
      expect(name.length).toBeGreaterThanOrEqual(1)
    }
    // W5-17 / D3: no new fonts, so the samples pair the display face (Lilita One) with Nunito, each role
    // names the face its sample is set in, and nothing calls Comic Shanns "mono" or Excalifont a display
    // face. Until the server accepts Lilita One every sample is Nunito, and the roles say "sans".
    const family = (t: WireElement) => (t.type === 'text' ? t.fontFamily : 0)
    expect(new Set(texts.map(family))).toEqual(new Set([6, FONT_FAMILY.display]))
    const roleTexts = texts.filter((t) => /^(Display|Body|HUD) · /.test(words(t)))
    expect(roleTexts.map(words)).toEqual(
      DISPLAY_FACE_AVAILABLE
        ? ['Display · Lilita One', 'Body · Nunito', 'HUD · Lilita One']
        : ['Display · sans', 'Body · sans', 'HUD · sans'],
    )
    for (const role of roleTexts) {
      // the sample is the text right of its role, on the same line
      const sample = must(
        texts.find(
          (t) => t.x > role.x + role.width && Math.abs(t.y + t.height / 2 - (role.y + role.height / 2)) < 40,
        ),
        words(role),
      )
      const face = words(role).split(' · ')[1]
      const named = family(sample) === 6 ? ['sans', 'Nunito'] : [FONT_FACE_NAME[family(sample)]]
      expect(named, `${words(role)} over "${words(sample)}"`).toContain(face)
    }
    expect(texts.map(words).join(' ')).not.toMatch(/mono|hand-drawn|serif/i)
  })

  it('5 · Retro has Went well, To improve and Actions, left to right, each with its own notes', () => {
    const f = frame('5 · Retro')
    const headers = kidsOf(f, 'rectangle')
    expect(headers.map(words)).toEqual(['Went well', 'To improve', 'Actions'])
    for (const h of headers) {
      const column = kidsOf(f, 'stickynote').filter(
        (n) => n.x >= h.x - 1 && n.x + n.width <= h.x + h.width + 1 && n.y > h.y + h.height,
      )
      expect(column.length).toBeGreaterThanOrEqual(3)
      for (const n of column) expect(noteColorName(n.backgroundColor)).toBe(strokeColorName(h.strokeColor))
    }
  })

  it('6 · Tips and shortcuts lists the real bindings, the key over what it does', () => {
    // W5-59: with this page's way round the board: F6 (the keyboard to the board), Alt + arrows (next or
    // previous item) and Ctrl/Cmd + Shift + Down / Up (into a frame and back out), the bindings of
    // apps/web/src/features/a11y/ported/index.tsx
    const cards = kidsOf(frame('6 · Tips and shortcuts'), 'rectangle')
    expect(Object.fromEntries(cards.map((c) => words(c).split('\n') as [string, string]))).toEqual({
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
      F6: 'Keyboard to the board',
      'Alt + arrows': 'Next or previous item',
      'Ctrl + Shift + Down': 'Into a frame',
      'Ctrl + Shift + Up': 'Out of a frame',
    })
    const texts = kidsOf(frame('6 · Tips and shortcuts'), 'text').map(words).join(' ')
    expect(texts).toMatch(
      /Press \? for every other shortcut, or open Keyboard shortcuts from the menu at the top left/,
    )
    expect(texts).not.toMatch(/main menu/i)
  })
})

describe('Lobby tour on the new canvas: legible in light and dark mode', () => {
  it('uses DBC orange 44 px headings, locked', () => {
    for (const f of elements.filter((e) => e.type === 'frame')) {
      const heading = must(kids(f)[0])
      expect(heading.type).toBe('text')
      if (heading.type !== 'text') continue
      expect([heading.strokeColor, heading.fontSize, heading.locked]).toEqual([
        lobbyColor('orange').solid,
        44,
        true,
      ])
    }
  })

  it('never puts words on a full-colour fill; labels are the dark ink, note labels the note ink', () => {
    for (const e of elements) {
      if (e.type === 'rectangle' || e.type === 'ellipse' || e.type === 'diamond') {
        const label = labelOf(elements, e.id)
        if (e.customData?.lobby?.swatch) {
          expect(label).toBeUndefined()
          continue
        }
        expect(label).toBeDefined()
        expect(label?.strokeColor).toBe(
          e.customData?.lobby?.slot ? lobbyColor('grey').solid : lobbyColor('black').solid,
        )
      }
      if (e.type === 'stickynote')
        expect([e.strokeColor, labelOf(elements, e.id)?.strokeColor]).toEqual([LOBBY_INK, LOBBY_INK])
      if (e.type === 'text' && !e.containerId)
        expect(['black', 'grey', 'orange'].map((c) => lobbyColor(c).solid)).toContain(e.strokeColor)
    }
  })

  it('keeps card titles searchable as plain text', () => {
    expect(
      words(
        must(
          searchElements(elements, 'Kick off')[0] &&
            byId.get(must(searchElements(elements, 'Kick off')[0]).id),
        ),
      ),
    ).toMatch(/^Kick off/)
  })
})
