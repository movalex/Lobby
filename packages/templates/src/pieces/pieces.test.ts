// L8-3: every piece, as the elements it makes. Each one passes the server's own element check and the
// cross-element invariants, has no field outside the field groups, carries its kind on every element, has
// fresh ids on every call, keeps a picture to an empty slot (no file, no data: or blob: anywhere), moves as one
// group, and is the same at any origin.
import { newElementId } from '@draftroom/board-ops/elements'
import { lobbyKeySpec } from '@draftroom/canvas-schema/custom-data'
import { checkElement } from '@draftroom/canvas-schema/elements'
import { installServerTextMetrics } from '@draftroom/canvas-schema/engine'
import { unclassifiedKeys } from '@draftroom/canvas-schema/groups'
import { checkInvariants } from '@draftroom/canvas-schema/invariants'
import { describe, expect, it } from 'vitest'
import {
  insertLabel,
  instantiatePiece,
  isPieceId,
  PIECE_CATEGORIES,
  PIECE_IDS,
  PIECES,
  type PieceId,
  pieceInfo,
  pieceKind,
  searchPieces,
} from './index.ts'

// the Node side of the engine's text layout, installed before any piece is built (the describe blocks build at collection)
installServerTextMetrics()

const ORIGIN = { x: 0, y: 0 }
const NOW = 1_790_000_000_000
const seq = (prefix: string) => {
  let n = 0
  return () => `${prefix}${++n}`
}

const lobbyOf = (e: { customData?: { lobby?: Record<string, unknown> } }) => e.customData?.lobby ?? {}

describe('the catalogue', () => {
  it('lists every piece once, with a name, a category, a sentence and words to find it by', () => {
    expect(PIECES.map((p) => p.id)).toEqual([...PIECE_IDS])
    expect(new Set(PIECES.map((p) => p.id)).size).toBe(PIECES.length)
    expect(new Set(PIECES.map((p) => p.name.toLowerCase())).size).toBe(PIECES.length)
    const cats = PIECE_CATEGORIES.map((c) => c.id)
    for (const p of PIECES) {
      expect(cats, p.id).toContain(p.category)
      expect(p.name.length, p.id).toBeGreaterThan(2)
      expect(p.description, p.id).toMatch(/^[A-Z].*\.$/)
      expect(p.keywords.length, p.id).toBeGreaterThan(2)
      expect(p.w, p.id).toBeGreaterThan(0)
      expect(p.h, p.id).toBeGreaterThan(0)
    }
  })

  it('has the four kits the brief names, with every piece in them', () => {
    const by = (c: string) => PIECES.filter((p) => p.category === c).map((p) => p.id)
    expect(by('flowchart')).toEqual([
      'process',
      'decision',
      'terminator',
      'data',
      'document',
      'subprocess',
      'swimlane',
    ])
    expect(by('wireframe')).toEqual([
      'browser',
      'phone',
      'button',
      'input',
      'checkbox',
      'toggle',
      'card',
      'navbar',
      'modal',
      'image',
    ])
    expect(by('org-chart')).toEqual(['person'])
    expect(by('agency')).toEqual(['shot', 'storyboard', 'persona', 'stage'])
  })

  it('keeps every kind within the schema’s 32 characters, and the id a valid kind word', () => {
    for (const id of PIECE_IDS) {
      const kind = pieceKind(id)
      expect(kind.length, kind).toBeLessThanOrEqual(32)
      expect(lobbyKeySpec('kind')?.value.safeParse(kind).success, kind).toBe(true)
    }
  })

  it('knows an id from a lookalike', () => {
    expect(isPieceId('decision')).toBe(true)
    for (const bad of ['Decision', 'decisions', '', 'piece-decision', 'constructor', undefined, 4])
      expect(isPieceId(bad)).toBe(false)
    expect(pieceInfo('decision')?.name).toBe('Decision')
    expect(pieceInfo('nope')).toBeUndefined()
    expect(insertLabel(pieceInfo('decision') as never)).toBe('Insert decision')
    expect(insertLabel(pieceInfo('subprocess') as never)).toBe('Insert sub-process')
  })

  it('searches by the start of a name first, then a word of it, then its keywords and category', () => {
    expect(searchPieces('dec')[0]?.id).toBe('decision')
    expect(searchPieces('DEC')[0]?.id).toBe('decision')
    expect(searchPieces('  dec  ').map((p) => p.id)).toContain('decision')
    expect(searchPieces('branch')[0]?.id).toBe('decision')
    expect(searchPieces('journey')[0]?.id).toBe('stage')
    expect(searchPieces('nav')[0]?.id).toBe('navbar')
    expect(searchPieces('image')[0]?.id).toBe('image')
    // every word must match
    expect(searchPieces('flowchart decision').map((p) => p.id)).toEqual(['decision'])
    expect(searchPieces('zzzz')).toEqual([])
    // a category narrows, an empty query lists them all in catalogue order
    expect(searchPieces('', 'org-chart').map((p) => p.id)).toEqual(['person'])
    expect(searchPieces('').map((p) => p.id)).toEqual([...PIECE_IDS])
    expect(searchPieces('card', 'agency').map((p) => p.id)).toEqual(['shot'])
  })
})

describe.each(PIECE_IDS.map((id) => [id] as const))('piece %s', (id: PieceId) => {
  const info = pieceInfo(id) as NonNullable<ReturnType<typeof pieceInfo>>
  const make = (origin = ORIGIN) => instantiatePiece(id, { origin }, { newId: seq(`${id}_`), now: NOW })
  const piece = make()

  it('passes the server’s element check and the cross-element invariants', () => {
    expect(piece.elements.length).toBeGreaterThan(0)
    for (const el of piece.elements) {
      const check = checkElement(el)
      expect(check.ok, `${el.type}: ${check.ok ? '' : check.detail}`).toBe(true)
    }
    expect(checkInvariants(piece.elements)).toEqual([])
    // and customData is valid, key by key
    for (const el of piece.elements)
      for (const [k, v] of Object.entries(lobbyOf(el)))
        expect(lobbyKeySpec(k)?.value.safeParse(v).success, `${k} on ${el.type}`).toBe(true)
  })

  it('has no field outside the field groups', () => {
    for (const el of piece.elements) expect(unclassifiedKeys(el as never), `${el.type}`).toEqual([])
  })

  it('carries its kind on every element, create-only and within 32 characters', () => {
    for (const el of piece.elements) {
      expect(lobbyOf(el).kind, el.type).toBe(pieceKind(id))
      expect(String(lobbyOf(el).kind).length).toBeLessThanOrEqual(32)
    }
  })

  it('has fresh ids on every call, and distinct ids within itself', () => {
    const a = instantiatePiece(id, { origin: ORIGIN })
    const b = instantiatePiece(id, { origin: ORIGIN })
    const ids = a.elements.map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    const seen = new Set(ids)
    for (const e of b.elements) expect(seen.has(e.id), e.id).toBe(false)
    // the default source is the board's own id generator
    expect(newElementId()).not.toBe(ids[0])
  })

  it('stores no picture: slots are empty, and nothing holds a file, an address or bytes', () => {
    const json = JSON.stringify(piece.elements)
    expect(json).not.toMatch(/data:|blob:|base64|https?:|fileId|assetId|\/\//i)
    expect(piece.elements.some((e) => e.type === 'image')).toBe(false)
    expect(piece.elements.every((e) => e.link === null)).toBe(true)
    for (const e of piece.elements) {
      const slot = lobbyOf(e).slot
      if (slot !== undefined) expect(slot).toBe('image')
    }
  })

  it('is one group when it is several elements (a bound label goes with its container), none when it is one', () => {
    const outer = piece.elements.filter((e) => !(e.type === 'text' && e.containerId))
    if (info.frame || outer.length === 1) {
      for (const e of piece.elements) expect(e.groupIds, e.type).toEqual([])
      return
    }
    const g = piece.elements[0]?.groupIds ?? []
    expect(g).toHaveLength(1)
    for (const e of piece.elements) expect(e.groupIds, e.type).toEqual(g)
  })

  it('keeps a bound label after its container, and never locks anything or nests a frame', () => {
    for (const e of piece.elements) {
      expect(e.locked, e.type).toBe(false)
      if (e.type === 'text' && e.containerId) {
        const c = piece.elements.findIndex((x) => x.id === e.containerId)
        expect(c).toBeGreaterThanOrEqual(0)
        expect(piece.elements.indexOf(e)).toBeGreaterThan(c)
      }
      if (e.type === 'frame') expect(e.frameId).toBeNull()
    }
    expect(piece.frame).toBe(!!info.frame)
    if (info.frame) expect(piece.elements.every((e) => e.frameId === null)).toBe(true)
  })

  it('has the size the catalogue says (to a pixel or two) and its elements inside its bounds', () => {
    expect(piece.bounds.w).toBeCloseTo(info.w, -1)
    expect(Math.abs(piece.bounds.h - info.h)).toBeLessThanOrEqual(24)
    // the pieces start at their top-left (a checkbox and a toggle sit two pixels down in their line)
    expect(Math.abs(piece.bounds.x)).toBeLessThanOrEqual(4)
    expect(Math.abs(piece.bounds.y)).toBeLessThanOrEqual(4)
  })

  it('selects its outer elements (not its labels) and sits on top of the board', () => {
    const labels = new Set(piece.elements.filter((e) => e.type === 'text' && e.containerId).map((e) => e.id))
    expect(piece.topLevelIds.length).toBeGreaterThan(0)
    for (const t of piece.topLevelIds) expect(labels.has(t)).toBe(false)
    const above = instantiatePiece(id, { origin: ORIGIN, indexAbove: 'a5' })
    for (const e of above.elements) expect((e.index as string) > 'a5').toBe(true)
    const indices = above.elements.map((e) => e.index)
    expect(new Set(indices).size).toBe(indices.length)
    expect([...indices].sort()).toEqual(indices)
  })

  it('is the same at any origin, moved', () => {
    const moved = make({ x: 500, y: -300 })
    expect(moved.elements).toHaveLength(piece.elements.length)
    piece.elements.forEach((e, i) => {
      const m = moved.elements[i]
      expect(m?.type).toBe(e.type)
      expect(Math.abs((m?.x as number) - (e.x as number) - 500)).toBeLessThan(0.01)
      expect(Math.abs((m?.y as number) - (e.y as number) + 300)).toBeLessThan(0.01)
      expect(m?.width).toBe(e.width)
      expect(m?.height).toBe(e.height)
    })
  })

  it('says something in its words: a label or a text for every box that is not a decoration', () => {
    const words = piece.elements
      .filter((e) => e.type === 'text')
      .map((e) => (e as { originalText: string }).originalText)
    if (info.id === 'swimlane') {
      expect((piece.elements[0] as { name: string }).name).toBe('Swimlane')
      return
    }
    if (id === 'image') expect(words).toEqual(['Image'])
    else expect(words.length).toBeGreaterThan(0)
    for (const w of words) expect(w.trim().length).toBeGreaterThan(0)
  })
})

describe('what each kit is made of', () => {
  const make = (id: PieceId) => instantiatePiece(id, { origin: ORIGIN }, { newId: seq(`${id}_`), now: NOW })
  const types = (id: PieceId) => make(id).elements.map((e) => e.type)

  it('flowchart shapes are the engine’s own: a rectangle, a diamond, a rounded rectangle, polygons and a frame', () => {
    expect(types('process')).toEqual(['rectangle', 'text'])
    expect(types('decision')).toEqual(['diamond', 'text'])
    expect(types('terminator')).toEqual(['rectangle', 'text'])
    expect(make('terminator').elements[0]).toMatchObject({ roundness: { type: 3, value: 32 } })
    expect(types('swimlane')).toEqual(['frame'])
  })

  it('data and document are polygons as canvas-ux makes them: a closed line under a see-through box, one group', () => {
    for (const id of ['data', 'document'] as const) {
      const [line, box, label] = make(id).elements
      expect(line).toMatchObject({ type: 'line', polygon: true })
      const pts = (line as { points: [number, number][] }).points
      expect(pts[0]).toEqual([0, 0])
      expect(pts.at(-1)).toEqual(pts[0])
      expect(box).toMatchObject({
        type: 'rectangle',
        strokeColor: 'transparent',
        backgroundColor: 'transparent',
      })
      expect(label).toMatchObject({ type: 'text', containerId: (box as { id: string }).id })
      expect((line as { groupIds: string[] }).groupIds).toEqual((box as { groupIds: string[] }).groupIds)
      expect((line as { index: string }).index < (box as { index: string }).index).toBe(true)
    }
  })

  it('a sub-process has its two bars between the box and its label', () => {
    const els = make('subprocess').elements
    expect(els.map((e) => e.type)).toEqual(['rectangle', 'line', 'line', 'text'])
  })

  it('a card, an image, a person, a shot, a storyboard panel and a persona have an image slot, never an image', () => {
    for (const id of ['card', 'image', 'person', 'shot', 'storyboard', 'persona'] as const) {
      const slots = make(id).elements.filter((e) => lobbyOf(e).slot === 'image')
      expect(slots.length, id).toBe(1)
      expect(slots[0]).toMatchObject({ type: 'rectangle', strokeStyle: 'dashed', locked: false })
    }
  })

  it('a text field’s placeholder reads from the left', () => {
    const label = make('input').elements.find((e) => e.type === 'text')
    expect(label).toMatchObject({ textAlign: 'left' })
  })
})
