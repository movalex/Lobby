// The engine-neutral template builder. Template content (./templates/*.ts) is written once against this
// builder and becomes a `BoardPlan`: frames, texts, notes, boxes and arrows with their page-space geometry,
// in creation order. Two emitters turn a plan into a board:
//   - ./tldraw.ts: tldraw 5.4.2 shape + binding records (the default build, until wave 4);
//   - ./scene/emit.ts: Excalidraw elements built through @draftroom/canvas-schema/engine (the new canvas).
// Style values are Lobby's names (the 13 colour names, the four sizes, tldraw's font and fill names): both
// emitters map them, and the converter (packages/tldraw-import) maps stored boards the same way.
//
// No tldraw and no Excalidraw import here, so the dashboard's template gallery can read a plan with neither
// engine in its bundle (./plan.ts, apps/web/src/dashboard/template-catalog.ts).

import { NOTE_SIZE, type Rect, type TemplatePoint } from './common.ts'

/** Inner padding of a section frame. */
export const PAD = 40
/** Gap between neighbouring sticky notes. */
export const NOTE_GAP = 20

/** Lobby's colour names: the note palette's 13 (tldraw's colour-style names, kept by the converter). */
export type LobbyColor =
  | 'black'
  | 'grey'
  | 'light-violet'
  | 'violet'
  | 'blue'
  | 'light-blue'
  | 'yellow'
  | 'orange'
  | 'green'
  | 'light-green'
  | 'light-red'
  | 'red'
  | 'white'
export type LobbySize = 's' | 'm' | 'l' | 'xl'
/**
 * tldraw's font names, plus 'display': the new canvas has Excalifont ('draw'), Nunito ('sans', 'serif'),
 * Comic Shanns ('mono') and Lilita One ('display', fontFamily 7: its headings, decision D3). tldraw has no
 * display face, so it sets 'display' in sans.
 */
export type LobbyFont = 'draw' | 'sans' | 'serif' | 'mono' | 'display'
export type LobbyTextAlign = 'start' | 'middle' | 'end'
/** 'solid' is a pale tint (tldraw's name), 'fill' the full colour, 'semi' the near-white card fill. */
export type LobbyFill = 'none' | 'semi' | 'solid' | 'fill'
export type LobbyDash = 'solid' | 'dashed' | 'dotted' | 'draw'
export type LobbyGeo = 'rectangle' | 'ellipse' | 'diamond'
export type LobbyArrowhead = 'arrow' | 'none'

/**
 * Meta marker on template image slots. The web app's file drop fits an image dropped onto a marked
 * slot into it (apps/web/src/board/ExternalContent.tsx); older boards have no marker. On the new canvas
 * it is `customData.lobby.slot = 'image'` (canvas-schema custom-data.ts, the converter's mapping).
 */
export const IMAGE_SLOT_META = { draftroomSlot: 'image' } as const

/**
 * Meta marker on colour swatches: a full-colour block with no label (its name is a text shape next
 * to it, because tldraw has no label colour that reads on every full fill in both themes). The
 * template tests allow a geo shape without text only when it carries this marker. On the new canvas it
 * is `customData.lobby.swatch = 'color'`.
 */
export const SWATCH_META = { draftroomSwatch: 'color' } as const

export interface TextSpec {
  x: number
  y: number
  w: number
  text: string
  size?: LobbySize
  color?: LobbyColor
  align?: LobbyTextAlign
  /** tldraw's font style (default sans); the Lobby tour's type samples use serif and mono too. */
  font?: LobbyFont
  /** Headings and instructions arrive locked (PRE-07); starter values people fill in do not. */
  locked?: boolean
  /**
   * A heading (a section's or frame's title, a column's or a group's name). The new canvas has no bold
   * (decision D3), so it sets headings in its display face (Lilita One) unless `scene.font` says otherwise;
   * tldraw keeps `font`. Size and colour carry the rest of the hierarchy on both.
   */
  heading?: boolean
  /**
   * What the new canvas shows instead, where the words name something only one engine has (the tour's
   * type samples name their faces). `displayText`: the words when the display face is available (it needs
   * the server's font allowlist to accept fontFamily 7); `text` otherwise, so a label never names a face the
   * canvas is not showing.
   */
  scene?: { text?: string; font?: LobbyFont; displayText?: string }
}

export interface NoteSpec {
  x: number
  y: number
  text: string
  color: LobbyColor
  size?: LobbySize
  scale?: number
}

export interface GeoSpec {
  x: number
  y: number
  w: number
  h: number
  text?: string
  geo?: LobbyGeo
  color?: LobbyColor
  labelColor?: LobbyColor
  fill?: LobbyFill
  dash?: LobbyDash
  size?: LobbySize
  locked?: boolean
  meta?: Readonly<Record<string, string>>
  /**
   * The first line is a title (a card's name, a key). tldraw sets it in bold; the new canvas has plain
   * text only (docs/EXCALIDRAW-MIGRATION.md §1 non-goals), so there it is the plain first line.
   */
  titled?: boolean
  /**
   * The whole label is a title (a theme, a column header, a shortcut key over what it does): the new canvas
   * sets it in its display face (Lilita One, decision D3), because one label holds one face. tldraw is
   * unchanged (`titled` gives it a bold first line).
   */
  heading?: boolean
  /** The new canvas's own words, where a label names something only one page has (a key binding). */
  scene?: { text?: string }
}

export interface ArrowSpec {
  /** Normalized anchor on the start shape; omitted = shape centre (non-precise binding). */
  startAnchor?: { x: number; y: number }
  /** Normalized anchor on the end shape; omitted = shape centre (non-precise binding). */
  endAnchor?: { x: number; y: number }
  color?: LobbyColor
  size?: LobbySize
  dash?: LobbyDash
  arrowheadEnd?: LobbyArrowhead
  /** Routed with right angles (tldraw arrow kind 'elbow', Excalidraw `elbowed`). */
  elbow?: boolean
}

export interface SectionSpec {
  x: number
  y: number
  w: number
  h: number
  name: string
  heading: string
  intro?: string
  headingSize?: LobbySize
}

type Outline = 'rect' | 'ellipse'

interface NodeBase {
  /** Creation order (0-based): the paint order of siblings on both engines. */
  readonly seq: number
  /** The frame this node sits in, or null for the page. */
  readonly parent: PlanFrame | null
  /** Position in the parent's space (as given; a frame's is relative to the template origin's page). */
  readonly x: number
  readonly y: number
  /** Page-space bounds (text: a nominal one-line box; the engines measure the real height). */
  readonly page: Rect
  readonly outline: Outline
}

export interface PlanFrame extends NodeBase {
  readonly kind: 'frame'
  readonly w: number
  readonly h: number
  readonly name: string
}

export interface PlanText extends NodeBase {
  readonly kind: 'text'
  readonly w: number
  readonly text: string
  readonly size: LobbySize
  readonly color: LobbyColor
  readonly align: LobbyTextAlign
  readonly font: LobbyFont
  readonly locked: boolean
  readonly heading: boolean
  readonly scene: { readonly text: string; readonly font: LobbyFont; readonly displayText: string | null }
}

export interface PlanNote extends NodeBase {
  readonly kind: 'note'
  readonly text: string
  readonly color: LobbyColor
  readonly size: LobbySize
  readonly scale: number
}

export interface PlanGeo extends NodeBase {
  readonly kind: 'geo'
  readonly w: number
  readonly h: number
  readonly text: string
  readonly geo: LobbyGeo
  readonly color: LobbyColor
  readonly labelColor: LobbyColor
  readonly fill: LobbyFill
  readonly dash: LobbyDash
  readonly size: LobbySize
  readonly locked: boolean
  readonly meta: Readonly<Record<string, string>>
  readonly titled: boolean
  readonly heading: boolean
  readonly scene: { readonly text: string }
}

export interface PlanArrow extends NodeBase {
  readonly kind: 'arrow'
  readonly from: PlanShape
  readonly to: PlanShape
  readonly startAnchor: { readonly x: number; readonly y: number } | null
  readonly endAnchor: { readonly x: number; readonly y: number } | null
  readonly color: LobbyColor
  readonly size: LobbySize
  readonly dash: LobbyDash
  readonly arrowheadEnd: LobbyArrowhead
  readonly elbow: boolean
  /** Page-space start and end points (on the outlines of the bound shapes). */
  readonly start: TemplatePoint
  readonly end: TemplatePoint
}

export type PlanShape = PlanFrame | PlanText | PlanNote | PlanGeo | PlanArrow
export type PlanNode = PlanShape

/** A template as built: every node in creation order, and where it was built. */
export interface BoardPlan {
  readonly origin: TemplatePoint
  readonly nodes: readonly PlanNode[]
}

export interface BoardBuilder {
  frame(spec: { x: number; y: number; w: number; h: number; name: string }): PlanFrame
  /** A frame with a heading text and an optional grey instruction line (both locked, PRE-07). */
  section(spec: SectionSpec): PlanFrame
  text(parent: PlanFrame | null, spec: TextSpec): PlanText
  note(parent: PlanFrame | null, spec: NoteSpec): PlanNote
  geo(parent: PlanFrame | null, spec: GeoSpec): PlanGeo
  /** Dashed grey box that marks where an image goes (locked, with the IMAGE_SLOT_META marker). */
  imageSlot(
    parent: PlanFrame | null,
    spec: { x: number; y: number; w: number; h: number; label: string; size?: LobbySize },
  ): PlanGeo
  /** A full-colour, unlabelled block (SWATCH_META): name it with a text shape beside it. */
  swatch(
    parent: PlanFrame | null,
    spec: { x: number; y: number; w: number; h: number; color: LobbyColor },
  ): PlanGeo
  /** Notes in a grid, filled row by row. */
  noteGrid(
    parent: PlanFrame,
    spec: { x: number; y: number; cols: number; gap?: number; gapY?: number; scale?: number },
    notes: ReadonlyArray<{ text: string; color: LobbyColor }>,
  ): PlanNote[]
  /** An arrow bound at both ends (arrow -> shape bindings). */
  arrow(from: PlanShape, to: PlanShape, spec?: ArrowSpec): PlanArrow
  /** Arrows from each shape to the next one, in order. */
  chain(steps: readonly PlanShape[], spec?: ArrowSpec): PlanArrow[]
  finish(): BoardPlan
}

export const HEADING_Y = 32
export const INTRO_Y = 92
/** Where section content starts below the heading and a (max three-line) intro. */
export const CONTENT_Y = 190

/**
 * A builder at page-space `origin` (the template's top-left corner). The geometry is computed here, once,
 * exactly as the tldraw builder always did (so the tldraw records are unchanged), and both emitters read it.
 */
export function createBoardBuilder(origin: TemplatePoint): BoardBuilder {
  const nodes: PlanNode[] = []
  let finished = false

  function offsetOf(parent: PlanFrame | null): { x: number; y: number } {
    if (!parent) return { x: 0, y: 0 }
    if (!nodes.includes(parent)) throw new Error('template builder: unknown parent')
    return { x: parent.page.x, y: parent.page.y }
  }

  function add<T extends PlanNode>(node: T): T {
    if (finished) throw new Error('template builder: already finished')
    nodes.push(node)
    return node
  }

  function place(parent: PlanFrame | null, local: Rect): Rect {
    const offset = offsetOf(parent)
    return { x: offset.x + local.x, y: offset.y + local.y, w: local.w, h: local.h }
  }

  const builder: BoardBuilder = {
    frame(spec) {
      const x = origin.x + spec.x
      const y = origin.y + spec.y
      return add<PlanFrame>({
        kind: 'frame',
        seq: nodes.length,
        parent: null,
        x,
        y,
        page: { x, y, w: spec.w, h: spec.h },
        outline: 'rect',
        w: spec.w,
        h: spec.h,
        name: spec.name,
      })
    },

    section(spec) {
      const frame = builder.frame(spec)
      const headingSize = spec.headingSize ?? 'l'
      const introW = Math.min(spec.w - PAD * 2, 1000)
      builder.text(frame, {
        x: PAD,
        y: HEADING_Y,
        // As wide as the intro under it (W5-59): the two share a reading-order row, read by their centres,
        // so a heading wider than its intro was read after it.
        w: spec.intro ? introW : spec.w - PAD * 2,
        text: spec.heading,
        size: headingSize,
        color: 'black',
        locked: true,
        heading: true,
      })
      if (spec.intro) {
        builder.text(frame, {
          x: PAD,
          y: INTRO_Y,
          w: introW,
          text: spec.intro,
          size: 's',
          color: 'grey',
          locked: true,
        })
      }
      return frame
    },

    text(parent, spec) {
      const font = spec.font ?? 'sans'
      const heading = spec.heading ?? false
      return add<PlanText>({
        kind: 'text',
        seq: nodes.length,
        parent,
        x: spec.x,
        y: spec.y,
        // Height is measured by the editor; a nominal one-line box for arrow maths.
        page: place(parent, { x: spec.x, y: spec.y, w: spec.w, h: 1 }),
        outline: 'rect',
        w: spec.w,
        text: spec.text,
        size: spec.size ?? 's',
        color: spec.color ?? 'black',
        align: spec.align ?? 'start',
        font,
        locked: spec.locked ?? false,
        heading,
        scene: {
          text: spec.scene?.text ?? spec.text,
          font: spec.scene?.font ?? (heading ? 'display' : font),
          displayText: spec.scene?.displayText ?? null,
        },
      })
    },

    note(parent, spec) {
      const scale = spec.scale ?? 1
      return add<PlanNote>({
        kind: 'note',
        seq: nodes.length,
        parent,
        x: spec.x,
        y: spec.y,
        page: place(parent, { x: spec.x, y: spec.y, w: NOTE_SIZE * scale, h: NOTE_SIZE * scale }),
        outline: 'rect',
        text: spec.text,
        color: spec.color,
        size: spec.size ?? 's',
        scale,
      })
    },

    geo(parent, spec) {
      const geo = spec.geo ?? 'rectangle'
      return add<PlanGeo>({
        kind: 'geo',
        seq: nodes.length,
        parent,
        x: spec.x,
        y: spec.y,
        page: place(parent, { x: spec.x, y: spec.y, w: spec.w, h: spec.h }),
        outline: geo === 'ellipse' ? 'ellipse' : 'rect',
        w: spec.w,
        h: spec.h,
        text: spec.text ?? '',
        geo,
        color: spec.color ?? 'black',
        labelColor: spec.labelColor ?? 'black',
        fill: spec.fill ?? 'none',
        dash: spec.dash ?? 'solid',
        size: spec.size ?? 's',
        locked: spec.locked ?? false,
        meta: { ...spec.meta },
        titled: spec.titled ?? false,
        heading: spec.heading ?? false,
        scene: { text: spec.scene?.text ?? spec.text ?? '' },
      })
    },

    imageSlot(parent, spec) {
      return builder.geo(parent, {
        x: spec.x,
        y: spec.y,
        w: spec.w,
        h: spec.h,
        text: spec.label,
        color: 'grey',
        labelColor: 'grey',
        fill: 'semi',
        dash: 'dashed',
        size: spec.size ?? 's',
        // Locked so a drag across the template moves nothing, but still a drop target: the web app
        // hit-tests marked slots itself, locked or not.
        locked: true,
        meta: IMAGE_SLOT_META,
      })
    },

    swatch(parent, spec) {
      return builder.geo(parent, {
        x: spec.x,
        y: spec.y,
        w: spec.w,
        h: spec.h,
        color: spec.color,
        fill: 'fill',
        size: 's',
        meta: SWATCH_META,
      })
    },

    noteGrid(parent, spec, notes) {
      const scale = spec.scale ?? 1
      const stepX = NOTE_SIZE * scale + (spec.gap ?? NOTE_GAP)
      const stepY = NOTE_SIZE * scale + (spec.gapY ?? spec.gap ?? NOTE_GAP)
      return notes.map((n, i) =>
        builder.note(parent, {
          x: spec.x + (i % spec.cols) * stepX,
          y: spec.y + Math.floor(i / spec.cols) * stepY,
          text: n.text,
          color: n.color,
          scale,
        }),
      )
    },

    arrow(from, to, spec = {}) {
      if (!nodes.includes(from) || !nodes.includes(to)) {
        throw new Error('template builder: arrow endpoints must be built first')
      }
      const parentFrame = commonFrame(from, to)
      const offset = parentFrame ? { x: parentFrame.page.x, y: parentFrame.page.y } : { x: 0, y: 0 }
      const startAnchor = spec.startAnchor ?? null
      const endAnchor = spec.endAnchor ?? null
      const pa = anchorPoint(from.page, startAnchor)
      const pb = anchorPoint(to.page, endAnchor)
      const s = exitPoint(from, startAnchor, pa, pb)
      const e = exitPoint(to, endAnchor, pb, pa)
      const x = s.x - offset.x
      const y = s.y - offset.y
      return add<PlanArrow>({
        kind: 'arrow',
        seq: nodes.length,
        parent: parentFrame,
        x,
        y,
        page: {
          x: offset.x + x + Math.min(0, e.x - s.x),
          y: offset.y + y + Math.min(0, e.y - s.y),
          w: Math.abs(e.x - s.x),
          h: Math.abs(e.y - s.y),
        },
        outline: 'rect',
        from,
        to,
        startAnchor,
        endAnchor,
        color: spec.color ?? 'grey',
        size: spec.size ?? 'm',
        dash: spec.dash ?? 'solid',
        arrowheadEnd: spec.arrowheadEnd ?? 'arrow',
        elbow: spec.elbow ?? false,
        start: s,
        end: e,
      })
    },

    chain(steps, spec) {
      const arrows: PlanArrow[] = []
      let prev: PlanShape | undefined
      for (const step of steps) {
        if (prev) arrows.push(builder.arrow(prev, step, spec))
        prev = step
      }
      return arrows
    },

    finish() {
      finished = true
      return { origin: { x: origin.x, y: origin.y }, nodes: [...nodes] }
    },
  }
  return builder
}

/**
 * Mirrors tldraw's arrow reparenting: the closest common frame, where a bound frame counts as its own
 * ancestor; null means the page. (Template frames never nest.)
 */
function commonFrame(a: PlanShape, b: PlanShape): PlanFrame | null {
  const chain = (shape: PlanShape): PlanFrame[] => {
    const out: PlanFrame[] = shape.kind === 'frame' ? [shape] : []
    for (let p = shape.parent, depth = 0; p && depth < 64; p = p.parent, depth++) out.push(p)
    return out
  }
  const bChain = new Set(chain(b))
  for (const f of chain(a)) if (bChain.has(f)) return f
  return null
}

function anchorPoint(rect: Rect, anchor: { x: number; y: number } | null): { x: number; y: number } {
  const ax = anchor ? anchor.x : 0.5
  const ay = anchor ? anchor.y : 0.5
  return { x: rect.x + rect.w * ax, y: rect.y + rect.h * ay }
}

/** Where the straight line from `inside` towards `toward` leaves the shape's outline. */
function exitPoint(
  target: PlanShape,
  anchor: { x: number; y: number } | null,
  inside: { x: number; y: number },
  toward: { x: number; y: number },
): { x: number; y: number } {
  const dx = toward.x - inside.x
  const dy = toward.y - inside.y
  if (dx === 0 && dy === 0) return inside
  const r = target.page
  if (target.outline === 'ellipse' && anchor === null) {
    const a = r.w / 2
    const b = r.h / 2
    const k = 1 / Math.sqrt((dx / a) ** 2 + (dy / b) ** 2)
    const t = Math.min(1, k)
    return { x: inside.x + dx * t, y: inside.y + dy * t }
  }
  let t = 1
  if (dx > 0) t = Math.min(t, (r.x + r.w - inside.x) / dx)
  if (dx < 0) t = Math.min(t, (r.x - inside.x) / dx)
  if (dy > 0) t = Math.min(t, (r.y + r.h - inside.y) / dy)
  if (dy < 0) t = Math.min(t, (r.y - inside.y) / dy)
  t = Math.max(0, t)
  return { x: inside.x + dx * t, y: inside.y + dy * t }
}
