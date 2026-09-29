/**
 * tldraw 5.4.2 records → Excalidraw 0.18.0-1118751 elements (docs/EXCALIDRAW-MIGRATION.md §5.1-§5.3),
 * ported from [DATA]'s prototype (`data/proto/convert.ts`, written for 0.18.1) to the pinned engine.
 *
 * Pure and deterministic: the same records and options give byte-identical output whatever the input
 * order. No engine constructor is called for ids or `created` (spike A: `convertToExcalidrawElements`
 * regenerates ids, stamps `created` and cannot bind an arrow to a `stickynote`); elements are built as
 * plain objects with the engine's own field set, ids kept, `created: null`, hand-built
 * `FixedPointBinding`s and the targets' `boundElements`. Layout comes from the engine
 * (`getStickyNoteLayout`, `wrapText`) through `@draftroom/canvas-schema/engine`, measured with the server
 * text metrics.
 *
 * Two modes, one per-record core:
 * - **whole board** (`convertBoard`): every shape in paint order, page offsets computed at the first
 *   conversion (then frozen in `lb_doc.import.legacyPages`) or reused, fractional indices generated in
 *   paint order (labels right after their containers);
 * - **local** (`convertRecords`, §5.1 "local mode"): a given set of records, page offsets from the
 *   frozen `legacyPages`, each record's absolute transform resolved through its parent chain in the given
 *   snapshot, NO index. Converting one record alone equals its elements in the whole-board conversion
 *   apart from `index` (unit-tested), because both modes call the same per-record function.
 *
 * Every output element is checked with the server's own `checkElement` (§3.5 limits): an element the
 * server would refuse fails the board's conversion (`failures`); strokes over the point caps are
 * simplified or split first (`stroke-simplified`).
 */
import { checkElement, type WireElement } from '@draftroom/canvas-schema/elements'
import {
  indexKeysBetween,
  type LobbyFontFamily,
  layoutStickyNote,
  type StickyNoteElement,
  type TextElement,
} from '@draftroom/canvas-schema/engine'
import {
  FILE_ID_PATTERN,
  FREEDRAW_SIMPLIFY_EPSILON_PX,
  isAllowedLink,
  MAX_FRAME_NAME_CHARS,
  MAX_FREEDRAW_POINTS,
  MAX_LINEAR_POINTS,
  MAX_ORIGINAL_TEXT_CHARS,
  round2,
} from '@draftroom/canvas-schema/limits'
import { b64Vecs } from '@tldraw/tlschema'
import {
  angleOf,
  apply,
  type Box,
  bendMid,
  boxOf,
  fixedPointOnTarget,
  IDENTITY,
  linearGeometry,
  local,
  type Mat,
  mul,
  type Outline,
  orbitPoint,
  type Pt,
  polygonOf,
  rotateAbout,
  simplifyRdp,
  type TargetShape,
  translate,
} from './geometry.ts'
import { customDataOf, lobbyDataOf, lobbyServerOf, type Rec } from './meta.ts'
import { colorOf, LOBBY_INK, TL_SOLID_BACKGROUND } from './palette.ts'
import { hasText, plainLines } from './rich-text.ts'
import {
  boundTextMaxWidth,
  boundTextPosition,
  type ContainerBox,
  lineHeightOf,
  measureText,
  useMetrics,
  wrapText,
} from './text-layout.ts'
import type {
  ConvertFailure,
  ConvertOptions,
  FileRef,
  LegacyPage,
  LegacyPages,
  Lossy,
  LossyCode,
  TlRecord,
} from './types.ts'

type El = Record<string, unknown>

// ---- determinism helpers -----------------------------------------------------------------------------

/** FNV-1a 32-bit folded to a positive 31-bit int (Excalidraw seeds and nonces are ints < 2^31). */
export function hash31(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h & 0x7fffffff || 1
}

/** A tldraw id's bare part is kept when it is this safe; `.` is excluded so the `.t`/`.o`/`.g`/`.s<n>` suffixes never collide. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,100}$/

/** tldraw `shape:xyz` → element id `xyz` (so the api ref `shape:<element id>` is unchanged, §3.6). */
export function elementIdOf(tlId: string, legacyIds?: Record<string, string>): string {
  const bare = tlId.startsWith('shape:') ? tlId.slice('shape:'.length) : tlId
  if (SAFE_ID.test(bare)) return bare
  const id = `x${hash31(tlId).toString(36)}${hash31(`${tlId}#2`).toString(36)}`
  if (legacyIds) legacyIds[tlId] = id
  return id
}

/** Excalidraw `normalizeFixedPoint` (element index.js:9952): a ratio within 1e-4 of 0.5 becomes 0.5001. */
export function normalizeFixedPoint(fp: readonly [number, number]): [number, number] {
  const clamped = fp.map((r) => Math.min(10, Math.max(-10, Number.isFinite(r) ? r : 0.5001))) as [
    number,
    number,
  ]
  if (Math.abs(clamped[0] - 0.5) < 1e-4 || Math.abs(clamped[1] - 0.5) < 1e-4)
    return clamped.map((r) => (Math.abs(r - 0.5) < 1e-4 ? 0.5001 : r)) as [number, number]
  return clamped
}

const num = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)
const isObj = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v)

// ---- style maps (tldraw 5.4.2 default-shape-constants; Excalidraw constants) ---------------------------

const STROKE: Record<string, number> = { s: 2, m: 3.5, l: 5, xl: 10 }
const FONT: Record<string, number> = { s: 18, m: 24, l: 36, xl: 44 }
const LABEL: Record<string, number> = { s: 18, m: 22, l: 26, xl: 32 }
const ARROW_LABEL: Record<string, number> = { s: 18, m: 20, l: 24, xl: 28 }
const FREEDRAW: Record<string, number> = { s: 1, m: 2, l: 3, xl: 5 }
const HIGHLIGHT: Record<string, number> = { s: 6, m: 9, l: 12, xl: 18 }
/** Excalifont 5, Nunito 6, Comic Shanns 8 (§2.12); no serif exists in the engine (`serif-font`). */
const FONT_FAMILY: Record<string, LobbyFontFamily> = { draw: 5, sans: 6, serif: 6, mono: 8 }
const H_ALIGN: Record<string, 'left' | 'center' | 'right'> = {
  start: 'left',
  middle: 'center',
  end: 'right',
  'start-legacy': 'left',
  'middle-legacy': 'center',
  'end-legacy': 'right',
}
const V_ALIGN: Record<string, 'top' | 'middle' | 'bottom'> = { start: 'top', middle: 'middle', end: 'bottom' }
const ARROWHEAD: Record<string, string | null> = {
  arrow: 'arrow',
  triangle: 'triangle',
  dot: 'circle',
  diamond: 'diamond',
  bar: 'bar',
  pipe: 'bar',
  none: null,
  square: 'diamond',
  inverted: 'triangle_outline',
}
const NATIVE_GEO: Record<string, 'rectangle' | 'ellipse' | 'diamond'> = {
  rectangle: 'rectangle',
  ellipse: 'ellipse',
  diamond: 'diamond',
  oval: 'ellipse',
  'check-box': 'rectangle',
  'x-box': 'rectangle',
}
const NOTE_SIZE = 200
const STICKY_NOTE_MIN_SIZE = 75
/** Where a stroke is split when simplification cannot bring it under the cap. */
const STROKE_PART_SUFFIX = '.s'
const PLACEHOLDER_STROKE = '#9fa8b2'

// ---- the indexed snapshot -----------------------------------------------------------------------------

export interface Snapshot {
  readonly shapes: ReadonlyMap<string, TlRecord>
  readonly assets: ReadonlyMap<string, TlRecord>
  /** page ids in page order (records sorted by index, then pages only referenced by shapes) */
  readonly pageOrder: readonly string[]
  readonly pages: ReadonlyMap<string, TlRecord | null>
  readonly document: TlRecord | null
  /** arrow shape id → its arrow bindings, sorted by id */
  readonly bindingsByArrow: ReadonlyMap<string, readonly TlRecord[]>
  /** target shape id → the arrow bindings pointing at it, sorted by id */
  readonly bindingsByTarget: ReadonlyMap<string, readonly TlRecord[]>
  /** parent id → children sorted by (index, id) */
  readonly children: ReadonlyMap<string, readonly TlRecord[]>
  readonly recordCount: number
}

const byIndex = (a: TlRecord, b: TlRecord) => {
  const ai = str(a.index)
  const bi = str(b.index)
  return ai < bi ? -1 : ai > bi ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

export function indexSnapshot(records: readonly TlRecord[]): Snapshot {
  const shapes = new Map<string, TlRecord>()
  const assets = new Map<string, TlRecord>()
  const pageRecords: TlRecord[] = []
  let document: TlRecord | null = null
  const arrowBindings: TlRecord[] = []
  for (const r of records) {
    if (!r || typeof r !== 'object' || typeof r.id !== 'string') continue
    if (r.typeName === 'shape') shapes.set(r.id, r)
    else if (r.typeName === 'asset') assets.set(r.id, r)
    else if (r.typeName === 'page') pageRecords.push(r)
    else if (r.typeName === 'document') document = r
    else if (r.typeName === 'binding' && r.type === 'arrow') arrowBindings.push(r)
  }
  pageRecords.sort(byIndex)
  const pages = new Map<string, TlRecord | null>(pageRecords.map((p) => [p.id, p]))
  const referenced = new Set<string>()
  for (const s of shapes.values()) {
    const p = str(s.parentId)
    if (p.startsWith('page:') && !pages.has(p)) referenced.add(p)
  }
  const pageOrder = [...pageRecords.map((p) => p.id), ...[...referenced].sort()]
  for (const p of referenced) pages.set(p, null)
  const children = new Map<string, TlRecord[]>()
  for (const s of shapes.values()) {
    const list = children.get(str(s.parentId)) ?? []
    list.push(s)
    children.set(str(s.parentId), list)
  }
  for (const list of children.values()) list.sort(byIndex)
  arrowBindings.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const bindingsByArrow = new Map<string, TlRecord[]>()
  const bindingsByTarget = new Map<string, TlRecord[]>()
  for (const b of arrowBindings) {
    const from = str(b.fromId)
    const to = str(b.toId)
    bindingsByArrow.set(from, [...(bindingsByArrow.get(from) ?? []), b])
    bindingsByTarget.set(to, [...(bindingsByTarget.get(to) ?? []), b])
  }
  return {
    shapes,
    assets,
    pageOrder,
    pages,
    document,
    bindingsByArrow,
    bindingsByTarget,
    children,
    recordCount: records.length,
  }
}

// ---- nodes: a shape's page, frame, groups and transform ---------------------------------------------------

interface Node {
  readonly s: TlRecord
  /** page space, without the page offset */
  readonly m: Mat
  readonly page: string
  /** element id of the innermost frame ancestor */
  readonly frame: string | null
  /** group ids, innermost first */
  readonly groups: readonly string[]
  readonly orphan: boolean
}

const MAX_DEPTH = 64

function resolveNode(snap: Snapshot, id: string, legacyIds: Record<string, string>): Node | null {
  const s = snap.shapes.get(id)
  if (!s) return null
  const chain: TlRecord[] = [s]
  const seen = new Set<string>([id])
  let page: string | null = null
  let orphan = false
  for (let cur = s; ; ) {
    const parent = str(cur.parentId)
    if (snap.pages.has(parent)) {
      page = parent
      break
    }
    const next = snap.shapes.get(parent)
    if (!next || seen.has(parent) || chain.length > MAX_DEPTH) {
      orphan = true
      break
    }
    seen.add(parent)
    chain.push(next)
    cur = next
  }
  let m: Mat = IDENTITY
  let frame: string | null = null
  let groups: string[] = []
  for (let i = chain.length - 1; i >= 0; i--) {
    const r = chain[i] as TlRecord
    m = mul(m, local(num(r.x, 0), num(r.y, 0), num(r.rotation, 0)))
    if (i === 0) break
    if (r.type === 'frame') frame = elementIdOf(r.id, legacyIds)
    else if (r.type === 'group') groups = [elementIdOf(r.id, legacyIds), ...groups]
  }
  return { s, m, page: page ?? snap.pageOrder[0] ?? 'page:page', frame, groups, orphan }
}

// ---- page offsets (first whole-board conversion only; frozen afterwards) ------------------------------------

/** A rough size of a shape for page bounds (the prototype's rule: linear shapes count by their origin). */
function roughSize(s: TlRecord): { w: number; h: number } {
  const p = isObj(s.props) ? s.props : {}
  const scale = num(p.scale, 1)
  switch (s.type) {
    case 'note':
      return { w: NOTE_SIZE * scale, h: (NOTE_SIZE + num(p.growY, 0)) * scale }
    case 'geo':
      return { w: num(p.w, 0), h: num(p.h, 0) + num(p.growY, 0) }
    case 'text':
      return { w: num(p.w, 0) * scale, h: FONT[str(p.size, 'm')] ?? 24 }
    case 'frame':
    case 'image':
    case 'video':
    case 'embed':
    case 'bookmark':
    case 'dr-file-card':
      return { w: num(p.w, 0), h: num(p.h, 0) }
    default:
      return { w: 0, h: 0 }
  }
}

/** The frozen offsets of every page: page 1 stays put, each later page goes to the right of the ones before. */
export function computeLegacyPages(snap: Snapshot, pageGap = 800): LegacyPages {
  const legacyIds: Record<string, string> = {}
  const out: Record<string, LegacyPage> = {}
  let right = Number.NEGATIVE_INFINITY
  let top0 = 0
  let first = true
  snap.pageOrder.forEach((pageId, index) => {
    let minX = Number.POSITIVE_INFINITY
    let minY = Number.POSITIVE_INFINITY
    let maxX = Number.NEGATIVE_INFINITY
    for (const s of snap.children.get(pageId) ?? []) {
      const n = resolveNode(snap, s.id, legacyIds)
      if (!n) continue
      const sz = roughSize(s)
      for (const [x, y] of [
        [0, 0],
        [sz.w, 0],
        [0, sz.h],
        [sz.w, sz.h],
      ] as const) {
        const q = apply(n.m, x, y)
        minX = Math.min(minX, q.x)
        maxX = Math.max(maxX, q.x)
        minY = Math.min(minY, q.y)
      }
    }
    const page = snap.pages.get(pageId)
    const name = str(page?.name).slice(0, 200)
    if (first || minX === Number.POSITIVE_INFINITY) {
      out[pageId] = { dx: 0, dy: 0, index, name }
      if (minX !== Number.POSITIVE_INFINITY) {
        right = Math.max(right, maxX)
        if (first) top0 = minY
        first = false
      }
      return
    }
    const dx = round2(right + pageGap - minX)
    const dy = round2(top0 - minY)
    out[pageId] = { dx, dy, index, name }
    right = maxX + dx
  })
  return out
}

// ---- the per-record core ---------------------------------------------------------------------------------

interface ShapeOut {
  /** the elements this record makes, in paint order */
  readonly elements: El[]
  /** the element arrows bind to (null: not bindable) */
  readonly main: El | null
  readonly outline: Outline
  readonly lossy: LossyCode[]
  readonly files: FileRef[]
}

class Core {
  readonly legacyIds: Record<string, string> = {}
  readonly failures: ConvertFailure[] = []
  private readonly nodes = new Map<string, Node | null>()
  private readonly outs = new Map<string, ShapeOut | null>()
  private readonly snap: Snapshot
  private readonly opts: ConvertOptions
  private readonly pages: LegacyPages
  constructor(snap: Snapshot, opts: ConvertOptions, pages: LegacyPages) {
    this.snap = snap
    this.opts = opts
    this.pages = pages
    useMetrics(opts.metrics)
  }

  idOf(tlId: string): string {
    return elementIdOf(tlId, this.legacyIds)
  }

  node(id: string): Node | null {
    if (!this.nodes.has(id)) this.nodes.set(id, resolveNode(this.snap, id, this.legacyIds))
    return this.nodes.get(id) ?? null
  }

  /** The node's matrix in the flattened board (page offset applied), or null when its page has no frozen offset. */
  boardMatrix(n: Node): Mat | null {
    const off = this.pages[n.page]
    return off ? mul(translate(off.dx, off.dy), n.m) : null
  }

  /** The shape's elements (memoized; a target converted for an arrow is converted once). */
  convert(id: string): ShapeOut | null {
    if (this.outs.has(id)) return this.outs.get(id) ?? null
    this.outs.set(id, null) // cycle guard (arrows never convert arrows)
    const n = this.node(id)
    let out: ShapeOut | null = null
    if (n) {
      const m = this.boardMatrix(n)
      if (!m) this.failures.push({ id, code: 'PAGE_MISSING', detail: 'no frozen offset for the page' })
      else out = this.shape(n, m)
    }
    this.outs.set(id, out)
    return out
  }

  // ---- common fields ----

  private common(
    id: string,
    type: string,
    n: Node,
    g: { x: number; y: number; w: number; h: number; angle: number },
  ): El {
    return {
      id,
      type,
      x: g.x,
      y: g.y,
      width: g.w,
      height: g.h,
      angle: g.angle,
      strokeColor: '#1e1e1e',
      backgroundColor: 'transparent',
      fillStyle: 'solid',
      strokeWidth: 2,
      strokeStyle: 'solid',
      roughness: 0,
      opacity: Math.round(Math.min(1, Math.max(0, num(n.s.opacity, 1))) * 100),
      groupIds: [...n.groups],
      frameId: n.frame,
      index: null,
      roundness: null,
      seed: hash31(id),
      version: 1,
      versionNonce: hash31(`${id}#nonce`),
      isDeleted: false,
      boundElements: null,
      updated: this.opts.updatedAt,
      created: null,
      link: null,
      locked: n.s.isLocked === true,
    }
  }

  /** Arrows bound to shape `targetId` that keep their binding (the target's `boundElements`), sorted by id. */
  private boundArrows(targetId: string): { id: string; type: 'arrow' }[] {
    const ids = new Set<string>()
    for (const b of this.snap.bindingsByTarget.get(targetId) ?? []) {
      const arrowId = str(b.fromId)
      const chosen = this.chosenBinding(arrowId, str(isObj(b.props) ? b.props.terminal : ''))
      if (chosen?.id === b.id && this.snap.shapes.get(arrowId)?.type === 'arrow') ids.add(this.idOf(arrowId))
    }
    return [...ids].sort().map((id) => ({ id, type: 'arrow' as const }))
  }

  /** The binding an arrow keeps for a terminal: the first by id whose target is bindable. */
  private chosenBinding(arrowId: string, terminal: string): TlRecord | null {
    for (const b of this.snap.bindingsByArrow.get(arrowId) ?? []) {
      if ((isObj(b.props) ? b.props.terminal : null) !== terminal) continue
      return isBindableShape(this.snap.shapes.get(str(b.toId))) ? b : null
    }
    return null
  }

  private setBound(el: El, label: El | null, shapeId: string) {
    const arrows = this.boundArrows(shapeId)
    const list = [...(label ? [{ id: label.id as string, type: 'text' as const }] : []), ...arrows]
    el.boundElements = list.length ? list : null
  }

  private link(url: unknown, lossy: LossyCode[]): string | null {
    const u = str(url)
    if (!u) return null
    if (isAllowedLink(u)) return u
    lossy.push('link-dropped')
    return null
  }

  private custom(el: El, n: Node, lossy: LossyCode[], extra: Rec = {}, lastEditedBy?: string | null) {
    const meta = lobbyDataOf(n.s.meta, (ref) => (this.snap.shapes.has(ref) ? this.idOf(ref) : null), extra)
    lossy.push(...meta.lossy)
    const server = lobbyServerOf(this.opts.updatedAt, { privateNote: meta.privateNote, lastEditedBy })
    lossy.push(...server.lossy)
    const cd = customDataOf(meta.lobby, server.value)
    if (cd) el.customData = cd
  }

  /** A bound label for a box container (rectangle, ellipse, diamond). */
  private boxLabel(
    container: El,
    ctype: ContainerBox['type'],
    lines: string[],
    fam: LobbyFontFamily,
    size: number,
    align: 'left' | 'center' | 'right',
    valign: 'top' | 'middle' | 'bottom',
    ink: string,
  ): El {
    const original = lines.join('\n')
    const lh = lineHeightOf(fam)
    const text = wrapText(original, fam, size, boundTextMaxWidth(ctype, container.width as number, size))
    const dims = measureText(this.opts.metrics, text, fam, size, lh)
    const pos = boundTextPosition(
      {
        type: ctype,
        x: container.x as number,
        y: container.y as number,
        width: container.width as number,
        height: container.height as number,
        angle: container.angle as number,
      },
      { width: dims.width, height: dims.height, textAlign: align, verticalAlign: valign, fontSize: size },
    )
    const id = `${container.id as string}.t`
    return this.textEl(id, container, pos.x, pos.y, dims.width, dims.height, {
      text,
      originalText: original,
      fam,
      size,
      align,
      valign,
      ink,
      containerId: container.id as string,
      autoResize: true,
      baseFontSize: null,
      angle: container.angle as number,
    })
  }

  private textEl(
    id: string,
    like: El,
    x: number,
    y: number,
    w: number,
    h: number,
    t: {
      text: string
      originalText: string
      fam: LobbyFontFamily
      size: number
      align: 'left' | 'center' | 'right'
      valign: 'top' | 'middle' | 'bottom'
      ink: string
      containerId: string | null
      autoResize: boolean
      baseFontSize: number | null
      angle: number
      labelPosition?: number | null
    },
  ): El {
    return {
      id,
      type: 'text',
      x,
      y,
      width: w,
      height: h,
      angle: t.angle,
      strokeColor: t.ink,
      backgroundColor: 'transparent',
      fillStyle: 'solid',
      strokeWidth: 2,
      strokeStyle: 'solid',
      roughness: 0,
      opacity: like.opacity,
      groupIds: [...(like.groupIds as string[])],
      frameId: like.frameId,
      index: null,
      roundness: null,
      seed: hash31(id),
      version: 1,
      versionNonce: hash31(`${id}#nonce`),
      isDeleted: false,
      boundElements: null,
      updated: this.opts.updatedAt,
      created: null,
      link: null,
      locked: false,
      text: t.text,
      fontSize: t.size,
      baseFontSize: t.baseFontSize,
      fontFamily: t.fam,
      textAlign: t.align,
      verticalAlign: t.valign,
      containerId: t.containerId,
      originalText: t.originalText,
      autoResize: t.autoResize,
      lineHeight: lineHeightOf(t.fam),
      labelPosition: t.labelPosition ?? null,
    }
  }

  private placeholder(n: Node, m: Mat, id: string, w: number, h: number, lossy: LossyCode[]): ShapeOut {
    const el = this.common(id, 'rectangle', n, boxFor(m, w || 200, h || 100))
    Object.assign(el, { strokeColor: PLACEHOLDER_STROKE, strokeStyle: 'dashed' })
    this.custom(el, n, lossy, { kind: 'placeholder' })
    this.setBound(el, null, n.s.id)
    return { elements: [el], main: el, outline: 'rect', lossy, files: [] }
  }

  // ---- per shape type ----

  private shape(n: Node, m: Mat): ShapeOut | null {
    const s = n.s
    const p = isObj(s.props) ? s.props : {}
    const id = this.idOf(s.id)
    const lossy: LossyCode[] = []
    if (n.orphan) lossy.push('orphan')
    switch (s.type) {
      case 'group':
        return { elements: [], main: null, outline: 'rect', lossy, files: [] }
      case 'note':
        return this.note(n, m, p, id, lossy)
      case 'geo':
        return this.geo(n, m, p, id, lossy)
      case 'text':
        return this.text(n, m, p, id, lossy)
      case 'frame':
        return this.frame(n, m, p, id, lossy)
      case 'image':
        return this.image(n, m, p, id, lossy)
      case 'video':
      case 'dr-file-card':
        return this.fileCard(n, m, p, id, lossy)
      case 'embed':
      case 'bookmark':
        return this.linkCard(n, m, p, id, lossy)
      case 'draw':
      case 'highlight':
        return this.freedraw(n, m, p, id, lossy)
      case 'line':
        return this.line(n, m, p, id, lossy)
      case 'arrow':
        return this.arrow(n, m, p, id, lossy)
      default:
        lossy.push('unknown-shape')
        return this.placeholder(n, m, id, num(p.w, 200), num(p.h, 100), lossy)
    }
  }

  private note(n: Node, m: Mat, p: Rec, id: string, lossy: LossyCode[]): ShapeOut {
    const scale = num(p.scale, 1)
    const width = Math.max(NOTE_SIZE * scale, STICKY_NOTE_MIN_SIZE)
    const baseHeight = Math.max((NOTE_SIZE + num(p.growY, 0)) * scale, STICKY_NOTE_MIN_SIZE)
    const b = boxFor(m, width, baseHeight)
    const c = colorOf(p.color)
    const ink =
      p.labelColor === 'black' || p.labelColor === undefined ? c.noteText : colorOf(p.labelColor).fill
    const note = this.common(id, 'stickynote', n, b)
    Object.assign(note, { backgroundColor: c.noteFill, strokeColor: ink })
    note.baseHeight = baseHeight
    note.link = this.link(p.url, lossy)
    if (p.font === 'serif') lossy.push('serif-font')
    const fam = FONT_FAMILY[str(p.font)] ?? 6
    const baseFontSize = Math.min(512, Math.max(1, (LABEL[str(p.size)] ?? 22) * scale))
    const t = plainLines(p.richText)
    if (t.formatted) lossy.push('rich-text-formatting')
    if (t.link && !note.link) note.link = this.link(t.link, lossy)
    let label: El | null = null
    let originalText = t.lines.join('\n')
    if (originalText.length > MAX_ORIGINAL_TEXT_CHARS) {
      lossy.push('over-limit')
      originalText = originalText.slice(0, MAX_ORIGINAL_TEXT_CHARS)
    }
    if (hasText(t)) {
      label = this.textEl(`${id}.t`, note, b.x, b.y, 0, 0, {
        text: originalText,
        originalText,
        fam,
        size: baseFontSize,
        align: H_ALIGN[str(p.align)] ?? 'center',
        valign: V_ALIGN[str(p.verticalAlign)] ?? 'middle',
        ink,
        containerId: id,
        autoResize: true,
        baseFontSize,
        angle: b.angle,
      })
    }
    const lay = layoutStickyNote(note as unknown as StickyNoteElement, label as unknown as TextElement | null)
    Object.assign(note, lay.container)
    if (label && lay.text) Object.assign(label, lay.text)
    this.custom(note, n, lossy)
    if (label) {
      const server = lobbyServerOf(this.opts.updatedAt, { lastEditedBy: str(p.textLastEditedBy) || null })
      lossy.push(...server.lossy)
      if (server.value) label.customData = { lobbyServer: server.value }
    }
    this.setBound(note, label, n.s.id)
    return { elements: label ? [note, label] : [note], main: note, outline: 'rect', lossy, files: [] }
  }

  private styleFromTl(el: El, p: Rec, forLinear = false) {
    const dash = str(p.dash)
    if (dash === 'draw') el.roughness = forLinear ? 0 : 1
    else if (dash === 'dashed') el.strokeStyle = 'dashed'
    else if (dash === 'dotted') el.strokeStyle = 'dotted'
    const fill = str(p.fill)
    const c = colorOf(p.color)
    if (fill === 'semi') el.backgroundColor = TL_SOLID_BACKGROUND
    else if (fill === 'solid') el.backgroundColor = c.semi
    else if (fill === 'fill') el.backgroundColor = c.fill
    else if (fill === 'pattern') {
      el.backgroundColor = c.pattern
      el.fillStyle = 'hachure'
    } else if (fill === 'lined-fill') {
      el.backgroundColor = c.linedFill
      el.fillStyle = 'hachure'
    }
  }

  private geo(n: Node, m: Mat, p: Rec, id: string, lossy: LossyCode[]): ShapeOut {
    const w = num(p.w, 1)
    const h = num(p.h, 1) + num(p.growY, 0)
    const b = boxFor(m, w, h)
    const c = colorOf(p.color)
    const scale = num(p.scale, 1)
    const fam = FONT_FAMILY[str(p.font)] ?? 6
    const size = round2((LABEL[str(p.size)] ?? 22) * scale)
    const ink = colorOf(p.labelColor).solid
    const kind = str(p.geo, 'rectangle')
    const native = NATIVE_GEO[kind]
    const t = plainLines(p.richText)
    if (t.formatted) lossy.push('rich-text-formatting')
    if (p.font === 'serif' && hasText(t)) lossy.push('serif-font')
    const align = H_ALIGN[str(p.align)] ?? 'center'
    const valign = V_ALIGN[str(p.verticalAlign)] ?? 'middle'
    const lines = clipLines(t.lines, lossy)
    if (native) {
      const el = this.common(id, native, n, b)
      Object.assign(el, { strokeColor: c.solid, strokeWidth: (STROKE[str(p.size)] ?? 3.5) * scale })
      this.styleFromTl(el, p)
      el.link = this.link(p.url, lossy) ?? (t.link ? this.link(t.link, lossy) : null)
      if (native !== kind) lossy.push('geo-approximated')
      const label = hasText(t) ? this.boxLabel(el, native, lines, fam, size, align, valign, ink) : null
      this.custom(el, n, lossy)
      this.setBound(el, label, n.s.id)
      return {
        elements: label ? [el, label] : [el],
        main: el,
        outline: native === 'rectangle' ? 'rect' : native,
        lossy,
        files: [],
      }
    }
    // No Excalidraw type: a closed polygon line for the outline plus a transparent rectangle that holds the
    // label and the arrow bindings, grouped together (§5.1 "geo other kinds").
    lossy.push('geo-polygon')
    const gid = `${id}.g`
    const flipX = p.flipX === true
    const flipY = p.flipY === true
    const pts = polygonOf(kind, w, h).map(([x, y]) => apply(m, flipX ? w - x : x, flipY ? h - y : y))
    const polyNode = { ...n, groups: [gid, ...n.groups] }
    const poly = this.common(`${id}.o`, 'line', polyNode, { x: 0, y: 0, w: 0, h: 0, angle: 0 })
    Object.assign(poly, linearGeometry(pts), {
      strokeColor: c.solid,
      strokeWidth: (STROKE[str(p.size)] ?? 3.5) * scale,
      roundness: kind === 'cloud' || kind === 'heart' ? { type: 2 } : null,
      startBinding: null,
      endBinding: null,
      startArrowhead: null,
      endArrowhead: null,
      polygon: true,
    })
    this.styleFromTl(poly, p)
    const holder = this.common(id, 'rectangle', polyNode, b)
    Object.assign(holder, { strokeColor: 'transparent' })
    holder.link = this.link(p.url, lossy) ?? (t.link ? this.link(t.link, lossy) : null)
    const label = hasText(t) ? this.boxLabel(holder, 'rectangle', lines, fam, size, align, valign, ink) : null
    this.custom(holder, n, lossy)
    this.setBound(holder, label, n.s.id)
    return {
      elements: label ? [poly, holder, label] : [poly, holder],
      main: holder,
      outline: 'rect',
      lossy,
      files: [],
    }
  }

  private text(n: Node, m: Mat, p: Rec, id: string, lossy: LossyCode[]): ShapeOut {
    const scale = num(p.scale, 1)
    const fam = FONT_FAMILY[str(p.font)] ?? 6
    const size = round2((FONT[str(p.size)] ?? 24) * scale)
    const t = plainLines(p.richText)
    if (t.formatted) lossy.push('rich-text-formatting')
    if (p.font === 'serif') lossy.push('serif-font')
    const lines = clipLines(t.lines, lossy)
    const original = lines.join('\n')
    const autoResize = p.autoSize !== false
    const lh = lineHeightOf(fam)
    const boxW = num(p.w, 1) * scale
    const text = autoResize ? original : wrapText(original, fam, size, boxW)
    const dims = measureText(this.opts.metrics, text, fam, size, lh)
    const width = autoResize ? dims.width : boxW
    const b = boxFor(m, width, dims.height)
    const like = this.common(id, 'text', n, b)
    const el = this.textEl(id, like, b.x, b.y, width, dims.height, {
      text,
      originalText: original,
      fam,
      size,
      align: H_ALIGN[str(p.textAlign)] ?? 'left',
      valign: 'top',
      ink: colorOf(p.color).solid,
      containerId: null,
      autoResize,
      baseFontSize: null,
      angle: b.angle,
    })
    el.groupIds = [...n.groups]
    el.frameId = n.frame
    el.locked = n.s.isLocked === true
    el.link = t.link ? this.link(t.link, lossy) : null
    this.custom(el, n, lossy)
    this.setBound(el, null, n.s.id)
    return { elements: [el], main: el, outline: 'rect', lossy, files: [] }
  }

  private frame(n: Node, m: Mat, p: Rec, id: string, lossy: LossyCode[]): ShapeOut {
    const b = boxFor(m, num(p.w, 1), num(p.h, 1))
    if (b.angle) lossy.push('frame-rotation')
    if (n.frame) lossy.push('nested-frame')
    const el = this.common(id, 'frame', { ...n, frame: null, groups: [] }, { ...b, angle: 0 })
    if (n.groups.length) lossy.push('group-with-frame')
    let name = str(p.name)
    if (name.length > MAX_FRAME_NAME_CHARS) {
      lossy.push('over-limit')
      name = name.slice(0, MAX_FRAME_NAME_CHARS)
    }
    Object.assign(el, { strokeColor: '#bbb', name: name || null })
    this.custom(el, n, lossy)
    this.setBound(el, null, n.s.id)
    return { elements: [el], main: el, outline: 'rect', lossy, files: [] }
  }

  private image(n: Node, m: Mat, p: Rec, id: string, lossy: LossyCode[]): ShapeOut {
    const w = num(p.w, 1)
    const h = num(p.h, 1)
    const asset = typeof p.assetId === 'string' ? this.snap.assets.get(p.assetId) : undefined
    const ap = isObj(asset?.props) ? asset.props : {}
    const ref = stableRef(ap.src)
    if (!ref) {
      lossy.push('missing-asset')
      return this.placeholder(n, m, id, w, h, lossy)
    }
    const am = isObj(asset?.meta) ? asset.meta : {}
    const pdfPage =
      Number.isInteger(am.drPdfPage) && (am.drPdfPage as number) >= 1 ? (am.drPdfPage as number) : null
    const fileId = pdfPage ? `${ref.versionId}.p${pdfPage}` : ref.versionId
    if (!FILE_ID_PATTERN.test(fileId)) {
      lossy.push('missing-asset')
      return this.placeholder(n, m, id, w, h, lossy)
    }
    const b = boxFor(m, w, h)
    const el = this.common(id, 'image', n, b)
    const nw = num(ap.w, 0)
    const nh = num(ap.h, 0)
    const crop = isObj(p.crop) ? p.crop : null
    const tl = crop && isObj(crop.topLeft) ? crop.topLeft : null
    const br = crop && isObj(crop.bottomRight) ? crop.bottomRight : null
    if (crop?.isCircle === true) lossy.push('image-circle-crop')
    Object.assign(el, {
      strokeColor: 'transparent',
      status: 'saved',
      fileId,
      scale: [p.flipX === true ? -1 : 1, p.flipY === true ? -1 : 1],
      crop:
        tl && br && nw > 0 && nh > 0
          ? {
              x: round2(num(tl.x, 0) * nw),
              y: round2(num(tl.y, 0) * nh),
              width: round2((num(br.x, 1) - num(tl.x, 0)) * nw),
              height: round2((num(br.y, 1) - num(tl.y, 0)) * nh),
              naturalWidth: nw,
              naturalHeight: nh,
            }
          : null,
    })
    el.link = this.link(p.url, lossy)
    const alt = str(p.altText)
    this.custom(el, n, lossy, { ...(pdfPage ? { pdfPage } : {}), ...(alt ? { alt } : {}) })
    this.setBound(el, null, n.s.id)
    return { elements: [el], main: el, outline: 'rect', lossy, files: [{ fileId, ...ref }] }
  }

  /** `dr-file-card` and `video` → `image` + `customData.lobby.file` (D7). */
  private fileCard(n: Node, m: Mat, p: Rec, id: string, lossy: LossyCode[]): ShapeOut {
    const w = num(p.w, 1)
    const h = num(p.h, 1)
    let file: Rec | null = null
    if (n.s.type === 'dr-file-card') {
      file = {
        assetId: p.assetId,
        versionId: p.versionId,
        kind: p.kind,
        name: str(p.name).slice(0, 200),
        mimeType: p.mimeType,
        sizeBytes: p.sizeBytes,
      }
      if (str(p.name).length > 200) lossy.push('over-limit')
    } else {
      const asset = typeof p.assetId === 'string' ? this.snap.assets.get(p.assetId) : undefined
      const ap = isObj(asset?.props) ? asset.props : {}
      const ref = stableRef(ap.src)
      if (ref)
        file = {
          ...ref,
          kind: 'video',
          name: str(ap.name).slice(0, 200),
          mimeType: str(ap.mimeType, 'video/mp4') || 'video/mp4',
          sizeBytes: Number.isInteger(ap.fileSize) && (ap.fileSize as number) >= 0 ? ap.fileSize : 0,
        }
    }
    const versionId = str(file?.versionId)
    if (!file || !FILE_ID_PATTERN.test(versionId) || !/^ast_[0-9A-Za-z]{10,40}$/.test(str(file.assetId))) {
      lossy.push('missing-asset')
      return this.placeholder(n, m, id, w, h, lossy)
    }
    const b = boxFor(m, w, h)
    const el = this.common(id, 'image', n, b)
    Object.assign(el, {
      strokeColor: 'transparent',
      status: 'saved',
      fileId: versionId,
      scale: [1, 1],
      crop: null,
    })
    const alt = str(p.altText)
    this.custom(el, n, lossy, { file, ...(alt ? { alt } : {}) })
    const lobby = (el.customData as Rec | undefined)?.lobby as Rec | undefined
    if (!lobby?.file) {
      // the registry refused the file facts (a bad kind or mime type): the card cannot stand
      lossy.push('missing-asset')
      return this.placeholder(
        n,
        m,
        id,
        w,
        h,
        lossy.filter((c) => c !== 'meta-dropped'),
      )
    }
    this.setBound(el, null, n.s.id)
    return {
      elements: [el],
      main: el,
      outline: 'rect',
      lossy,
      files: [{ fileId: versionId, versionId, assetId: str(file.assetId) }],
    }
  }

  /** `embed` and `bookmark` → a link card: a rectangle with the link and a label (§5.1). */
  private linkCard(n: Node, m: Mat, p: Rec, id: string, lossy: LossyCode[]): ShapeOut {
    const w = num(p.w, 300)
    const h = num(p.h, 200)
    const url = str(p.url)
    if (!url || !isAllowedLink(url) || /^\//.test(url)) {
      lossy.push('missing-asset')
      return this.placeholder(n, m, id, w, h, lossy)
    }
    lossy.push(n.s.type === 'embed' ? 'embed-as-link' : 'bookmark-as-link')
    const b = boxFor(m, w, h)
    const el = this.common(id, 'rectangle', n, b)
    Object.assign(el, {
      strokeColor: PLACEHOLDER_STROKE,
      backgroundColor: '#ffffff',
      roundness: { type: 3 },
      link: url,
    })
    let title = url
    if (n.s.type === 'bookmark' && typeof p.assetId === 'string') {
      const ap = this.snap.assets.get(p.assetId)?.props
      if (isObj(ap) && typeof ap.title === 'string' && ap.title.trim()) title = ap.title
    }
    const label = this.boxLabel(el, 'rectangle', clipLines([title], lossy), 6, 16, 'left', 'top', LOBBY_INK)
    this.custom(el, n, lossy, { kind: 'link-card' })
    this.setBound(el, label, n.s.id)
    return { elements: [el, label], main: el, outline: 'rect', lossy, files: [] }
  }

  private freedraw(n: Node, m: Mat, p: Rec, id: string, lossy: LossyCode[]): ShapeOut | null {
    const scale = num(p.scale, 1)
    const sx = num(p.scaleX, 1) * scale
    const sy = num(p.scaleY, 1) * scale
    const pts: Pt[] = []
    const pressures: number[] = []
    for (const seg of Array.isArray(p.segments) ? p.segments : []) {
      if (!isObj(seg) || typeof seg.path !== 'string') continue
      let dec: { x: number; y: number; z?: number }[] = []
      try {
        dec = b64Vecs.decodePoints(seg.path, seg.dim === 2 ? 2 : 3)
      } catch {
        dec = []
      }
      for (const q of dec) {
        pts.push(apply(m, q.x * sx, q.y * sy))
        pressures.push(Math.min(1, Math.max(0, num(q.z, 0.5))))
      }
    }
    if (pts.length === 0) {
      lossy.push('unknown-shape')
      return this.placeholder(n, m, id, 50, 50, lossy)
    }
    const isPen = p.isPen === true
    let keep = pts.map((q, i) => ({ ...q, z: pressures[i] ?? 0.5 }))
    if (keep.length > MAX_FREEDRAW_POINTS) {
      lossy.push('stroke-simplified')
      const simplified = new Set(simplifyRdp(keep, FREEDRAW_SIMPLIFY_EPSILON_PX))
      keep = keep.filter((q) => simplified.has(q))
    }
    const parts: (typeof keep)[] = []
    for (let i = 0; i < keep.length; i += MAX_FREEDRAW_POINTS - 1) {
      parts.push(keep.slice(i, i + MAX_FREEDRAW_POINTS))
      if (i + MAX_FREEDRAW_POINTS >= keep.length) break
    }
    const c = colorOf(p.color)
    const split = parts.length > 1
    const partNode = split ? { ...n, groups: [`${id}.g`, ...n.groups] } : n
    const elements = parts.map((part, i) => {
      const pid = i === 0 ? id : `${id}${STROKE_PART_SUFFIX}${i + 1}`
      const el = this.common(pid, 'freedraw', partNode, { x: 0, y: 0, w: 0, h: 0, angle: 0 })
      const geom = linearGeometry(part)
      Object.assign(el, geom, {
        pressures: isPen ? part.map((q) => round2(q.z)) : [],
        simulatePressure: !isPen,
        strokeOptions: { variability: 'variable', streamline: 0.5 },
      })
      if (n.s.type === 'highlight') {
        Object.assign(el, {
          strokeColor: c.highlightSrgb,
          strokeWidth: (HIGHLIGHT[str(p.size)] ?? 9) * scale,
          opacity: 50,
        })
        this.custom(el, n, lossy, { kind: 'highlight' })
      } else {
        Object.assign(el, { strokeColor: c.solid, strokeWidth: (FREEDRAW[str(p.size)] ?? 2) * scale })
        if (p.isClosed === true && p.fill !== 'none') this.styleFromTl(el, { fill: p.fill, color: p.color })
        this.custom(el, n, lossy)
      }
      this.setBound(el, null, n.s.id)
      return el
    })
    return { elements, main: null, outline: 'rect', lossy, files: [] }
  }

  private line(n: Node, m: Mat, p: Rec, id: string, lossy: LossyCode[]): ShapeOut | null {
    const scale = num(p.scale, 1)
    const list = (isObj(p.points) ? Object.values(p.points) : [])
      .filter(isObj)
      .sort((a, b) =>
        str(a.index) < str(b.index) ? -1 : str(a.index) > str(b.index) ? 1 : str(a.id) < str(b.id) ? -1 : 1,
      )
    if (list.length < 2) {
      lossy.push('unknown-shape')
      return this.placeholder(n, m, id, 50, 50, lossy)
    }
    let pts: Pt[] = list.map((q) => apply(m, num(q.x, 0) * scale, num(q.y, 0) * scale))
    if (pts.length > MAX_LINEAR_POINTS) {
      lossy.push('stroke-simplified')
      pts = simplifyRdp(pts, FREEDRAW_SIMPLIFY_EPSILON_PX).slice(0, MAX_LINEAR_POINTS)
    }
    const el = this.common(id, 'line', n, { x: 0, y: 0, w: 0, h: 0, angle: 0 })
    const c = colorOf(p.color)
    Object.assign(el, linearGeometry(pts), {
      strokeColor: c.solid,
      strokeWidth: (STROKE[str(p.size)] ?? 3.5) * scale,
      startBinding: null,
      endBinding: null,
      startArrowhead: null,
      endArrowhead: null,
      polygon: false,
      roundness: p.spline === 'cubic' ? { type: 2 } : null,
    })
    this.styleFromTl(el, { dash: p.dash })
    this.custom(el, n, lossy)
    this.setBound(el, null, n.s.id)
    return { elements: [el], main: null, outline: 'rect', lossy, files: [] }
  }

  private target(shapeId: string): (TargetShape & { id: string }) | null {
    const out = this.convert(shapeId)
    const el = out?.main
    if (!el) return null
    const w = el.width as number
    const h = el.height as number
    const x = el.x as number
    const y = el.y as number
    return {
      id: el.id as string,
      x,
      y,
      w,
      h,
      angle: el.angle as number,
      cx: x + w / 2,
      cy: y + h / 2,
      outline: out.outline,
      strokeWidth: el.strokeWidth as number,
    }
  }

  private arrow(n: Node, m: Mat, p: Rec, id: string, lossy: LossyCode[]): ShapeOut {
    const scale = num(p.scale, 1)
    const elbow = p.kind === 'elbow'
    const term = (t: 'start' | 'end') => {
      const free = isObj(p[t]) ? (p[t] as Rec) : {}
      const freePt = apply(m, num(free.x, 0), num(free.y, 0))
      const all = (this.snap.bindingsByArrow.get(n.s.id) ?? []).filter(
        (b) => (isObj(b.props) ? b.props.terminal : null) === t,
      )
      const b = this.chosenBinding(n.s.id, t)
      if (all.length && !b) lossy.push('arrow-binding-dropped')
      const tg = b ? this.target(str(b.toId)) : null
      if (!b || !tg) {
        if (b) lossy.push('arrow-binding-dropped')
        return { pt: freePt, focus: freePt, tg: null, binding: null }
      }
      const bp = isObj(b.props) ? b.props : {}
      const anchor = isObj(bp.normalizedAnchor) ? bp.normalizedAnchor : {}
      const exact = bp.isExact === true
      const precise = bp.isPrecise === true || exact || elbow
      const fixedPoint = normalizeFixedPoint(precise ? [num(anchor.x, 0.5), num(anchor.y, 0.5)] : [0.5, 0.5])
      const mode = exact ? 'inside' : 'orbit'
      const focus = fixedPointOnTarget(tg, fixedPoint)
      return { pt: focus, focus, tg, binding: { elementId: tg.id, fixedPoint, mode } }
    }
    const a = term('start')
    const z = term('end')
    const bend = num(p.bend, 0)
    const straightish = Math.abs(bend) < 8 * scale
    const mid = straightish || elbow ? null : bendMid(a.focus, z.focus, bend)
    const clip = (t: typeof a, toward: Pt) =>
      t.tg && t.binding?.mode === 'orbit' ? orbitPoint(t.tg, t.focus, toward) : t.focus
    const start = clip(a, mid ?? z.focus)
    const end = clip(z, mid ?? a.focus)
    let pts: Pt[] = mid ? [start, mid, end] : [start, end]
    if (elbow) {
      const f = Math.min(1, Math.max(0, num(p.elbowMidPoint, 0.5)))
      const mx = start.x + (end.x - start.x) * f
      pts = [start, { x: mx, y: start.y }, { x: mx, y: end.y }, end]
    }
    const c = colorOf(p.color)
    const el = this.common(id, 'arrow', n, { x: 0, y: 0, w: 0, h: 0, angle: 0 })
    const sh = ARROWHEAD[str(p.arrowheadStart)]
    const eh = ARROWHEAD[str(p.arrowheadEnd)]
    for (const v of [p.arrowheadStart, p.arrowheadEnd])
      if (v === 'square' || v === 'inverted') lossy.push('arrowhead-approximated')
    Object.assign(el, linearGeometry(pts), {
      strokeColor: c.solid,
      strokeWidth: (STROKE[str(p.size)] ?? 3.5) * scale,
      roundness: mid ? { type: 2 } : null,
      startBinding: a.binding,
      endBinding: z.binding,
      startArrowhead: sh === undefined ? null : sh,
      endArrowhead: eh === undefined ? 'arrow' : eh,
      elbowed: elbow,
    })
    if (elbow) Object.assign(el, { fixedSegments: null, startIsSpecial: false, endIsSpecial: false })
    this.styleFromTl(el, { dash: p.dash }, true)
    const out: El[] = [el]
    const t = plainLines(p.richText)
    let label: El | null = null
    if (hasText(t)) {
      if (t.formatted) lossy.push('rich-text-formatting')
      const fam = FONT_FAMILY[str(p.font)] ?? 6
      const size = round2((ARROW_LABEL[str(p.size)] ?? 20) * scale)
      const original = clipLines(t.lines, lossy).join('\n')
      const text = wrapText(original, fam, size, boundTextMaxWidth('arrow', el.width as number, size))
      const dims = measureText(this.opts.metrics, text, fam, size, lineHeightOf(fam))
      const lp = num(p.labelPosition, 0.5)
      const keepPosition = Math.abs(lp - 0.5) > 0.01
      const center = keepPosition ? pointAlong(pts, lp) : labelCenter(pts)
      label = this.textEl(
        `${id}.t`,
        el,
        center.x - dims.width / 2,
        center.y - dims.height / 2,
        dims.width,
        dims.height,
        {
          text,
          originalText: original,
          fam,
          size,
          align: 'center',
          valign: 'middle',
          ink: colorOf(p.labelColor).solid,
          containerId: id,
          autoResize: true,
          baseFontSize: null,
          angle: 0,
          labelPosition: keepPosition ? Math.min(1, Math.max(0, lp)) : null,
        },
      )
      out.push(label)
    }
    this.custom(el, n, lossy)
    el.boundElements = label ? [{ id: label.id, type: 'text' }] : null
    return { elements: out, main: null, outline: 'rect', lossy, files: [] }
  }
}

// ---- small helpers -------------------------------------------------------------------------------------

const boxFor = (
  m: Mat,
  w: number,
  h: number,
): { x: number; y: number; w: number; h: number; angle: number } => {
  const b: Box = boxOf(m, w, h)
  return { x: b.x, y: b.y, w: b.w, h: b.h, angle: b.angle }
}

/** Lines within the originalText cap (over-limit reported). */
function clipLines(lines: readonly string[], lossy: LossyCode[]): string[] {
  const joined = lines.join('\n')
  if (joined.length <= MAX_ORIGINAL_TEXT_CHARS) return [...lines]
  lossy.push('over-limit')
  return joined.slice(0, MAX_ORIGINAL_TEXT_CHARS).split('\n')
}

/** `getBoundTextElementCenter`: the middle point for an odd point count, else the middle segment's midpoint. */
function labelCenter(pts: readonly Pt[]): Pt {
  if (pts.length % 2 === 1) return pts[Math.floor(pts.length / 2)] as Pt
  const i = pts.length / 2 - 1
  const p0 = pts[i] as Pt
  const p1 = pts[i + 1] as Pt
  return { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 }
}

/** The point at `t` of the polyline's length (curves approximated by their control polyline). */
function pointAlong(pts: readonly Pt[], t: number): Pt {
  const lens = pts.slice(1).map((q, i) => Math.hypot(q.x - (pts[i] as Pt).x, q.y - (pts[i] as Pt).y))
  const total = lens.reduce((s, l) => s + l, 0)
  let target = Math.min(1, Math.max(0, t)) * total
  for (let i = 0; i < lens.length; i++) {
    const l = lens[i] as number
    if (target <= l || i === lens.length - 1) {
      const f = l ? target / l : 0
      const a = pts[i] as Pt
      const b = pts[i + 1] as Pt
      return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }
    }
    target -= l
  }
  return pts[0] as Pt
}

const STABLE = /^\/files\/(ast_[0-9A-Za-z]{10,40})\/(ver_[0-9A-Za-z]{10,40})\/original$/
function stableRef(src: unknown): { assetId: string; versionId: string } | null {
  const m = typeof src === 'string' ? STABLE.exec(src) : null
  return m?.[1] && m[2] ? { assetId: m[1], versionId: m[2] } : null
}

/** Shapes an arrow may bind to after conversion (their main element is bindable, §3.1). */
export function isBindableShape(s: TlRecord | undefined): boolean {
  if (!s) return false
  return !['arrow', 'draw', 'highlight', 'line', 'group'].includes(String(s.type))
}

// ---- the board document -------------------------------------------------------------------------------------

export interface DocValues {
  startView?: { x: number; y: number; w: number; h: number; frameId?: string }
  workshop?: { hideNoteAuthors: boolean; hideCursors: boolean }
  /** `tagDef:<key>` → {name, color} */
  tagDefs: Record<string, { name: string; color: string }>
}

function docValues(
  snap: Snapshot,
  pages: LegacyPages,
  lossy: Lossy[],
  idOf: (id: string) => string,
): DocValues {
  const meta = isObj(snap.document?.meta) ? (snap.document?.meta as Rec) : {}
  const out: DocValues = { tagDefs: {} }
  const docId = snap.document?.id ?? 'document:document'
  const sv = isObj(meta.drStartView) ? meta.drStartView : null
  if (sv) {
    const off = pages[str(sv.pageId)] ?? { dx: 0, dy: 0 }
    const w = num(sv.w, 0)
    const h = num(sv.h, 0)
    if (w > 0 && h > 0) {
      out.startView = { x: num(sv.x, 0) + off.dx, y: num(sv.y, 0) + off.dy, w, h }
      if (typeof sv.frameId === 'string' && snap.shapes.has(sv.frameId))
        out.startView.frameId = idOf(sv.frameId)
    } else lossy.push({ code: 'meta-dropped', id: docId })
  }
  const ws = isObj(meta.drWorkshop) ? meta.drWorkshop : null
  if (ws)
    out.workshop = { hideNoteAuthors: ws.hideNoteAuthors === true, hideCursors: ws.hideCursors === true }
  for (const [k, v] of Object.entries(meta).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!k.startsWith('drTagList:')) continue
    if (isObj(v) && typeof v.name === 'string' && typeof v.color === 'string')
      out.tagDefs[k.slice('drTagList:'.length)] = { name: v.name, color: v.color }
    else lossy.push({ code: 'meta-dropped', id: docId })
  }
  return out
}

// ---- entry points ---------------------------------------------------------------------------------------------

export interface ConvertResult {
  /** in paint order, with fractional indices (labels right after their containers) */
  readonly elements: WireElement[]
  readonly lossy: Lossy[]
  /** tldraw shape id → the element ids it became (a group becomes no element) */
  readonly mapping: Record<string, string[]>
  readonly files: FileRef[]
  readonly doc: DocValues
  readonly legacyPages: LegacyPages
  /** tldraw ids the converter had to change (§3.4 `legacyIds`) */
  readonly legacyIds: Record<string, string>
  readonly failures: ConvertFailure[]
  readonly counts: { readonly records: number; readonly shapes: number; readonly elements: number }
}

/** Paint order: pages in order, children by (index, id), depth first; orphans at the end of the first page. */
function paintOrder(snap: Snapshot): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const visit = (s: TlRecord, depth: number) => {
    if (seen.has(s.id) || depth > MAX_DEPTH) return
    seen.add(s.id)
    out.push(s.id)
    for (const k of snap.children.get(s.id) ?? []) visit(k, depth + 1)
  }
  snap.pageOrder.forEach((pageId, i) => {
    for (const s of snap.children.get(pageId) ?? []) visit(s, 0)
    if (i === 0) {
      const orphans = [...snap.shapes.values()]
        .filter(
          (s) => !seen.has(s.id) && !snap.pages.has(str(s.parentId)) && !snap.shapes.has(str(s.parentId)),
        )
        .sort(byIndex)
      for (const s of orphans) visit(s, 0)
    }
  })
  // cycles and anything unreachable (a parent chain that loops): after everything else, by id
  for (const s of [...snap.shapes.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) visit(s, 0)
  return out
}

function finish(el: El, failures: ConvertFailure[]): WireElement | null {
  const check = checkElement(el)
  if (check.ok) return check.element
  failures.push({ id: String(el.id), code: check.code, detail: check.detail })
  return null
}

/** The whole-board conversion (§5.3): every shape, frozen or computed page offsets, fresh indices in paint order. */
export function convertBoard(records: readonly TlRecord[], opts: ConvertOptions): ConvertResult {
  const snap = indexSnapshot(records)
  const legacyPages = opts.legacyPages ?? computeLegacyPages(snap, opts.pageGap)
  const core = new Core(snap, opts, legacyPages)
  const lossy: Lossy[] = []
  const mapping: Record<string, string[]> = {}
  const files = new Map<string, FileRef>()
  const ordered: El[] = []
  const emitted = new Set<string>()
  for (const id of paintOrder(snap)) {
    const out = core.convert(id)
    if (!out) continue
    mapping[id] = out.elements.map((e) => e.id as string)
    for (const code of new Set(out.lossy)) lossy.push({ code, id })
    for (const f of out.files) files.set(f.fileId, f)
    for (const e of out.elements) {
      if (emitted.has(e.id as string)) continue
      emitted.add(e.id as string)
      ordered.push(e)
    }
  }
  snap.pageOrder.forEach((pageId, i) => {
    if (i > 0 && (snap.children.get(pageId)?.length ?? 0) > 0)
      lossy.push({ code: 'page-flattened', id: pageId })
  })
  // a group becomes the group id its descendants carry; one that no element carries is reported
  const carried = new Set(ordered.flatMap((e) => e.groupIds as string[]))
  for (const s of snap.shapes.values())
    if (s.type === 'group' && mapping[s.id] && !carried.has(core.idOf(s.id)))
      lossy.push({ code: 'empty-group', id: s.id })
  const keys = indexKeysBetween(null, null, ordered.length)
  const elements: WireElement[] = []
  ordered.forEach((e, i) => {
    e.index = keys[i]
    const w = finish(e, core.failures)
    if (w) elements.push(w)
  })
  const doc = docValues(snap, legacyPages, lossy, (id) => core.idOf(id))
  return {
    elements,
    lossy: sortLossy(lossy),
    mapping,
    files: [...files.values()].sort((a, b) => (a.fileId < b.fileId ? -1 : 1)),
    doc,
    legacyPages,
    legacyIds: core.legacyIds,
    failures: core.failures,
    counts: { records: snap.recordCount, shapes: snap.shapes.size, elements: elements.length },
  }
}

export interface LocalResult {
  /** tldraw shape id → its elements (no index), for every requested shape that exists */
  readonly elements: ReadonlyMap<string, WireElement[]>
  readonly lossy: Lossy[]
  readonly files: FileRef[]
  readonly failures: ConvertFailure[]
  readonly legacyIds: Record<string, string>
}

/**
 * Local mode (§5.1): converts only `ids` within the snapshot `records`, with the frozen `legacyPages`,
 * and assigns no index. A shape on a page without a frozen offset fails with `PAGE_MISSING` (the
 * roll-forward appends the page's offset first, §5.9 b).
 */
export function convertRecords(
  records: readonly TlRecord[] | Snapshot,
  ids: Iterable<string>,
  opts: ConvertOptions & { readonly legacyPages: LegacyPages },
): LocalResult {
  const snap = isSnapshot(records) ? records : indexSnapshot(records)
  const core = new Core(snap, opts, opts.legacyPages)
  const out = new Map<string, WireElement[]>()
  const lossy: Lossy[] = []
  const files = new Map<string, FileRef>()
  for (const id of [...new Set(ids)].sort()) {
    const res = core.convert(id)
    if (!res) continue
    const els: WireElement[] = []
    for (const e of res.elements) {
      const w = finish({ ...e, index: null }, core.failures)
      if (w) els.push(w)
    }
    out.set(id, els)
    for (const code of new Set(res.lossy)) lossy.push({ code, id })
    for (const f of res.files) files.set(f.fileId, f)
  }
  return {
    elements: out,
    lossy: sortLossy(lossy),
    files: [...files.values()],
    failures: core.failures,
    legacyIds: core.legacyIds,
  }
}

const isSnapshot = (v: readonly TlRecord[] | Snapshot): v is Snapshot =>
  !Array.isArray(v) && (v as Snapshot).shapes instanceof Map

const sortLossy = (list: Lossy[]) =>
  list.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

/** Lossy counts by code (`lb_doc.import.lossy`, the B8 report). */
export function lossyCounts(lossy: readonly Lossy[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const l of lossy) out[l.code] = (out[l.code] ?? 0) + 1
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)))
}

// re-exported for the roll-forward (page offsets of pages created during a rollback)
export { angleOf, rotateAbout }
