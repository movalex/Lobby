// The wave T foundation's web side (docs/WAVE-T-CONTRACTS.md §6): every switch off, the six wave T features registered
// empty, the room gate (planning is offered only in a rev-14 room, never read-only), the entries and their pending
// palette ids, the card popover seam, the read model over the scene index, the export-overlay registry and the Export
// dialog's kind slot. Each workstream extends its own tests; this file pins what they share.
import { PLANNING_REV } from '@draftroom/canvas-schema/protocol'
import {
  PALETTE_COMMAND_IDS,
  PENDING_PALETTE_COMMAND_IDS,
  WAVE_T_PALETTE_COMMAND_IDS,
} from '@draftroom/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import type { CanvasElement, CanvasFeatureContext, LobbyCanvas } from '../canvas/api/index.ts'
import { CANVAS_FEATURES } from './canvas-registry.ts'
import {
  cardsIn,
  cardsOn,
  kanbansOn,
  openCardPopover,
  PLANNING_ENTRIES,
  PLANNING_FLAG_KEYS,
  PLANNING_FLAGS,
  type PlanningScene,
  planningFlags,
  planningOffered,
  planningRoom,
  registerCardPopover,
  storyboardOfSelection,
  storyboardsOn,
  timelinesOn,
} from './planning/index.ts'
import {
  type ExportOverlayLayer,
  exportOverlayLayers,
  exportOverlaysActive,
  registerExportOverlay,
  svgWithOverlays,
  VOTES_OVERLAY,
} from './present-export/ported/badges.ts'
import { exportSectionsFor, registerExportSection } from './present-export/ported/export-sections.ts'

const WAVE_T_FEATURES = ['storyboard', 'storyboard-play', 'cards', 'kanban', 'card-table', 'timeline']

describe('the wave T switches', () => {
  it('ship off, and a production page ignores any override', () => {
    expect(Object.values(PLANNING_FLAGS).every((v) => v === false)).toBe(true)
    expect(Object.keys(PLANNING_FLAG_KEYS).sort()).toEqual(Object.keys(PLANNING_FLAGS).sort())
    expect(planningFlags(false, () => '1')).toEqual(PLANNING_FLAGS)
  })

  it('a dev-auth page may turn each on or off; a blocked store keeps the shipped value', () => {
    const store: Record<string, string> = {
      [PLANNING_FLAG_KEYS.cards]: '1',
      [PLANNING_FLAG_KEYS.timeline]: '0',
    }
    const f = planningFlags(true, (k) => store[k])
    expect(f.cards).toBe(true)
    expect(f.timeline).toBe(false)
    expect(f.storyboard).toBe(false)
    expect(
      planningFlags(true, () => {
        throw new Error('blocked')
      }),
    ).toEqual(PLANNING_FLAGS)
  })

  it('a write is offered only with its switch on, in a room of PLANNING_REV or later, and never read-only', () => {
    const on = { ...PLANNING_FLAGS, cards: true }
    const gate = (rev: number | null, readOnly = false) => ({
      room: { contractsRev: () => rev },
      readOnly: () => readOnly,
    })
    expect(PLANNING_REV).toBe(14)
    expect(planningRoom(null)).toBe(false)
    expect(planningRoom(13)).toBe(false)
    expect(planningRoom(14)).toBe(true)
    expect(planningOffered('cards', gate(14), on)).toBe(true)
    expect(planningOffered('cards', gate(13), on)).toBe(false)
    expect(planningOffered('cards', gate(null), on)).toBe(false)
    expect(planningOffered('cards', gate(14, true), on)).toBe(false)
    expect(planningOffered('kanban', gate(14), on)).toBe(false)
    expect(planningOffered('cards', gate(14))).toBe(false)
  })
})

describe('the wave T features and entries', () => {
  it('are registered empty, in order, before the Elements panel (still the last)', () => {
    const ids = CANVAS_FEATURES.map((f) => f.id)
    const at = WAVE_T_FEATURES.map((id) => ids.indexOf(id))
    expect(at.every((i) => i >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    expect(ids.at(-1)).toBe('elements')
    for (const id of WAVE_T_FEATURES) expect(CANVAS_FEATURES.find((f) => f.id === id)).toEqual({ id })
  })

  it('every entry runs one of the wave T palette ids, each pending until its owner registers it', () => {
    expect(PLANNING_ENTRIES.map((e) => e.id).sort()).toEqual([...WAVE_T_PALETTE_COMMAND_IDS].sort())
    for (const id of WAVE_T_PALETTE_COMMAND_IDS) {
      expect(PALETTE_COMMAND_IDS as readonly string[]).toContain(id)
      expect(PENDING_PALETTE_COMMAND_IDS as readonly string[]).toContain(id)
    }
    for (const e of PLANNING_ENTRIES) expect(e.places.length, e.id).toBeGreaterThan(0)
  })

  it('the card popover: false until WS4 registers it; the registration is undone by its removal', () => {
    const ctx = {} as CanvasFeatureContext
    expect(openCardPopover(ctx, { id: 'c1' })).toBe(false)
    const seen: string[] = []
    const off = registerCardPopover((_ctx, req) => {
      seen.push(req.id)
      return true
    })
    expect(openCardPopover(ctx, { id: 'c1', focus: 'due' })).toBe(true)
    off()
    expect(openCardPopover(ctx, { id: 'c2' })).toBe(false)
    expect(seen).toEqual(['c1'])
  })
})

describe('the planning read model (over canvas.index only)', () => {
  const el = (
    id: string,
    type: string,
    lobby: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ) =>
    ({
      id,
      type,
      isDeleted: false,
      frameId: null,
      customData: { lobby },
      ...extra,
    }) as unknown as CanvasElement
  const elements = [
    el('c1', 'stickynote', { 'card:status': 'doing' }, { frameId: 'k1' }),
    el('c2', 'rectangle', { 'card:status': 'bogus' }),
    el('c3', 'rectangle', { 'card:status': 'done' }, { isDeleted: true }),
    el('k1', 'frame', { kanban: { hidden: ['blocked'] } }),
    el('t1', 'frame', {
      timeline: { start: '2026-10-01', end: '2026-12-31', scale: 'week', lanes: 'status' },
    }),
    el('h1', 'text', { 'sb:head': { aspect: '16:9' } }),
    el('p2', 'frame', { 'sb:of': 'h1', 'sb:pos': 'a1' }),
    el('p1', 'frame', { 'sb:of': 'h1', 'sb:pos': 'a0' }),
    el('x1', 'rectangle', {}, { frameId: 'p2' }),
  ]
  const asked: string[] = []
  const scene: PlanningScene = {
    index: {
      withLobbyKey: (key) => {
        asked.push(key)
        return elements.filter((e) => key in (e.customData?.lobby ?? {}))
      },
      byFrame: (frameId) => elements.filter((e) => e.frameId === frameId),
    },
  }

  it('reads cards, Kanbans, timelines and storyboards by key', () => {
    expect(cardsOn(scene).map((c) => [c.el.id, c.card.status])).toEqual([['c1', 'doing']])
    expect(cardsIn(scene, 'k1').map((c) => c.el.id)).toEqual(['c1'])
    expect(kanbansOn(scene).map((k) => k.el.id)).toEqual(['k1'])
    expect(timelinesOn(scene).map((t) => t.value.scale)).toEqual(['week'])
    const boards = storyboardsOn(scene)
    expect([...boards.keys()]).toEqual(['h1'])
    expect(boards.get('h1')?.panels.map((p) => p.id)).toEqual(['p1', 'p2'])
    expect(storyboardOfSelection(boards, { id: 'x1', frameId: 'p2' })?.id).toBe('h1')
    expect(storyboardOfSelection(boards, { id: 'c1', frameId: 'k1' })).toBeNull()
    expect(new Set(asked)).toEqual(new Set(['card:status', 'kanban', 'timeline', 'sb:head', 'sb:of']))
  })
})

describe('the export-overlay registry', () => {
  const removals: (() => void)[] = []
  afterEach(() => {
    for (const r of removals.splice(0)) r()
  })
  const canvas = {} as LobbyCanvas
  const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><g/></svg>'

  it('starts with the vote badges only; with no active layer an export is the engine’s alone', () => {
    expect(exportOverlayLayers().map((l) => l.id)).toEqual(['votes'])
    expect(VOTES_OVERLAY.order).toBe(100)
    const quiet: ExportOverlayLayer = { id: 'cards', order: 20, active: () => false, svg: () => '<x/>' }
    removals.push(registerExportOverlay(quiet))
    // a canvas with no revealed vote and only an inactive layer: nothing to draw
    expect(VOTES_OVERLAY.active(canvas)).toBe(false)
    expect(exportOverlaysActive(canvas)).toBe(false)
  })

  it('a layer draws in order, in export coordinates, before the end of the SVG; its removal takes it out', () => {
    const seen: unknown[] = []
    const layer = (id: ExportOverlayLayer['id'], order: number): ExportOverlayLayer => ({
      id,
      order,
      active: () => true,
      svg: (input) => {
        seen.push({ id, origin: input.origin, view: input.view, n: input.exported.size })
        return `<g data-layer="${id}"/>`
      },
    })
    removals.push(
      registerExportOverlay(layer('timeline', 40)),
      registerExportOverlay(layer('storyboard', 10)),
    )
    // the vote layer is quiet for this canvas (no results provided)
    expect(VOTES_OVERLAY.active(canvas)).toBe(false)
    const out = svgWithOverlays(SVG, { canvas, exported: new Set(['a', 'b']), origin: { x: 5, y: 7 } })
    expect(out).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300"><g/><g data-layer="storyboard"/><g data-layer="timeline"/></svg>',
    )
    expect(seen[0]).toEqual({
      id: 'storyboard',
      origin: { x: 5, y: 7 },
      view: { minX: 0, minY: 0, width: 400, height: 300 },
      n: 2,
    })
    for (const r of removals.splice(0)) r()
    expect(exportOverlayLayers().map((l) => l.id)).toEqual(['votes'])
    expect(svgWithOverlays(SVG, { canvas, exported: new Set(), origin: { x: 0, y: 0 } })).toBe(SVG)
  })
})

describe('the Export dialog’s kind slot', () => {
  it('has no section until a feature registers one; sections are offered per canvas, in order', () => {
    const canvas = {} as LobbyCanvas
    expect(exportSectionsFor(canvas)).toEqual([])
    const Section = () => null
    const offA = registerExportSection({ id: 'storyboard-sequence', order: 20, offered: () => true, Section })
    const offB = registerExportSection({ id: 'storyboard-sheet', order: 10, offered: () => true, Section })
    const offC = registerExportSection({ id: 'card-table-csv', order: 30, offered: () => false, Section })
    expect(exportSectionsFor(canvas).map((s) => s.id)).toEqual(['storyboard-sheet', 'storyboard-sequence'])
    for (const off of [offA, offB, offC]) off()
    expect(exportSectionsFor(canvas)).toEqual([])
  })
})
