/**
 * Miro REST API v2 items → Lobby elements (wave R, WS1; docs/WAVE-R-CONTRACTS.md §3, the design's §1.3 mapping). Runs
 * in sync's seed worker (apps/sync room-internal/convert-miro-worker.ts) on the body the api read from Miro
 * (`MiroSeedBody`), and builds only element types and `customData.lobby` keys Lobby already stores, through
 * `@draftroom/canvas-schema` (the engine's own note and label layout, the room's own arrow re-snap, the server's own
 * element check), so the seed's validation (prepareSeedContent: checkElement, checkInvariants) passes as built.
 *
 * Geometry: Miro positions an item by its centre (`origin: "center"`), relative to the board's centre or to its
 * parent frame's top-left (`relativeTo: "parent_top_left"`); `rotation` is in degrees, clockwise. An element's top-left
 * is the centre minus half its size, its angle the rotation in radians; coordinates are kept inside COORD_LIMIT.
 *
 * Per item, one report row (native, approximate, placeholder, failed, skipped) with its first note; every note is
 * counted. An element the server would refuse never reaches the board: its item becomes a `failed` row
 * (`element-invalid`). What Miro's API does not return (pen strokes, stickers, comments) is not in the body at all.
 *
 * Paint order: each top-level frame followed by its children (in Miro's order), then the other items (in Miro's
 * order), then the frame of items without a position, then every connector (arrows above their targets). Pure,
 * except for fresh ids and seeds (`opts.newId`, `opts.seed` make it deterministic). Nothing here logs.
 */
import {
  type IdSource,
  LOBBY_FRAME_STROKE,
  LOBBY_INK,
  newElementId,
  randomInt31,
} from '@draftroom/board-ops/elements'
import { checkElement, type WireElement } from '@draftroom/canvas-schema/elements'
import {
  type ArrowElementLike,
  arrowLabelLayout,
  buildStickyNote,
  type EngineElement,
  indexKeysBetween,
  type LobbyFontFamily,
  layoutBoundText,
  layoutStickyNote,
  resnapArrow,
  type StickyNoteElement,
  type TextElement,
  wrapLabelText,
} from '@draftroom/canvas-schema/engine'
import { checkInvariants } from '@draftroom/canvas-schema/invariants'
import {
  COORD_LIMIT,
  isAllowedLink,
  MAX_ALT_CHARS,
  MAX_BOUND_ELEMENTS,
  MAX_FILE_NAME_CHARS,
  MAX_FRAME_NAME_CHARS,
  MAX_ORIGINAL_TEXT_CHARS,
  MAX_TAG_DEFS,
  MAX_TAGS_PER_ELEMENT,
  round2,
} from '@draftroom/canvas-schema/limits'
import {
  type ImportBoardReport,
  type ImportItemResult,
  MIRO_IMPORT_LIMITS,
  normalizeTagName,
  parseTagValue,
  type TagColor,
  tagKey,
} from '@draftroom/contracts'
import { hexAlpha, hexColor, stickyColor, tagColor, withoutAlpha } from './colors.ts'
import { fontOf } from './fonts.ts'
import { cleanText, htmlToText } from './html.ts'
import type { MiroNote } from './notes.ts'
import { buildReport, type ReportRow } from './report.ts'
import {
  isRecord,
  type MiroConnector,
  type MiroConnectorEnd,
  type MiroFileOutcome,
  type MiroItem,
  type MiroSeedBody,
} from './sources.ts'

type El = Record<string, unknown> & { id: string; type: string }

export interface ConvertMiroOptions {
  /** `updated` of every element */
  readonly now: number
  /** element and group ids (default: fresh nanoid-style ids) */
  readonly newId?: IdSource
  /** seeds and nonces (default: random) */
  readonly seed?: () => number
}

export interface ConvertedMiro {
  /** in paint order, with fresh indices; every one passes checkElement, the set passes checkInvariants */
  readonly elements: WireElement[]
  /** the board document's values (`tagDef:<key>` entries) */
  readonly doc: Record<string, unknown>
  readonly report: ImportBoardReport
}

// ---- small readers -----------------------------------------------------------------------------------------------

/** A finite number from a number or a numeric string (Miro's style fields are strings), else `fallback`. */
export function num(v: unknown, fallback: number): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : fallback
  if (typeof v === 'string' && /^\s*-?\d+(\.\d+)?(e[+-]?\d+)?\s*$/i.test(v)) {
    const n = Number(v)
    return Number.isFinite(n) ? n : fallback
  }
  return fallback
}
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const rec = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {})

/** `"50%"` → 0.5 (a ratio of the item's box), else null. */
function percent(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1 ? v / 100 : v
  if (typeof v !== 'string') return null
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*%?\s*$/.exec(v)
  return m ? Number(m[1]) / 100 : null
}

/** Excalidraw `normalizeFixedPoint`: a ratio within 1e-4 of 0.5 becomes 0.5001. */
function fixedPoint(px: number, py: number): [number, number] {
  return [clamp(px, 0, 1), clamp(py, 0, 1)].map((r) => (Math.abs(r - 0.5) < 1e-4 ? 0.5001 : r)) as [
    number,
    number,
  ]
}

const ALIGN = new Set(['left', 'center', 'right'])
const textAlignOf = (v: unknown, fallback: 'left' | 'center' | 'right') =>
  (ALIGN.has(str(v)) ? str(v) : fallback) as 'left' | 'center' | 'right'
const verticalOf = (v: unknown, fallback: 'top' | 'middle' | 'bottom') => {
  const s = str(v)
  return (s === 'top' || s === 'middle' || s === 'bottom' ? s : fallback) as 'top' | 'middle' | 'bottom'
}
const strokeStyleOf = (v: unknown) => {
  const s = str(v)
  if (s.includes('dash')) return 'dashed'
  if (s.includes('dot')) return 'dotted'
  return 'solid'
}

const LINE_HEIGHT = 1.25
const PLACEHOLDER_STROKE = '#9fa8b2'
const PLACEHOLDER_INK = '#5f6b7a'
const CARD_FILL = '#ffffff'
const MIN_SIZE = 8

// ---- shapes ------------------------------------------------------------------------------------------------------

type Pt = readonly [number, number]
type Outline = (w: number, h: number) => Pt[]

const close = (pts: Pt[]): Pt[] => [...pts, pts[0] as Pt]
const regular =
  (n: number, rot = -Math.PI / 2): Outline =>
  (w, h) =>
    close(
      Array.from({ length: n }, (_, i) => {
        const a = rot + (i * 2 * Math.PI) / n
        return [w / 2 + (w / 2) * Math.cos(a), h / 2 + (h / 2) * Math.sin(a)] as Pt
      }),
    )

/** A closed outline spanning the whole `w` by `h` box (so a rotation turns it about the box's centre). */
export const POLYGONS: Readonly<Record<string, Outline>> = {
  triangle: (w, h) =>
    close([
      [w / 2, 0],
      [w, h],
      [0, h],
    ]),
  flow_chart_merge: (w, h) =>
    close([
      [0, 0],
      [w, 0],
      [w / 2, h],
    ]),
  parallelogram: (w, h) =>
    close([
      [w * 0.25, 0],
      [w, 0],
      [w * 0.75, h],
      [0, h],
    ]),
  flow_chart_input_output: (w, h) =>
    close([
      [w * 0.2, 0],
      [w, 0],
      [w * 0.8, h],
      [0, h],
    ]),
  trapezoid: (w, h) =>
    close([
      [w * 0.2, 0],
      [w * 0.8, 0],
      [w, h],
      [0, h],
    ]),
  flow_chart_manual_operation: (w, h) =>
    close([
      [0, 0],
      [w, 0],
      [w * 0.8, h],
      [w * 0.2, h],
    ]),
  flow_chart_manual_input: (w, h) =>
    close([
      [0, h * 0.3],
      [w, 0],
      [w, h],
      [0, h],
    ]),
  pentagon: regular(5),
  hexagon: (w, h) =>
    close([
      [w * 0.25, 0],
      [w * 0.75, 0],
      [w, h / 2],
      [w * 0.75, h],
      [w * 0.25, h],
      [0, h / 2],
    ]),
  flow_chart_preparation: (w, h) =>
    close([
      [w * 0.15, 0],
      [w * 0.85, 0],
      [w, h / 2],
      [w * 0.85, h],
      [w * 0.15, h],
      [0, h / 2],
    ]),
  octagon: (w, h) =>
    close([
      [w * 0.29, 0],
      [w * 0.71, 0],
      [w, h * 0.29],
      [w, h * 0.71],
      [w * 0.71, h],
      [w * 0.29, h],
      [0, h * 0.71],
      [0, h * 0.29],
    ]),
  star: (w, h) =>
    close(
      Array.from({ length: 10 }, (_, i) => {
        const a = -Math.PI / 2 + (i * Math.PI) / 5
        const r = i % 2 === 0 ? 0.5 : 0.2
        return [w / 2 + w * r * Math.cos(a), h / 2 + h * r * Math.sin(a) + h * 0.05] as Pt
      }).map(([x, y]) => [clamp(x, 0, w), clamp(y, 0, h)] as Pt),
    ),
  cross: (w, h) =>
    close([
      [w / 3, 0],
      [(2 * w) / 3, 0],
      [(2 * w) / 3, h / 3],
      [w, h / 3],
      [w, (2 * h) / 3],
      [(2 * w) / 3, (2 * h) / 3],
      [(2 * w) / 3, h],
      [w / 3, h],
      [w / 3, (2 * h) / 3],
      [0, (2 * h) / 3],
      [0, h / 3],
      [w / 3, h / 3],
    ]),
  right_arrow: (w, h) =>
    close([
      [0, h * 0.27],
      [w * 0.62, h * 0.27],
      [w * 0.62, 0],
      [w, h / 2],
      [w * 0.62, h],
      [w * 0.62, h * 0.73],
      [0, h * 0.73],
    ]),
  left_arrow: (w, h) =>
    close([
      [w, h * 0.27],
      [w * 0.38, h * 0.27],
      [w * 0.38, 0],
      [0, h / 2],
      [w * 0.38, h],
      [w * 0.38, h * 0.73],
      [w, h * 0.73],
    ]),
  left_right_arrow: (w, h) =>
    close([
      [0, h / 2],
      [w * 0.25, 0],
      [w * 0.25, h * 0.27],
      [w * 0.75, h * 0.27],
      [w * 0.75, 0],
      [w, h / 2],
      [w * 0.75, h],
      [w * 0.75, h * 0.73],
      [w * 0.25, h * 0.73],
      [w * 0.25, h],
    ]),
  flow_chart_offpage_connector: (w, h) =>
    close([
      [0, 0],
      [w, 0],
      [w, h * 0.7],
      [w / 2, h],
      [0, h * 0.7],
    ]),
  wedge_round_rectangle_callout: (w, h) =>
    close([
      [0, 0],
      [w, 0],
      [w, h * 0.78],
      [w * 0.4, h * 0.78],
      [w * 0.2, h],
      [w * 0.22, h * 0.78],
      [0, h * 0.78],
    ]),
}

/** Miro shape kinds Excalidraw draws natively (with the roundness a kind needs). */
const NATIVE_SHAPES: Readonly<
  Record<string, { type: 'rectangle' | 'ellipse' | 'diamond'; round?: boolean }>
> = {
  rectangle: { type: 'rectangle' },
  round_rectangle: { type: 'rectangle', round: true },
  circle: { type: 'ellipse' },
  rhombus: { type: 'diamond' },
  flow_chart_process: { type: 'rectangle' },
  flow_chart_decision: { type: 'diamond' },
  flow_chart_terminator: { type: 'rectangle', round: true },
  flow_chart_connector: { type: 'ellipse' },
  flow_chart_note_square: { type: 'rectangle' },
}
/** Kinds drawn as the nearest native shape, reported as approximate. */
const APPROX_SHAPES: Readonly<
  Record<string, { type: 'rectangle' | 'ellipse' | 'diamond'; round?: boolean }>
> = {
  cloud: { type: 'ellipse' },
  can: { type: 'rectangle', round: true },
  flow_chart_magnetic_disk: { type: 'rectangle', round: true },
  flow_chart_magnetic_drum: { type: 'rectangle', round: true },
  flow_chart_online_storage: { type: 'rectangle', round: true },
  flow_chart_or: { type: 'ellipse' },
  flow_chart_summing_junction: { type: 'ellipse' },
  flow_chart_predefined_process: { type: 'rectangle' },
  flow_chart_internal_storage: { type: 'rectangle' },
  flow_chart_document: { type: 'rectangle' },
  flow_chart_multidocuments: { type: 'rectangle' },
  flow_chart_display: { type: 'rectangle', round: true },
  flow_chart_delay: { type: 'rectangle', round: true },
  flow_chart_note_curly_left: { type: 'rectangle' },
  flow_chart_note_curly_right: { type: 'rectangle' },
  left_brace: { type: 'rectangle' },
  right_brace: { type: 'rectangle' },
}

// ---- connectors ----------------------------------------------------------------------------------------------------

/** Miro stroke caps → the pinned engine's arrowheads (canvas-schema ARROWHEADS); `exact: false` is reported. */
const CAPS: Readonly<Record<string, { head: string | null; exact: boolean }>> = {
  none: { head: null, exact: true },
  arrow: { head: 'arrow', exact: true },
  stealth: { head: 'arrow', exact: true },
  rounded_stealth: { head: 'arrow', exact: true },
  diamond: { head: 'diamond_outline', exact: true },
  filled_diamond: { head: 'diamond', exact: true },
  oval: { head: 'circle_outline', exact: true },
  filled_oval: { head: 'circle', exact: true },
  triangle: { head: 'triangle_outline', exact: true },
  filled_triangle: { head: 'triangle', exact: true },
  erd_one: { head: 'cardinality_one', exact: true },
  erd_many: { head: 'cardinality_many', exact: true },
  erd_only_one: { head: 'cardinality_exactly_one', exact: true },
  erd_zero_or_one: { head: 'cardinality_zero_or_one', exact: true },
  erd_one_or_many: { head: 'cardinality_one_or_many', exact: true },
  erd_zero_or_many: { head: 'cardinality_zero_or_many', exact: true },
}
function capOf(v: unknown, fallback: string | null): { head: string | null; exact: boolean } {
  const s = str(v)
  if (!s) return { head: fallback, exact: true }
  return CAPS[s] ?? { head: 'arrow', exact: false }
}

// ---- the conversion ------------------------------------------------------------------------------------------------

interface Box {
  x: number
  y: number
  w: number
  h: number
  angle: number
}

interface Built {
  /** in paint order; the main element (what connectors bind to, tags go on) first */
  elements: El[]
  main: El | null
  result: ImportItemResult
  notes: MiroNote[]
}

const PLACEHOLDER_WORDS: Readonly<Record<string, string>> = {
  image: 'Miro image',
  document: 'Miro document',
  data_table_format: 'Miro table',
  doc_format: 'Miro doc',
  preview: 'Miro link preview',
  card: 'Miro card',
  app_card: 'Miro app card',
  embed: 'Miro embed',
}

/** Converts a board read from Miro; see the module comment. */
export function convertMiroBoard(body: MiroSeedBody, opts: ConvertMiroOptions): ConvertedMiro {
  return new MiroConverter(body, opts).run()
}

class MiroConverter {
  readonly body: MiroSeedBody
  readonly now: number
  readonly newId: IdSource
  readonly seed: () => number
  readonly items = new Map<string, MiroItem>()
  readonly built = new Map<string, Built>()
  /** Miro frame id → the Lobby frame element id (top-level frames only) */
  readonly frameIds = new Map<string, string>()
  readonly boxes = new Map<string, Box | null>()
  readonly rows: ReportRow[] = []
  readonly noteCounts = new Map<string, number>()
  readonly extraByType = new Map<string, Map<ImportItemResult, number>>()
  readonly doc: Record<string, unknown> = {}

  constructor(body: MiroSeedBody, opts: ConvertMiroOptions) {
    this.body = body
    this.now = opts.now
    this.newId = opts.newId ?? newElementId
    this.seed = opts.seed ?? randomInt31
  }

  run(): ConvertedMiro {
    const all = (Array.isArray(this.body.items) ? this.body.items : []).filter(
      (i) => isRecord(i) && typeof i.id === 'string' && typeof i.type === 'string',
    )
    const kept = all.slice(0, MIRO_IMPORT_LIMITS.itemsPerBoard)
    for (const item of all.slice(MIRO_IMPORT_LIMITS.itemsPerBoard))
      this.row(item.id, item.type, 'skipped', null, ['over-limit'])
    for (const item of kept) if (!this.items.has(item.id)) this.items.set(item.id, item)
    const order = [...this.items.values()]

    // top-level frames first: their ids are needed by their children
    for (const item of order)
      if (item.type === 'frame' && !this.parentFrame(item)) this.frameIds.set(item.id, this.newId())

    const noBox: MiroItem[] = []
    for (const item of order) {
      const box = this.boxOf(item)
      if (!box) {
        noBox.push(item)
        continue
      }
      this.put(item, this.build(item, box))
    }
    this.placeWithoutBox(noBox)
    this.applyTags()
    this.applyGroups()
    const arrows = this.connectors()

    // paint order
    const ordered: El[] = []
    const placed = new Set<string>()
    const add = (e: El) => {
      if (placed.has(e.id)) return
      placed.add(e.id)
      ordered.push(e)
    }
    const push = (b: Built | undefined) => {
      for (const e of b?.elements ?? []) add(e)
    }
    const childrenOf = new Map<string, MiroItem[]>()
    for (const item of order) {
      const top = this.topFrameOf(item)
      if (top && top !== item.id) childrenOf.set(top, [...(childrenOf.get(top) ?? []), item])
    }
    for (const item of order) {
      if (!this.frameIds.has(item.id)) continue
      push(this.built.get(item.id))
      for (const child of childrenOf.get(item.id) ?? []) push(this.built.get(child.id))
    }
    for (const item of order) push(this.built.get(item.id))
    for (const e of this.extra) add(e)
    for (const a of arrows) for (const e of a) add(e)

    const keys = indexKeysBetween(null, null, ordered.length)
    const elements: WireElement[] = ordered.map((el, i) => {
      el.index = keys[i] as string
      for (const k of Object.keys(el)) if (el[k] === undefined) delete el[k]
      const check = checkElement(el)
      // every element was checked when it was built: one that fails now is a converter bug, never content
      if (!check.ok) throw new Error(`miro-import: element ${el.type} invalid after build (${check.code})`)
      return check.element
    })
    const violations = checkInvariants(elements)
    if (violations.length)
      throw new Error(
        `miro-import: inconsistent output (${[...new Set(violations.map((v) => v.code))].join(', ')})`,
      )
    return {
      elements,
      doc: this.doc,
      report: buildReport(this.rows, this.noteCounts, this.extraByType),
    }
  }

  // ---- report ----

  row(
    sourceId: string,
    type: string,
    result: ImportItemResult,
    elementId: string | null,
    notes: readonly MiroNote[],
  ) {
    for (const n of new Set(notes)) this.noteCounts.set(n, (this.noteCounts.get(n) ?? 0) + 1)
    this.rows.push({ sourceId, type, result, elementId, note: notes[0] ?? null })
  }

  note(n: MiroNote, times = 1) {
    this.noteCounts.set(n, (this.noteCounts.get(n) ?? 0) + times)
  }

  tally(type: string, result: ImportItemResult) {
    const m = this.extraByType.get(type) ?? new Map<ImportItemResult, number>()
    m.set(result, (m.get(result) ?? 0) + 1)
    this.extraByType.set(type, m)
  }

  /** Records an item's elements once each passes the element check, else its row is `failed`. */
  put(item: MiroItem, b: Built) {
    for (const el of b.elements) {
      for (const k of Object.keys(el)) if (el[k] === undefined) delete el[k]
      if (!checkElement(el).ok) {
        this.row(item.id, item.type, 'failed', null, ['element-invalid'])
        return
      }
    }
    this.built.set(item.id, b)
    this.row(item.id, item.type, b.result, b.main?.id ?? null, b.notes)
  }

  // ---- geometry ----

  parentFrame(item: MiroItem): MiroItem | null {
    const p = item.parent?.id ? this.items.get(item.parent.id) : undefined
    return p?.type === 'frame' ? p : null
  }

  /** The outermost frame an item is in (the Lobby frame it belongs to), or null. */
  topFrameOf(item: MiroItem): string | null {
    let top: string | null = null
    let cur: MiroItem | null = item
    for (let depth = 0; cur && depth < 16; depth++) {
      const p = this.parentFrame(cur)
      if (!p) break
      top = p.id
      cur = p
    }
    return top
  }

  /** The item's absolute box (top-left, unrotated size, angle), or null when Miro gave no usable position. */
  boxOf(item: MiroItem, depth = 0): Box | null {
    if (this.boxes.has(item.id)) return this.boxes.get(item.id) ?? null
    this.boxes.set(item.id, null) // a parent cycle reads as no position
    const pos = rec(item.position)
    const geo = rec(item.geometry)
    const px = num(pos.x, Number.NaN)
    const py = num(pos.y, Number.NaN)
    let box: Box | null = null
    if (Number.isFinite(px) && Number.isFinite(py) && depth < 16) {
      let cx = px
      let cy = py
      let ok = true
      if (str(pos.relativeTo) === 'parent_top_left') {
        const parent = item.parent?.id ? this.items.get(item.parent.id) : undefined
        const pb = parent ? this.boxOf(parent, depth + 1) : null
        if (pb) {
          cx += pb.x
          cy += pb.y
        } else ok = false
      }
      if (ok) {
        const d = DEFAULT_SIZE[item.type] ?? ([200, 100] as const)
        const w = clamp(num(geo.width, d[0]), MIN_SIZE, 100_000)
        const h = clamp(num(geo.height, item.type === 'sticky_note' ? w : d[1]), MIN_SIZE, 100_000)
        const deg = num(geo.rotation, 0)
        let angle = ((deg % 360) + 360) % 360
        if (angle > 180) angle -= 360
        box = { x: cx - w / 2, y: cy - h / 2, w, h, angle: round2((angle * Math.PI) / 180) }
      }
    }
    this.boxes.set(item.id, box)
    return box
  }

  /** The box kept inside the canvas (and whether it moved). */
  inside(box: Box, notes: MiroNote[]): Box {
    const lim = COORD_LIMIT - 1
    const w = Math.min(box.w, lim)
    const h = Math.min(box.h, lim)
    const x = clamp(box.x, -lim, lim - w)
    const y = clamp(box.y, -lim, lim - h)
    if (x !== box.x || y !== box.y) notes.push('position-clamped')
    return { x: round2(x), y: round2(y), w: round2(w), h: round2(h), angle: box.angle }
  }

  frameIdOf(item: MiroItem): string | null {
    const top = this.topFrameOf(item)
    return top ? (this.frameIds.get(top) ?? null) : null
  }

  // ---- element helpers ----

  base(type: string, box: Box, frameId: string | null, id = this.newId()): El {
    return {
      id,
      type,
      x: box.x,
      y: box.y,
      width: box.w,
      height: box.h,
      angle: box.angle,
      strokeColor: LOBBY_INK,
      backgroundColor: 'transparent',
      fillStyle: 'solid',
      strokeWidth: 2,
      strokeStyle: 'solid',
      roundness: null,
      roughness: 0,
      opacity: 100,
      seed: this.seed(),
      version: 1,
      versionNonce: this.seed(),
      index: null,
      isDeleted: false,
      groupIds: [],
      frameId,
      boundElements: null,
      updated: this.now,
      created: null,
      link: null,
      locked: false,
    }
  }

  textEl(
    box: Box,
    frameId: string | null,
    t: {
      text: string
      size: number
      family: LobbyFontFamily
      align: 'left' | 'center' | 'right'
      valign: 'top' | 'middle' | 'bottom'
      ink: string
      containerId: string | null
      autoResize: boolean
    },
  ): El {
    return {
      ...this.base('text', box, frameId),
      strokeColor: t.ink,
      text: t.text,
      fontSize: t.size,
      fontFamily: t.family,
      baseFontSize: null,
      textAlign: t.align,
      verticalAlign: t.valign,
      containerId: t.containerId,
      originalText: t.text,
      autoResize: t.autoResize,
      lineHeight: LINE_HEIGHT,
      labelPosition: null,
    }
  }

  /** A bound label in `container`, laid out by the engine (the container grows to fit, as in the editor). */
  label(
    container: El,
    words: string,
    t: {
      size: number
      family: LobbyFontFamily
      align: 'left' | 'center' | 'right'
      valign: 'top' | 'middle' | 'bottom'
      ink: string
    },
  ): El | null {
    if (!words) return null
    const label = this.textEl(
      { x: container.x as number, y: container.y as number, w: 0, h: 0, angle: container.angle as number },
      container.frameId as string | null,
      { ...t, text: words, containerId: container.id, autoResize: true },
    )
    container.boundElements = [{ id: label.id, type: 'text' }]
    const lay = layoutBoundText(container as unknown as EngineElement, label as unknown as TextElement)
    container.width = round2(lay.container.width)
    container.height = round2(lay.container.height)
    Object.assign(label, lay.text)
    return label
  }

  // ---- per type ----

  build(item: MiroItem, raw: Box): Built {
    const notes: MiroNote[] = []
    const box = this.inside(raw, notes)
    const frameId = this.frameIdOf(item)
    switch (item.type) {
      case 'sticky_note':
        return this.sticky(item, box, frameId, notes)
      case 'shape':
        return this.shape(item, box, frameId, notes)
      case 'text':
        return this.text(item, box, frameId, notes)
      case 'frame':
        return this.frame(item, box, frameId, notes)
      case 'image':
      case 'document':
        return this.file(item, box, frameId, notes)
      case 'card':
      case 'app_card':
        return this.card(item, box, frameId, notes)
      case 'embed':
        return this.embed(item, box, frameId, notes)
      case 'data_table_format':
        return this.placeholder(item, box, frameId, [...notes, 'table-not-imported'])
      case 'doc_format':
        return this.placeholder(item, box, frameId, [...notes, 'doc-not-imported'])
      case 'preview':
        return this.placeholder(item, box, frameId, [...notes, 'preview-not-imported'])
      default:
        return this.placeholder(item, box, frameId, [...notes, 'unknown-type'])
    }
  }

  sticky(item: MiroItem, box: Box, frameId: string | null, notes: MiroNote[]): Built {
    const style = rec(item.style)
    const { color, substituted } = stickyColor(style.fillColor)
    if (substituted) notes.push('color-substituted')
    const words = this.words(item.data?.content, notes)
    const w = round2(clamp(box.w, 100, 1200))
    const h = round2(clamp(box.h, 100, 1200))
    const x = round2(box.x + (box.w - w) / 2)
    const y = round2(box.y + (box.h - h) / 2)
    const built = buildStickyNote({
      id: this.newId(),
      labelId: this.newId(),
      x,
      y,
      text: words,
      width: w,
      baseHeight: h,
      angle: box.angle,
      fontFamily: 6,
      baseFontSize: clamp(Math.round((20 * w) / 200), 10, 96),
      backgroundColor: color.fill,
      strokeColor: LOBBY_INK,
      seed: this.seed(),
    })
    const note = { ...built.note, frameId, versionNonce: this.seed(), updated: this.now } as unknown as El
    if (!built.label) return { elements: [note], main: note, result: 'native', notes }
    const label = {
      ...built.label,
      frameId,
      versionNonce: this.seed(),
      updated: this.now,
      textAlign: textAlignOf(style.textAlign, 'center'),
      verticalAlign: verticalOf(style.textAlignVertical, 'middle'),
    } as unknown as El
    const lay = layoutStickyNote(note as unknown as StickyNoteElement, label as unknown as TextElement)
    Object.assign(note, lay.container)
    if (lay.text) Object.assign(label, lay.text)
    return {
      elements: [note, label],
      main: note,
      result: notes.includes('text-truncated') ? 'approximate' : 'native',
      notes,
    }
  }

  /** An item's text (HTML → plain), with its notes. */
  words(content: unknown, notes: MiroNote[], max = MAX_ORIGINAL_TEXT_CHARS): string {
    const t = htmlToText(content, max)
    if (t.formatted) notes.push('text-formatting-lost')
    if (t.truncated) notes.push('text-truncated')
    return t.text
  }

  shape(item: MiroItem, box: Box, frameId: string | null, notes: MiroNote[]): Built {
    const data = rec(item.data)
    const style = rec(item.style)
    const kind = str(data.shape) || 'rectangle'
    const native = NATIVE_SHAPES[kind]
    const approx = APPROX_SHAPES[kind]
    const outline = POLYGONS[kind]
    let result: ImportItemResult = 'native'
    const fill = hexColor(style.fillColor, 'transparent')
    const fillOpacity = clamp(num(style.fillOpacity, 1), 0, 1) * hexAlpha(fill)
    const border = hexColor(style.borderColor, LOBBY_INK)
    const borderOpacity = clamp(num(style.borderOpacity, 1), 0, 1) * hexAlpha(border)
    const filled = fill !== 'transparent' && fillOpacity >= 0.05
    const opacity = Math.round(
      100 * clamp(filled ? Math.min(fillOpacity, borderOpacity) : borderOpacity, 0.1, 1),
    )
    const strokeWidth = clamp(num(style.borderWidth, 2), 0, 24)
    const strokeColor = strokeWidth === 0 || borderOpacity < 0.05 ? 'transparent' : withoutAlpha(border)
    const look = {
      strokeColor,
      backgroundColor: filled ? withoutAlpha(fill) : 'transparent',
      strokeWidth: Math.max(strokeWidth, 0.5),
      strokeStyle: strokeStyleOf(style.borderStyle),
      opacity,
    }
    const font = fontOf(style.fontFamily)
    if (font.substituted) notes.push('font-substituted')
    const words = this.words(data.content, notes)
    const labelStyle = {
      size: clamp(num(style.fontSize, 14), 6, 512),
      family: font.family,
      align: textAlignOf(style.textAlign, 'center'),
      valign: verticalOf(style.textAlignVertical, 'middle'),
      ink: withoutAlpha(hexColor(style.color, LOBBY_INK)),
    }
    if (outline && !native) {
      // a polygon cannot hold a label: the outline is a closed line, and a see-through rectangle over it holds the
      // label and the connectors (the canvas's own polygon tools do the same); both share a group
      notes.push('shape-polygon')
      const group = this.newId()
      const pts = outline(box.w, box.h).map(([px, py]) => [round2(box.x + px), round2(box.y + py)] as const)
      const [x0, y0] = pts[0] as Pt
      const rel = pts.map(([px, py]) => [round2(px - x0), round2(py - y0)] as [number, number])
      const xs = rel.map((p) => p[0])
      const ys = rel.map((p) => p[1])
      const line: El = {
        ...this.base('line', { ...box, x: x0, y: y0 }, frameId),
        ...look,
        width: round2(Math.max(...xs) - Math.min(...xs)),
        height: round2(Math.max(...ys) - Math.min(...ys)),
        groupIds: [group],
        points: rel,
        startBinding: null,
        endBinding: null,
        startArrowhead: null,
        endArrowhead: null,
        polygon: true,
      }
      const holder: El = {
        ...this.base('rectangle', box, frameId),
        strokeColor: 'transparent',
        backgroundColor: 'transparent',
        groupIds: [group],
      }
      const label = this.label(holder, words, labelStyle)
      if (label) label.groupIds = [group]
      // the line under the see-through holder; the label right after its container
      return { elements: label ? [line, holder, label] : [line, holder], main: holder, result, notes }
    }
    const spec = native ?? approx ?? { type: 'rectangle' as const }
    if (!native) {
      result = 'approximate'
      notes.push('shape-approximated')
    }
    const el: El = {
      ...this.base(spec.type, box, frameId),
      ...look,
      roundness: spec.round ? { type: 3 } : spec.type === 'rectangle' ? null : { type: 2 },
    }
    const label = this.label(el, words, labelStyle)
    if (notes.includes('text-truncated')) result = 'approximate'
    return { elements: label ? [el, label] : [el], main: el, result, notes }
  }

  text(item: MiroItem, box: Box, frameId: string | null, notes: MiroNote[]): Built {
    const style = rec(item.style)
    const t = htmlToText(item.data?.content, MAX_ORIGINAL_TEXT_CHARS)
    if (t.formatted) notes.push('text-formatting-lost')
    if (t.truncated) notes.push('text-truncated')
    if (!t.text) return { elements: [], main: null, result: 'skipped', notes }
    const font = fontOf(style.fontFamily)
    if (font.substituted) notes.push('font-substituted')
    const size = clamp(num(style.fontSize, 14), 6, 512)
    const width = Math.max(box.w, size)
    const wrapped = wrapLabelText(t.text, font.family, size, width)
    const height = round2(wrapped.split('\n').length * size * LINE_HEIGHT)
    // Miro's centre stays the centre: the box's height is ours (the words decide it)
    const y = round2(box.y + box.h / 2 - height / 2)
    const el = this.textEl({ ...box, y, w: round2(width), h: height }, frameId, {
      text: wrapped,
      size,
      family: font.family,
      align: textAlignOf(style.textAlign, 'left'),
      valign: 'top',
      ink: withoutAlpha(hexColor(style.color, LOBBY_INK)),
      containerId: null,
      autoResize: false,
    })
    el.originalText = t.text
    el.link = this.link(t.links, notes)
    return {
      elements: [el],
      main: el,
      result: notes.includes('text-truncated') ? 'approximate' : 'native',
      notes,
    }
  }

  /** The first link Lobby may store, or null (`link-dropped` when there was one it may not). */
  link(links: readonly string[], notes: MiroNote[]): string | null {
    const first = links.find((l) => isAllowedLink(l) && !l.startsWith('/'))
    if (!first && links.length) notes.push('link-dropped')
    return first ?? null
  }

  frame(item: MiroItem, box: Box, frameId: string | null, notes: MiroNote[]): Built {
    const data = rec(item.data)
    const style = rec(item.style)
    const name = cleanText(str(data.title)).replace(/\n+/g, ' ').slice(0, MAX_FRAME_NAME_CHARS) || null
    const fill = hexColor(style.fillColor, 'transparent')
    if (fill !== 'transparent' && !/^#fff(fff)?(ff)?$/.test(fill) && hexAlpha(fill) > 0.05)
      notes.push('frame-fill-dropped')
    const id = this.frameIds.get(item.id)
    if (id) {
      const el: El = {
        ...this.base('frame', { ...box, angle: 0 }, null, id),
        strokeColor: LOBBY_FRAME_STROKE,
        name,
      }
      return { elements: [el], main: el, result: 'native', notes }
    }
    // a frame inside a frame (Excalidraw has no nesting): a dashed box with the frame's name, its children in the
    // outer frame
    notes.unshift('frame-nested')
    const el: El = {
      ...this.base('rectangle', { ...box, angle: 0 }, frameId),
      strokeColor: LOBBY_FRAME_STROKE,
      strokeStyle: 'dashed',
    }
    const label = name
      ? this.label(el, name, { size: 16, family: 6, align: 'left', valign: 'top', ink: PLACEHOLDER_INK })
      : null
    return { elements: label ? [el, label] : [el], main: el, result: 'approximate', notes }
  }

  file(item: MiroItem, box: Box, frameId: string | null, notes: MiroNote[]): Built {
    const outcome: MiroFileOutcome | undefined = this.body.files?.[item.id]
    const stored = outcome && 'stored' in outcome ? outcome.stored : null
    if (!stored) {
      const failed = outcome && 'failed' in outcome ? outcome.failed : 'file-failed'
      return this.placeholder(item, box, frameId, [...notes, failed], failed === 'file-not-imported-yet')
    }
    const data = rec(item.data)
    const alt = cleanText(str(data.altText) || (item.type === 'image' ? str(data.title) : '')).slice(
      0,
      MAX_ALT_CHARS,
    )
    const el: El = {
      ...this.base('image', box, frameId),
      strokeColor: 'transparent',
      status: 'saved',
      fileId: stored.versionId,
      scale: [1, 1],
      crop: null,
      customData: {
        lobby: {
          file: {
            assetId: stored.assetId,
            versionId: stored.versionId,
            kind: item.type === 'image' ? 'image' : stored.kind,
            name: stored.name.slice(0, MAX_FILE_NAME_CHARS),
            mimeType: stored.mimeType,
            sizeBytes: stored.sizeBytes,
          },
          ...(alt ? { alt } : {}),
        },
      },
    }
    return { elements: [el], main: el, result: 'native', notes }
  }

  card(item: MiroItem, box: Box, frameId: string | null, notes: MiroNote[]): Built {
    const data = rec(item.data)
    const style = rec(item.style)
    const lines: string[] = []
    const title = this.words(data.title, notes, 2000)
    if (title) lines.push(title)
    const description = this.words(data.description, notes, 8000)
    if (description) lines.push('', description)
    if (item.type === 'card') {
      const due = /^(\d{4}-\d{2}-\d{2})/.exec(str(data.dueDate))?.[1]
      const who = this.body.members?.[str(data.assigneeId)]
      const meta = [due ? `Due ${due}` : '', who ? `Assignee: ${cleanText(who).slice(0, 120)}` : ''].filter(
        Boolean,
      )
      if (meta.length) lines.push('', ...meta)
    } else {
      const fields = Array.isArray(data.fields) ? data.fields.filter(isRecord).slice(0, 40) : []
      const values = fields.map((f) => cleanText(str(f.value)).slice(0, 400)).filter(Boolean)
      if (values.length) lines.push('', ...values)
      const status = cleanText(str(data.status)).slice(0, 40)
      if (status) lines.push('', `Status: ${status}`)
    }
    notes.push(item.type === 'card' ? 'card-as-shape' : 'app-card-as-shape')
    const theme = hexColor(style.cardTheme ?? style.fillColor, '#2d9bf0')
    const el: El = {
      ...this.base('rectangle', box, frameId),
      strokeColor: theme === 'transparent' ? PLACEHOLDER_STROKE : withoutAlpha(theme),
      backgroundColor: CARD_FILL,
      roundness: { type: 3 },
    }
    const words = lines.join('\n').slice(0, MAX_ORIGINAL_TEXT_CHARS)
    const label = this.label(el, words, { size: 14, family: 6, align: 'left', valign: 'top', ink: LOBBY_INK })
    return { elements: label ? [el, label] : [el], main: el, result: 'approximate', notes }
  }

  embed(item: MiroItem, box: Box, frameId: string | null, notes: MiroNote[]): Built {
    const data = rec(item.data)
    const url = str(data.url).trim()
    if (!url || !isAllowedLink(url) || url.startsWith('/'))
      return this.placeholder(item, box, frameId, [...notes, 'link-dropped'])
    notes.push('embed-as-link')
    const title = cleanText(str(data.title) || str(data.providerName) || url).slice(0, 500)
    const el: El = {
      ...this.base('rectangle', box, frameId),
      strokeColor: PLACEHOLDER_STROKE,
      backgroundColor: CARD_FILL,
      roundness: { type: 3 },
      link: url,
      customData: { lobby: { kind: 'link-card' } },
    }
    const label = this.label(el, title, { size: 16, family: 6, align: 'left', valign: 'top', ink: LOBBY_INK })
    return { elements: label ? [el, label] : [el], main: el, result: 'approximate', notes }
  }

  /** A dashed grey box with a label saying what it stands for (plain native elements; `kind: placeholder`). */
  placeholder(item: MiroItem, raw: Box, frameId: string | null, notes: MiroNote[], notYet = false): Built {
    const box = { ...raw, w: Math.max(raw.w, 160), h: Math.max(raw.h, 90) }
    const what = PLACEHOLDER_WORDS[item.type] ?? 'Miro item'
    const words = notYet
      ? `${what}: not imported yet (see the report)`
      : `${what}: not imported (see the report)`
    const el: El = {
      ...this.base('rectangle', box, frameId),
      strokeColor: PLACEHOLDER_STROKE,
      strokeStyle: 'dashed',
      customData: { lobby: { kind: 'placeholder' } },
    }
    const label = this.label(el, words, {
      size: 16,
      family: 6,
      align: 'center',
      valign: 'middle',
      ink: PLACEHOLDER_INK,
    })
    return { elements: label ? [el, label] : [el], main: el, result: 'placeholder', notes }
  }

  // ---- items without a position: placeholders in a frame to the right of everything ----

  readonly extra: El[] = []

  placeWithoutBox(items: readonly MiroItem[]) {
    if (!items.length) return
    let maxX = 0
    let minY = 0
    let any = false
    for (const b of this.built.values())
      for (const e of b.elements) {
        const right = (e.x as number) + (e.width as number)
        maxX = any ? Math.max(maxX, right) : right
        minY = any ? Math.min(minY, e.y as number) : (e.y as number)
        any = true
      }
    const cols = 4
    const cell = { w: 240, h: 140, gap: 40 }
    const rows = Math.ceil(items.length / cols)
    const frameBox = this.inside(
      {
        x: maxX + 400,
        y: minY,
        w: cols * (cell.w + cell.gap) + cell.gap,
        h: rows * (cell.h + cell.gap) + cell.gap,
        angle: 0,
      },
      [],
    )
    const frame: El = {
      ...this.base('frame', frameBox, null),
      strokeColor: LOBBY_FRAME_STROKE,
      name: 'Not imported from Miro',
    }
    this.extra.push(frame)
    for (const [i, item] of items.entries()) {
      const box: Box = {
        x: frameBox.x + cell.gap + (i % cols) * (cell.w + cell.gap),
        y: frameBox.y + cell.gap + Math.floor(i / cols) * (cell.h + cell.gap),
        w: cell.w,
        h: cell.h,
        angle: 0,
      }
      this.put(item, this.placeholder(item, box, frame.id as string, ['no-geometry']))
    }
    // the frame's own elements are painted with it (after the items that have a position)
    for (const item of items) {
      const b = this.built.get(item.id)
      if (b) this.extra.push(...b.elements)
      this.built.delete(item.id)
      if (b) this.homeless.set(item.id, b)
    }
  }

  /** Items placed in the "Not imported" frame (painted with it; connectors and tags still find them). */
  readonly homeless = new Map<string, Built>()
  builtOf = (id: string) => this.built.get(id) ?? this.homeless.get(id)

  // ---- tags ----

  applyTags() {
    const defs = new Map<string, { name: string; color: TagColor }>()
    for (const tag of Array.isArray(this.body.tags) ? this.body.tags : []) {
      if (!isRecord(tag) || typeof tag.title !== 'string' || typeof tag.id !== 'string') continue
      let name = normalizeTagName(tag.title)
      name = normalizeTagName([...name].slice(0, 24).join(''))
      const key = name ? tagKey(name) : ''
      const { color, exact } = tagColor(tag.fillColor)
      const ids = this.body.tagItems?.[tag.id] ?? []
      if (!key || !parseTagValue(key, { name, color })) {
        this.note('tag-dropped')
        this.tally('tag', 'skipped')
        continue
      }
      if (!defs.has(key)) {
        if (defs.size >= MAX_TAG_DEFS) {
          this.note('tag-dropped')
          this.tally('tag', 'skipped')
          continue
        }
        defs.set(key, { name, color })
        if (!exact) this.note('tag-color-substituted')
      }
      const def = defs.get(key) as { name: string; color: TagColor }
      this.tally('tag', exact ? 'native' : 'approximate')
      for (const id of Array.isArray(ids) ? ids.slice(0, 10_000) : []) {
        const main = typeof id === 'string' ? this.builtOf(id)?.main : null
        if (!main) continue
        const custom = rec(main.customData)
        const lobby = { ...rec(custom.lobby) }
        if (`tag:${key}` in lobby) continue
        if (Object.keys(lobby).filter((k) => k.startsWith('tag:')).length >= MAX_TAGS_PER_ELEMENT) {
          this.note('tag-dropped')
          continue
        }
        lobby[`tag:${key}`] = { name: def.name, color: def.color }
        main.customData = { ...custom, lobby }
      }
    }
    for (const [key, def] of defs) this.doc[`tagDef:${key}`] = def
  }

  // ---- groups ----

  applyGroups() {
    const grouped = new Set<string>()
    for (const g of Array.isArray(this.body.groups) ? this.body.groups : []) {
      if (!isRecord(g) || !Array.isArray(g.items)) continue
      const members = [...new Set(g.items.filter((x): x is string => typeof x === 'string'))]
      const built = members.map((id) => this.built.get(id))
      const frames = new Set(built.map((b) => b?.main?.frameId ?? null))
      const ok =
        members.length >= 2 &&
        built.every((b) => b?.main) &&
        frames.size === 1 &&
        members.every((id) => !grouped.has(id))
      if (!ok) {
        this.note('group-dropped')
        this.tally('group', 'skipped')
        continue
      }
      const gid = this.newId()
      for (const id of members) {
        grouped.add(id)
        for (const e of this.built.get(id)?.elements ?? []) e.groupIds = [...(e.groupIds as string[]), gid]
      }
      this.tally('group', 'native')
    }
  }

  // ---- connectors ----

  connectors(): El[][] {
    const out: El[][] = []
    const list = Array.isArray(this.body.connectors) ? this.body.connectors : []
    for (const c of list.slice(MIRO_IMPORT_LIMITS.connectorsPerBoard))
      if (isRecord(c) && typeof c.id === 'string')
        this.row(c.id, 'connector', 'skipped', null, ['over-limit'])
    const byId = new Map<string, El>()
    for (const b of [...this.built.values(), ...this.homeless.values()])
      for (const e of b.elements) byId.set(e.id, e)
    for (const c of list.slice(0, MIRO_IMPORT_LIMITS.connectorsPerBoard)) {
      if (!isRecord(c) || typeof c.id !== 'string') continue
      const els = this.connector(c as unknown as MiroConnector, byId)
      if (els) out.push(els)
    }
    return out
  }

  /** One end: the element it binds to (and where), or only a point (an item Lobby did not make). */
  end(e: MiroConnectorEnd | null | undefined): { el: El | null; at: Pt } | null {
    if (!e || typeof e.id !== 'string') return null
    const main = this.builtOf(e.id)?.main ?? null
    if (main && ((main.boundElements as unknown[] | null)?.length ?? 0) < MAX_BOUND_ELEMENTS - 1) {
      const px = percent(e.position?.x) ?? 0.5
      const py = percent(e.position?.y) ?? 0.5
      const x = main.x as number
      const y = main.y as number
      return { el: main, at: [x + (main.width as number) * px, y + (main.height as number) * py] }
    }
    const item = this.items.get(e.id)
    const box = item ? this.boxOf(item) : null
    return box ? { el: null, at: [box.x + box.w / 2, box.y + box.h / 2] } : null
  }

  connector(c: MiroConnector, byId: Map<string, El>): El[] | null {
    const notes: MiroNote[] = []
    const a = this.end(c.startItem)
    const z = this.end(c.endItem)
    if (!a || !z) {
      this.row(c.id, 'connector', 'skipped', null, ['connector-end-unbound'])
      return null
    }
    if (!a.el || !z.el) notes.push('connector-end-unbound')
    const style = rec(c.style)
    const shape = str(c.shape) || 'curved'
    const unsupported = c.isSupported === false
    if (unsupported) notes.push('connector-unsupported')
    const elbowed = shape === 'elbowed' && !unsupported && !!a.el && !!z.el
    const curved = shape === 'curved' && !unsupported
    if (curved) notes.push('connector-curved')
    const startCap = capOf(style.startStrokeCap, null)
    const endCap = capOf(style.endStrokeCap, 'arrow')
    if (!startCap.exact || !endCap.exact) notes.push('connector-cap-approximated')
    const [x0, y0] = a.at
    const dx = round2(z.at[0] - x0)
    const dy = round2(z.at[1] - y0)
    const arrow: El = {
      ...this.base(
        'arrow',
        { x: round2(x0), y: round2(y0), w: Math.abs(dx), h: Math.abs(dy), angle: 0 },
        null,
      ),
      strokeColor: withoutAlpha(hexColor(style.strokeColor, LOBBY_INK)),
      strokeWidth: clamp(num(style.strokeWidth, 2), 1, 24),
      strokeStyle: strokeStyleOf(style.strokeStyle),
      roundness: curved ? { type: 2 } : null,
      points: [
        [0, 0],
        [dx || 1, dy],
      ],
      startBinding: a.el ? this.binding(a.el, a.at) : null,
      endBinding: z.el ? this.binding(z.el, z.at) : null,
      startArrowhead: startCap.head,
      endArrowhead: endCap.head,
      elbowed,
    }
    if (elbowed) Object.assign(arrow, { fixedSegments: null, startIsSpecial: false, endIsSpecial: false })
    const targets = [a.el, z.el].filter((t): t is El => t !== null)
    // the arrow is in the map while it is re-snapped (removed again when it fails its check)
    const map = byId
    map.set(arrow.id, arrow)
    for (let i = 0; i < 4 && targets.length; i++) {
      const snapped = resnapArrow(
        arrow as unknown as ArrowElementLike,
        map as unknown as ReadonlyMap<string, EngineElement>,
      )
      if (!snapped.changed) break
      Object.assign(arrow, snapped.path)
    }
    // the first caption is the arrow's label; later ones are counted
    const captions = Array.isArray(c.captions) ? c.captions : []
    if (captions.length > 1) notes.push('connector-caption-extra')
    const first = captions[0]
    let label: El | null = null
    const words = first ? this.words(first.content, notes, 200) : ''
    if (words) {
      label = this.textEl({ x: arrow.x as number, y: arrow.y as number, w: 0, h: 0, angle: 0 }, null, {
        text: words,
        size: clamp(num(style.fontSize, 14), 6, 256),
        family: 6,
        align: 'center',
        valign: 'middle',
        ink: withoutAlpha(hexColor(style.color, LOBBY_INK)),
        containerId: arrow.id,
        autoResize: true,
      })
      const p = percent(first?.position)
      if (p !== null && Math.abs(p - 0.5) > 0.01) label.labelPosition = clamp(p, 0, 1)
      arrow.boundElements = [{ id: label.id, type: 'text' }]
      const lay = arrowLabelLayout(
        arrow as unknown as ArrowElementLike,
        label as unknown as EngineElement,
        map as unknown as ReadonlyMap<string, EngineElement>,
        { leased: false },
      )
      Object.assign(label, {
        x: round2(lay.x),
        y: round2(lay.y),
        ...(lay.text !== undefined ? { text: lay.text } : {}),
        ...(lay.width !== undefined ? { width: round2(lay.width) } : {}),
        ...(lay.height !== undefined ? { height: round2(lay.height) } : {}),
      })
    }
    const els = label ? [arrow, label] : [arrow]
    for (const e of els) {
      for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k]
      if (!checkElement(e).ok) {
        byId.delete(arrow.id)
        this.row(c.id, 'connector', 'failed', null, ['element-invalid'])
        return null
      }
    }
    for (const t of targets) {
      const bound = (t.boundElements as { id: string; type: string }[] | null) ?? []
      if (!bound.some((b) => b.id === arrow.id)) t.boundElements = [...bound, { id: arrow.id, type: 'arrow' }]
    }
    const result: ImportItemResult = notes.some((n) =>
      [
        'connector-curved',
        'connector-unsupported',
        'connector-end-unbound',
        'connector-cap-approximated',
        'text-truncated',
      ].includes(n),
    )
      ? 'approximate'
      : 'native'
    this.row(c.id, 'connector', result, arrow.id, notes)
    return els
  }

  binding(target: El, at: Pt) {
    const w = (target.width as number) || 1
    const h = (target.height as number) || 1
    return {
      elementId: target.id,
      fixedPoint: fixedPoint((at[0] - (target.x as number)) / w, (at[1] - (target.y as number)) / h),
      mode: 'orbit' as const,
    }
  }
}

/** Sizes for an item whose geometry lacks one (Miro's own defaults, about). */
const DEFAULT_SIZE: Readonly<Record<string, readonly [number, number]>> = {
  sticky_note: [199, 228],
  shape: [200, 100],
  text: [200, 40],
  frame: [800, 600],
  image: [320, 240],
  document: [200, 260],
  card: [320, 160],
  app_card: [320, 160],
  embed: [480, 270],
  preview: [400, 120],
  doc_format: [400, 300],
  data_table_format: [400, 300],
}
