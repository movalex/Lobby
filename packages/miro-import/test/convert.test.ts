// The Miro converter (packages/miro-import, wave R WS1) over the fixture boards in Miro's documented answer shapes:
// each mapping row of the design's §1.3, geometry with frames and rotation, connectors (bindings, caps, captions, an
// end Lobby did not make), the group-span rule, tags, files (stored, not imported yet, invalid), the placeholders
// and the report. Every board it makes passes the server's own element check and cross-element invariants.
import { checkElement, type WireElement } from '@draftroom/canvas-schema/elements'
import {
  type ArrowElementLike,
  boundEndsOffEdge,
  type EngineElement,
  installedServerTextMetrics,
  installServerTextMetrics,
} from '@draftroom/canvas-schema/engine'
import { checkInvariants } from '@draftroom/canvas-schema/invariants'
import { IMPORT_REPORT_MAX_BYTES, MIRO_ITEM_TYPES } from '@draftroom/contracts'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  EMPTY_ID,
  fixtureBoards,
  fixtureSeedBody,
  SPRINT_IDS as I,
  RETRO_ID,
  SPRINT_ID,
} from '../src/fixtures.ts'
import {
  convertMiroBoard,
  MAPPED_ITEM_TYPES,
  type MiroFileOutcome,
  type MiroSeedBody,
  STICKY_TABLE,
} from '../src/index.ts'

// biome-ignore lint/suspicious/noExplicitAny: elements are JSON, read field by field
type El = Record<string, any> & { id: string; type: string }

/** U+202E RIGHT-TO-LEFT OVERRIDE (written by code point: the source stays free of invisible characters) */
const RLO = String.fromCodePoint(0x202e)

beforeAll(() => {
  if (!installedServerTextMetrics()) installServerTextMetrics()
})

const board = (id: string) => {
  const b = fixtureBoards().find((x) => x.id === id)
  if (!b) throw new Error(id)
  return b
}

const STORED: Record<string, MiroFileOutcome> = {
  [I.image]: {
    stored: {
      assetId: 'ast_Image000000001',
      versionId: 'ver_Image000000001',
      kind: 'image',
      name: 'diagram.png',
      mimeType: 'image/png',
      sizeBytes: 1234,
    },
  },
  [I.imageAgain]: {
    stored: {
      assetId: 'ast_Image000000001',
      versionId: 'ver_Image000000001',
      kind: 'image',
      name: 'diagram.png',
      mimeType: 'image/png',
      sizeBytes: 1234,
    },
  },
  [I.document]: {
    stored: {
      assetId: 'ast_Doc0000000001',
      versionId: 'ver_Doc0000000001',
      kind: 'pdf',
      name: 'brief.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 999,
    },
  },
}

function convert(body: MiroSeedBody) {
  let n = 0
  return convertMiroBoard(body, { now: 1_760_000_000_000, newId: () => `e${++n}`, seed: () => 7 })
}

function sprint(files: Record<string, MiroFileOutcome> | null = null) {
  const out = convert(fixtureSeedBody(board(SPRINT_ID), files))
  const els = out.elements as unknown as El[]
  const byId = new Map(els.map((e) => [e.id, e]))
  const rowOf = (miroId: string) => {
    const r = out.report.rows.find((x) => x.sourceId === miroId)
    if (!r) throw new Error(`no row for ${miroId}`)
    return r
  }
  const elOf = (miroId: string) => {
    const id = rowOf(miroId).elementId
    const el = id ? byId.get(id) : undefined
    if (!el) throw new Error(`no element for ${miroId}`)
    return el
  }
  const labelOf = (el: El) => els.find((e) => e.type === 'text' && e.containerId === el.id)
  return { out, els, byId, rowOf, elOf, labelOf }
}

describe('every Miro item type', () => {
  it('has a mapping (MIRO_ITEM_TYPES = the converter’s types)', () => {
    expect([...MAPPED_ITEM_TYPES].sort()).toEqual([...MIRO_ITEM_TYPES].sort())
  })

  it('converts the fixture board into elements the server accepts, one report row per item and connector', () => {
    const s = sprint(STORED)
    for (const el of s.out.elements) expect(checkElement(el).ok, el.type).toBe(true)
    expect(checkInvariants(s.out.elements)).toEqual([])
    const b = board(SPRINT_ID)
    expect(s.out.report.total).toBe(b.items.length + b.connectors.length)
    expect(s.out.report.rows.length).toBe(s.out.report.total)
    expect(s.out.report.rowsOmitted).toBe(0)
    const c = s.out.report.counts
    expect(c.native + c.approximate + c.placeholder + c.failed + c.skipped).toBe(s.out.report.total)
    // every type the board holds is in byType
    for (const t of new Set(b.items.map((i) => i.type as string))) expect(s.out.report.byType[t]).toBeTruthy()
    expect(s.out.report.byType.connector).toBeTruthy()
    // no content in the report: ids, types and codes only
    const text = JSON.stringify(s.out.report)
    for (const words of ['Hello', 'Process', 'Ship the importer', 'next', 'Sprint 42'])
      expect(text).not.toContain(words)
  })

  it('a small board and an empty one', () => {
    const retro = convert(fixtureSeedBody(board(RETRO_ID)))
    expect(retro.elements.filter((e) => e.type === 'stickynote')).toHaveLength(3)
    expect(retro.report.counts.native).toBe(3)
    const empty = convert(fixtureSeedBody(board(EMPTY_ID)))
    expect(empty.elements).toEqual([])
    expect(empty.report.total).toBe(0)
  })
})

describe('frames and geometry', () => {
  it('a frame keeps its name and box; its children are in it, at their place inside it', () => {
    const s = sprint()
    const frame = s.elOf(I.frame)
    expect(frame).toMatchObject({
      type: 'frame',
      name: 'Sprint 42',
      x: -1000,
      y: -600,
      width: 2000,
      height: 1200,
    })
    const note = s.elOf(I.noteHello)
    expect(note.frameId).toBe(frame.id)
    // centre (200, 200) from the frame's top-left (-1000, -600), 199 x 228 → top-left (-899.5, -514)
    expect(note.x).toBeCloseTo(-899.5, 1)
    expect(note.y).toBeCloseTo(-514, 1)
    // paint order: the frame, then its children
    const at = (id: string) => s.els.findIndex((e) => e.id === id)
    expect(at(frame.id)).toBeLessThan(at(note.id))
  })

  it('a frame inside a frame becomes a dashed box; its children go to the outer frame', () => {
    const s = sprint()
    const inner = s.elOf(I.innerFrame)
    expect(inner).toMatchObject({ type: 'rectangle', strokeStyle: 'dashed' })
    expect(s.labelOf(inner)?.originalText).toBe('Inner area')
    expect(s.rowOf(I.innerFrame)).toMatchObject({ result: 'approximate', note: 'frame-nested' })
    expect(s.out.report.notes['frame-fill-dropped']).toBe(1)
    const child = s.elOf(I.noteInner)
    expect(child.frameId).toBe(s.elOf(I.frame).id)
    // centre (250, 200) from the inner frame's top-left: outer (-1000,-600) + (1600-250, 800-200) = (350, 0)
    expect(child.x + child.width / 2).toBeCloseTo(600, 0)
  })

  it('rotation in degrees becomes the angle in radians', () => {
    const s = sprint()
    expect(s.elOf(I.star).angle).toBeCloseTo((15 * Math.PI) / 180, 2)
    expect(s.elOf(I.star).groupIds).toHaveLength(1)
  })

  it('an item without a position is a placeholder in a frame of its own, right of the board', () => {
    const s = sprint()
    const el = s.elOf(I.cardNoPosition)
    expect(s.rowOf(I.cardNoPosition)).toMatchObject({ result: 'placeholder', note: 'no-geometry' })
    const frame = s.byId.get(el.frameId)
    expect(frame?.name).toBe('Not imported from Miro')
    const right = Math.max(
      ...s.els.filter((e) => e.frameId !== frame?.id && e.id !== frame?.id).map((e) => e.x + e.width),
    )
    expect(frame?.x).toBeGreaterThan(right)
  })

  it('coordinates past the canvas are clamped and reported', () => {
    const b = fixtureSeedBody(board(RETRO_ID))
    const far = { ...b.items[0], id: '9999', position: { x: 5_000_000, y: -5_000_000, origin: 'center' } }
    const out = convert({ ...b, items: [...b.items, far as never] })
    const row = out.report.rows.find((r) => r.sourceId === '9999')
    expect(row?.note).toBe('position-clamped')
    for (const e of out.elements) expect(Math.abs(e.x)).toBeLessThan(1_000_000)
  })
})

describe('sticky notes', () => {
  it('keep their words (HTML → text), size and alignment; Miro’s colours map to Lobby’s note fills', () => {
    const s = sprint()
    const hello = s.elOf(I.noteHello)
    expect(hello).toMatchObject({
      type: 'stickynote',
      width: 199,
      backgroundColor: STICKY_TABLE.light_yellow?.fill,
    })
    expect(s.labelOf(hello)?.originalText).toBe('Hello team & friends')
    expect(s.labelOf(hello)?.verticalAlign).toBe('top')
    expect(s.rowOf(I.noteHello).note).toBe('text-formatting-lost')
    const pink = s.elOf(I.notePink)
    expect(pink.width).toBe(350)
    expect(s.labelOf(pink)?.originalText).toBe('Wide note\nsecond line')
    expect(s.labelOf(pink)?.textAlign).toBe('left')
    expect(pink.backgroundColor).toBe(STICKY_TABLE.pink?.fill)
  })

  it('the colour table is frozen', () => {
    expect(Object.fromEntries(Object.entries(STICKY_TABLE).map(([k, v]) => [k, v.name]))).toEqual({
      gray: 'white',
      light_yellow: 'black',
      yellow: 'yellow',
      orange: 'orange',
      light_green: 'light-green',
      green: 'light-green',
      dark_green: 'green',
      cyan: 'green',
      light_pink: 'light-red',
      pink: 'red',
      violet: 'violet',
      red: 'red',
      light_blue: 'light-blue',
      blue: 'light-blue',
      dark_blue: 'blue',
      black: 'grey',
    })
  })
})

describe('shapes and texts', () => {
  it('rectangles, rounded rectangles, circles and rhombuses are native, with their label and style', () => {
    const s = sprint()
    const rect = s.elOf(I.rect)
    expect(rect).toMatchObject({
      type: 'rectangle',
      backgroundColor: '#e6e6e6',
      strokeColor: '#1a1a1a',
      roundness: null,
    })
    expect(s.labelOf(rect)?.originalText).toBe('Process')
    expect(s.elOf(I.round)).toMatchObject({
      type: 'rectangle',
      roundness: { type: 3 },
      strokeStyle: 'dashed',
    })
    expect(s.elOf(I.circle)).toMatchObject({ type: 'ellipse', opacity: 50 })
    expect(s.elOf(I.rhombus).type).toBe('diamond')
    for (const id of [I.rect, I.round, I.circle, I.rhombus]) expect(s.rowOf(id).result).toBe('native')
  })

  it('a polygon is a closed line under a see-through box that holds the label; both in one group', () => {
    const s = sprint()
    const holder = s.elOf(I.triangle)
    expect(holder).toMatchObject({
      type: 'rectangle',
      strokeColor: 'transparent',
      backgroundColor: 'transparent',
    })
    const line = s.els.find((e) => e.type === 'line' && e.groupIds[0] === holder.groupIds[0])
    expect(line).toMatchObject({ polygon: true, backgroundColor: '#93d275' })
    expect(line?.points[0]).toEqual(line?.points.at(-1))
    expect(s.labelOf(holder)?.originalText).toBe('Up')
    expect(s.rowOf(I.triangle)).toMatchObject({ result: 'native', note: 'shape-polygon' })
  })

  it('a kind Lobby cannot draw is the nearest shape, reported', () => {
    const s = sprint()
    expect(s.elOf(I.cloud).type).toBe('ellipse')
    expect(s.rowOf(I.cloud)).toMatchObject({ result: 'approximate', note: 'shape-approximated' })
    expect(s.elOf(I.oddShape).type).toBe('rectangle')
    expect(s.rowOf(I.oddShape)).toMatchObject({ result: 'approximate', note: 'shape-approximated' })
  })

  it('a text keeps its lines, size, colour and first link; a serif face is replaced, and said so', () => {
    const s = sprint()
    const title = s.elOf(I.title)
    expect(title).toMatchObject({
      type: 'text',
      fontSize: 36,
      originalText: 'Board title\nSee the brief',
      link: 'https://example.com/brief',
      containerId: null,
      autoResize: false,
    })
    const serif = s.elOf(I.serif)
    expect(serif).toMatchObject({ fontFamily: 6, strokeColor: '#e03131', textAlign: 'center' })
    expect(s.rowOf(I.serif).note).toBe('font-substituted')
  })
})

describe('files, cards, embeds and placeholders', () => {
  it('until files are on (MIRO_DOWNLOAD_HOSTS empty): images and documents are placeholders, “not imported yet”', () => {
    const s = sprint()
    for (const id of [I.image, I.imageAgain, I.document]) {
      expect(s.rowOf(id)).toMatchObject({ result: 'placeholder', note: 'file-not-imported-yet' })
      const el = s.elOf(id)
      expect(el).toMatchObject({
        type: 'rectangle',
        strokeStyle: 'dashed',
        customData: { lobby: { kind: 'placeholder' } },
      })
      expect(s.labelOf(el)?.originalText).toContain('not imported yet')
    }
    expect(s.out.report.notes['file-not-imported-yet']).toBe(3)
  })

  it('stored files: an image shows its version (one file for both uses), a document is a file card', () => {
    const s = sprint(STORED)
    const img = s.elOf(I.image)
    expect(img).toMatchObject({
      type: 'image',
      fileId: 'ver_Image000000001',
      customData: {
        lobby: { file: { kind: 'image', versionId: 'ver_Image000000001' }, alt: 'A small diagram' },
      },
    })
    expect(s.elOf(I.imageAgain).fileId).toBe('ver_Image000000001')
    expect(s.elOf(I.document)).toMatchObject({
      type: 'image',
      fileId: 'ver_Doc0000000001',
      customData: { lobby: { file: { kind: 'pdf', name: 'brief.pdf' } } },
    })
    // never a Miro URL anywhere
    expect(JSON.stringify(s.out.elements)).not.toMatch(/miro\.com|resources\/images/)
  })

  it('a failed or refused file is a placeholder with its note; facts the server refuses fail the item', () => {
    const bad: Record<string, MiroFileOutcome> = {
      [I.image]: { failed: 'file-host-refused' },
      [I.imageAgain]: { failed: 'file-failed' },
      [I.document]: {
        stored: {
          assetId: 'ast_Doc0000000001',
          versionId: 'ver_Doc0000000001',
          kind: 'pdf',
          name: 'x',
          mimeType: '',
          sizeBytes: 1,
        },
      },
    }
    const s = sprint(bad)
    expect(s.rowOf(I.image)).toMatchObject({ result: 'placeholder', note: 'file-host-refused' })
    expect(s.rowOf(I.imageAgain)).toMatchObject({ result: 'placeholder', note: 'file-failed' })
    expect(s.rowOf(I.document)).toMatchObject({ result: 'failed', note: 'element-invalid', elementId: null })
  })

  it('cards and app cards are boxes with their words; embeds are link cards; the rest placeholders', () => {
    const s = sprint()
    const card = s.elOf(I.card)
    expect(card).toMatchObject({ type: 'rectangle', strokeColor: '#2d9bf0', backgroundColor: '#ffffff' })
    expect(s.labelOf(card)?.originalText).toBe(
      'Ship the importer\n\nCards keep their words\n\nDue 2026-10-20\nAssignee: Ana Lima',
    )
    expect(s.rowOf(I.card)).toMatchObject({ result: 'approximate', note: 'card-as-shape' })
    expect(s.labelOf(s.elOf(I.appCard))?.originalText).toContain('High\nBackend')
    expect(s.rowOf(I.appCard).note).toBe('app-card-as-shape')
    const embed = s.elOf(I.embed)
    expect(embed).toMatchObject({
      link: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      customData: { lobby: { kind: 'link-card' } },
    })
    expect(s.labelOf(embed)?.originalText).toBe('A video')
    expect(JSON.stringify(s.out.elements)).not.toContain('iframe')
    expect(s.rowOf(I.preview)).toMatchObject({ result: 'placeholder', note: 'preview-not-imported' })
    expect(s.rowOf(I.doc)).toMatchObject({ result: 'placeholder', note: 'doc-not-imported' })
    expect(s.rowOf(I.table)).toMatchObject({ result: 'placeholder', note: 'table-not-imported' })
    expect(s.rowOf(I.unknown)).toMatchObject({ result: 'placeholder', note: 'unknown-type' })
  })
})

describe('connectors', () => {
  const C = (n: number) => `345876452100000000${n}`

  it('bound at both ends where Miro says, ends derived by the room’s own re-snap, the first caption the label', () => {
    const s = sprint()
    const arrow = s.elOf(C(1))
    expect(arrow).toMatchObject({
      type: 'arrow',
      startArrowhead: null,
      endArrowhead: 'arrow',
      elbowed: false,
      startBinding: { elementId: s.elOf(I.noteHello).id, mode: 'orbit' },
      endBinding: { elementId: s.elOf(I.notePink).id, mode: 'orbit' },
    })
    expect(arrow.startBinding.fixedPoint).toEqual([1, 0.5001])
    expect(s.labelOf(arrow)?.originalText).toBe('next')
    const map = new Map(s.els.map((e) => [e.id, e])) as unknown as ReadonlyMap<string, EngineElement>
    for (const a of s.els.filter((e) => e.type === 'arrow'))
      expect(boundEndsOffEdge(a as unknown as ArrowElementLike, map)).toBe(0)
    // the targets list the arrow
    expect(s.elOf(I.noteHello).boundElements).toContainEqual({ id: arrow.id, type: 'arrow' })
    expect(s.rowOf(C(1)).result).toBe('native')
    // arrows are painted above their targets
    const at = (id: string) => s.els.findIndex((e) => e.id === id)
    expect(at(arrow.id)).toBeGreaterThan(at(s.elOf(I.notePink).id))
  })

  it('elbowed, caps, extra captions, curved, unsupported, and an end Lobby did not make', () => {
    const s = sprint()
    expect(s.elOf(C(2))).toMatchObject({
      elbowed: true,
      startArrowhead: 'diamond',
      endArrowhead: 'cardinality_many',
    })
    expect(s.rowOf(C(2)).note).toBe('connector-caption-extra')
    expect(s.elOf(C(3))).toMatchObject({ roundness: { type: 2 }, strokeStyle: 'dashed' })
    expect(s.rowOf(C(3))).toMatchObject({ result: 'approximate', note: 'connector-curved' })
    expect(s.rowOf(C(4))).toMatchObject({ result: 'approximate', note: 'connector-unsupported' })
    expect(s.rowOf(C(5))).toMatchObject({ result: 'skipped', note: 'connector-end-unbound', elementId: null })
    const free = s.elOf(C(6))
    expect(free).toMatchObject({ startArrowhead: 'circle_outline', endArrowhead: 'arrow' })
    expect(free.endBinding.elementId).toBe(s.elOf(I.title).id)
    expect(s.rowOf(C(6))).toMatchObject({ result: 'approximate', note: 'connector-cap-approximated' })
  })
})

describe('groups and tags', () => {
  it('a group keeps its members together; one that spans frames is dropped and counted', () => {
    const s = sprint()
    const rect = s.elOf(I.rect)
    const round = s.elOf(I.round)
    expect(rect.groupIds).toHaveLength(1)
    expect(round.groupIds).toEqual(rect.groupIds)
    expect(s.labelOf(rect)?.groupIds).toEqual(rect.groupIds)
    expect(s.elOf(I.circle).groupIds).toEqual([])
    expect(s.out.report.notes['group-dropped']).toBe(1)
    expect(s.out.report.byType.group).toEqual({ native: 1, skipped: 1 })
  })

  it('tags become the board’s tags and the items’ tags, colours matched', () => {
    const s = sprint()
    expect(s.out.doc).toEqual({
      'tagDef:urgent': { name: 'Urgent', color: 'red' },
      'tagDef:research': { name: 'Research', color: 'light-blue' },
    })
    expect(s.elOf(I.noteHello).customData.lobby['tag:urgent']).toEqual({ name: 'Urgent', color: 'red' })
    expect(s.elOf(I.card).customData.lobby['tag:urgent']).toBeTruthy()
    expect(s.elOf(I.notePink).customData.lobby['tag:research']).toEqual({
      name: 'Research',
      color: 'light-blue',
    })
    expect(s.out.report.notes['tag-color-substituted']).toBe(1)
  })
})

describe('hostile and large content', () => {
  it('every element stays valid whatever the strings hold; the report stays within its cap', () => {
    const b = fixtureSeedBody(board(RETRO_ID))
    const base = b.items[0] as never as Record<string, unknown>
    const items = Array.from({ length: 10_000 }, (_, i) => ({
      ...base,
      id: String(1_000_000 + i),
      data: { content: `<p>${'x'.repeat(i % 50)}<script>alert(1)</script>${RLO}</p>` },
      position: { x: (i % 100) * 220, y: Math.floor(i / 100) * 260, origin: 'center' },
    }))
    const started = performance.now()
    const out = convert({ ...b, items: items as never })
    expect(performance.now() - started).toBeLessThan(60_000)
    expect(out.report.total).toBe(10_000)
    expect(Buffer.byteLength(JSON.stringify(out.report))).toBeLessThanOrEqual(IMPORT_REPORT_MAX_BYTES)
    expect(out.report.rows.length + out.report.rowsOmitted).toBe(10_000)
    const json = JSON.stringify(out.elements)
    expect(json).not.toContain('alert')
    expect(json).not.toContain(RLO)
  }, 120_000)

  it('items past the per-board limit are skipped, never dropped silently', () => {
    const b = fixtureSeedBody(board(RETRO_ID))
    const base = b.items[0] as never as Record<string, unknown>
    const items = Array.from({ length: 10_005 }, (_, i) => ({
      ...base,
      id: String(2_000_000 + i),
      type: 'unknown',
    }))
    const out = convert({ ...b, items: items as never })
    expect(out.report.counts.skipped).toBe(5)
    expect(out.report.notes['over-limit']).toBe(5)
  }, 120_000)

  it('a body with nothing usable converts to nothing', () => {
    const out = convert({
      format: 'miro-v2',
      board: { id: 'x', name: '' },
      items: [null, 1, 'x', { id: 5 }] as never,
      connectors: [{}] as never,
      groups: [{ id: 'g', items: 'nope' }] as never,
      tags: [{ id: 't' }] as never,
      tagItems: {},
      members: {},
      files: {},
    })
    expect(out.elements).toEqual([])
  })
})

describe('the output is the seed’s to validate again', () => {
  it('elements are plain JSON (no undefined), fresh indices in paint order', () => {
    const s = sprint(STORED)
    const els = s.out.elements as WireElement[]
    expect(JSON.parse(JSON.stringify(els))).toEqual(els)
    const idx = els.map((e) => e.index as string)
    expect([...idx].sort()).toEqual(idx)
  })
})
