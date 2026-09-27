// Record factories for template content. Produces plain tldraw 5.4.2 records with full
// default props (from the tldraw ShapeUtil getDefaultProps / ArrowBindingUtil defaults),
// fresh ids, and fractional index keys per parent.

import {
  createBindingId,
  createShapeId,
  type TLArrowBinding,
  type TLArrowShape,
  type TLArrowShapeArrowheadStyle,
  type TLDefaultColorStyle,
  type TLDefaultDashStyle,
  type TLDefaultFillStyle,
  type TLDefaultSizeStyle,
  type TLDefaultTextAlignStyle,
  type TLFrameShape,
  type TLGeoShape,
  type TLGeoShapeGeoStyle,
  type TLNoteShape,
  type TLParentId,
  type TLRecord,
  type TLShape,
  type TLShapeId,
  type TLTextShape,
  toRichText,
} from '@tldraw/tlschema'
import { getIndexAbove, type IndexKey } from '@tldraw/utils'
import { NOTE_SIZE, type Rect } from './layout.ts'
import type { TemplateContext } from './types.ts'

/** Inner padding of a section frame. */
export const PAD = 40
/** Gap between neighbouring sticky notes. */
export const NOTE_GAP = 20

type Outline = 'rect' | 'ellipse'

interface Placed {
  shape: TLShape
  /** Page-space bounds. */
  page: Rect
  outline: Outline
}

export interface TextSpec {
  x: number
  y: number
  w: number
  text: string
  size?: TLDefaultSizeStyle
  color?: TLDefaultColorStyle
  align?: TLDefaultTextAlignStyle
}

export interface NoteSpec {
  x: number
  y: number
  text: string
  color: TLDefaultColorStyle
  size?: TLDefaultSizeStyle
  scale?: number
}

export interface GeoSpec {
  x: number
  y: number
  w: number
  h: number
  text?: string
  geo?: TLGeoShapeGeoStyle
  color?: TLDefaultColorStyle
  labelColor?: TLDefaultColorStyle
  fill?: TLDefaultFillStyle
  dash?: TLDefaultDashStyle
  size?: TLDefaultSizeStyle
}

export interface ArrowSpec {
  /** Normalized anchor on the start shape; omitted = shape centre (non-precise binding). */
  startAnchor?: { x: number; y: number }
  /** Normalized anchor on the end shape; omitted = shape centre (non-precise binding). */
  endAnchor?: { x: number; y: number }
  color?: TLDefaultColorStyle
  size?: TLDefaultSizeStyle
  dash?: TLDefaultDashStyle
  arrowheadEnd?: TLArrowShapeArrowheadStyle
}

export interface SectionSpec {
  x: number
  y: number
  w: number
  h: number
  name: string
  heading: string
  intro?: string
  headingSize?: TLDefaultSizeStyle
}

export interface BoardBuilder {
  frame(spec: { x: number; y: number; w: number; h: number; name: string }): TLFrameShape
  /** A frame with a heading text and an optional grey instruction line. */
  section(spec: SectionSpec): TLFrameShape
  text(parent: TLFrameShape | null, spec: TextSpec): TLTextShape
  note(parent: TLFrameShape | null, spec: NoteSpec): TLNoteShape
  geo(parent: TLFrameShape | null, spec: GeoSpec): TLGeoShape
  /** Dashed grey box that marks where an image goes. */
  imageSlot(
    parent: TLFrameShape | null,
    spec: { x: number; y: number; w: number; h: number; label: string },
  ): TLGeoShape
  /** Notes in a grid, filled row by row. */
  noteGrid(
    parent: TLFrameShape,
    spec: { x: number; y: number; cols: number; gap?: number; gapY?: number; scale?: number },
    notes: ReadonlyArray<{ text: string; color: TLDefaultColorStyle }>,
  ): TLNoteShape[]
  /** An arrow bound at both ends (arrow -> shape bindings). */
  arrow(from: TLShape, to: TLShape, spec?: ArrowSpec): TLArrowShape
  /** Arrows from each shape to the next one, in order. */
  chain(steps: readonly TLShape[], spec?: ArrowSpec): TLArrowShape[]
  finish(): TLRecord[]
}

export const HEADING_Y = 32
export const INTRO_Y = 92
/** Where section content starts below the heading and a (max three-line) intro. */
export const CONTENT_Y = 190

export function createBoardBuilder(ctx: TemplateContext): BoardBuilder {
  const shapes: TLShape[] = []
  const bindings: TLArrowBinding[] = []
  const placed = new Map<TLShapeId, Placed>()
  const lastIndex = new Map<TLParentId, IndexKey | null>()
  lastIndex.set(ctx.pageId, ctx.indexAbove ?? null)
  let finished = false

  function nextIndex(parentId: TLParentId): IndexKey {
    const next = getIndexAbove(lastIndex.get(parentId) ?? null)
    lastIndex.set(parentId, next)
    return next
  }

  function parentInfo(parent: TLFrameShape | null): {
    parentId: TLParentId
    offset: { x: number; y: number }
  } {
    if (!parent) return { parentId: ctx.pageId, offset: { x: 0, y: 0 } }
    const p = placed.get(parent.id)
    if (!p) throw new Error(`template builder: unknown parent ${parent.id}`)
    return { parentId: parent.id, offset: { x: p.page.x, y: p.page.y } }
  }

  function common(parent: TLFrameShape | null, x: number, y: number) {
    const { parentId } = parentInfo(parent)
    return {
      id: createShapeId(),
      typeName: 'shape' as const,
      x,
      y,
      rotation: 0,
      index: nextIndex(parentId),
      parentId,
      isLocked: false,
      opacity: 1,
      meta: {},
    }
  }

  function register(shape: TLShape, parent: TLFrameShape | null, local: Rect, outline: Outline = 'rect') {
    if (finished) throw new Error('template builder: already finished')
    const { offset } = parentInfo(parent)
    placed.set(shape.id, {
      shape,
      page: { x: offset.x + local.x, y: offset.y + local.y, w: local.w, h: local.h },
      outline,
    })
    shapes.push(shape)
  }

  const builder: BoardBuilder = {
    frame(spec) {
      const x = ctx.origin.x + spec.x
      const y = ctx.origin.y + spec.y
      const shape: TLFrameShape = {
        ...common(null, x, y),
        type: 'frame',
        props: { w: spec.w, h: spec.h, name: spec.name, color: 'black' },
      }
      register(shape, null, { x, y, w: spec.w, h: spec.h })
      return shape
    },

    section(spec) {
      const frame = builder.frame(spec)
      const headingSize = spec.headingSize ?? 'l'
      builder.text(frame, {
        x: PAD,
        y: HEADING_Y,
        w: spec.w - PAD * 2,
        text: spec.heading,
        size: headingSize,
        color: 'black',
      })
      if (spec.intro) {
        builder.text(frame, {
          x: PAD,
          y: INTRO_Y,
          w: Math.min(spec.w - PAD * 2, 1000),
          text: spec.intro,
          size: 's',
          color: 'grey',
        })
      }
      return frame
    },

    text(parent, spec) {
      const shape: TLTextShape = {
        ...common(parent, spec.x, spec.y),
        type: 'text',
        props: {
          color: spec.color ?? 'black',
          size: spec.size ?? 's',
          font: 'sans',
          textAlign: spec.align ?? 'start',
          w: spec.w,
          richText: toRichText(spec.text),
          scale: 1,
          autoSize: false,
        },
      }
      // Height is measured by the editor; register a nominal one-line box for arrow maths.
      register(shape, parent, { x: spec.x, y: spec.y, w: spec.w, h: 1 })
      return shape
    },

    note(parent, spec) {
      const scale = spec.scale ?? 1
      const shape: TLNoteShape = {
        ...common(parent, spec.x, spec.y),
        type: 'note',
        props: {
          color: spec.color,
          labelColor: 'black',
          size: spec.size ?? 's',
          font: 'sans',
          fontSizeAdjustment: 1,
          align: 'middle',
          verticalAlign: 'middle',
          growY: 0,
          url: '',
          richText: toRichText(spec.text),
          scale,
          textLastEditedBy: null,
        },
      }
      register(shape, parent, { x: spec.x, y: spec.y, w: NOTE_SIZE * scale, h: NOTE_SIZE * scale })
      return shape
    },

    geo(parent, spec) {
      const geo = spec.geo ?? 'rectangle'
      const shape: TLGeoShape = {
        ...common(parent, spec.x, spec.y),
        type: 'geo',
        props: {
          w: spec.w,
          h: spec.h,
          geo,
          dash: spec.dash ?? 'solid',
          growY: 0,
          url: '',
          scale: 1,
          flipX: false,
          flipY: false,
          color: spec.color ?? 'black',
          labelColor: spec.labelColor ?? 'black',
          fill: spec.fill ?? 'none',
          size: spec.size ?? 's',
          font: 'sans',
          align: 'middle',
          verticalAlign: 'middle',
          richText: toRichText(spec.text ?? ''),
        },
      }
      register(
        shape,
        parent,
        { x: spec.x, y: spec.y, w: spec.w, h: spec.h },
        geo === 'ellipse' || geo === 'oval' ? 'ellipse' : 'rect',
      )
      return shape
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
        size: 's',
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
      const a = placed.get(from.id)
      const b = placed.get(to.id)
      if (!a || !b) throw new Error('template builder: arrow endpoints must be built first')
      const frameId = commonFrameAncestor(a.shape, b.shape, placed)
      const parent = frameId ? placed.get(frameId) : undefined
      const parentFrame = parent?.shape.type === 'frame' ? parent.shape : null
      const parentId: TLParentId = parentFrame ? parentFrame.id : ctx.pageId
      const offset = parent && parentFrame ? { x: parent.page.x, y: parent.page.y } : { x: 0, y: 0 }

      const startAnchor = spec.startAnchor ?? null
      const endAnchor = spec.endAnchor ?? null
      const pa = anchorPoint(a.page, startAnchor)
      const pb = anchorPoint(b.page, endAnchor)
      const s = exitPoint(a, startAnchor, pa, pb)
      const e = exitPoint(b, endAnchor, pb, pa)

      const x = s.x - offset.x
      const y = s.y - offset.y
      const shape: TLArrowShape = {
        id: createShapeId(),
        typeName: 'shape',
        type: 'arrow',
        x,
        y,
        rotation: 0,
        index: nextIndex(parentId),
        parentId,
        isLocked: false,
        opacity: 1,
        meta: {},
        props: {
          kind: 'arc',
          elbowMidPoint: 0.5,
          dash: spec.dash ?? 'solid',
          size: spec.size ?? 'm',
          fill: 'none',
          color: spec.color ?? 'grey',
          labelColor: 'black',
          bend: 0,
          start: { x: 0, y: 0 },
          end: { x: e.x - s.x, y: e.y - s.y },
          arrowheadStart: 'none',
          arrowheadEnd: spec.arrowheadEnd ?? 'arrow',
          richText: toRichText(''),
          labelPosition: 0.5,
          font: 'sans',
          scale: 1,
        },
      }
      register(shape, parentFrame, {
        x: x + Math.min(0, e.x - s.x),
        y: y + Math.min(0, e.y - s.y),
        w: Math.abs(e.x - s.x),
        h: Math.abs(e.y - s.y),
      })
      bindings.push(arrowBinding(shape.id, from.id, 'start', startAnchor))
      bindings.push(arrowBinding(shape.id, to.id, 'end', endAnchor))
      return shape
    },

    chain(steps, spec) {
      const arrows: TLArrowShape[] = []
      let prev: TLShape | undefined
      for (const step of steps) {
        if (prev) arrows.push(builder.arrow(prev, step, spec))
        prev = step
      }
      return arrows
    },

    finish() {
      finished = true
      return [...shapes, ...bindings]
    },
  }
  return builder
}

function arrowBinding(
  arrowId: TLShapeId,
  targetId: TLShapeId,
  terminal: 'start' | 'end',
  anchor: { x: number; y: number } | null,
): TLArrowBinding {
  return {
    id: createBindingId(),
    typeName: 'binding',
    type: 'arrow',
    fromId: arrowId,
    toId: targetId,
    props: {
      terminal,
      normalizedAnchor: anchor ? { x: anchor.x, y: anchor.y } : { x: 0.5, y: 0.5 },
      isExact: false,
      isPrecise: anchor !== null,
      snap: 'none',
    },
    meta: {},
  }
}

/**
 * Mirrors tldraw's arrow reparenting: the closest common frame, where a bound frame
 * counts as its own ancestor; null means the page.
 */
function commonFrameAncestor(a: TLShape, b: TLShape, placed: Map<TLShapeId, Placed>): TLShapeId | null {
  const chain = (shape: TLShape): TLShapeId[] => {
    const ids: TLShapeId[] = shape.type === 'frame' ? [shape.id] : []
    let parentId: TLParentId = shape.parentId
    for (let depth = 0; depth < 64 && parentId.startsWith('shape:'); depth++) {
      const parent = placed.get(parentId as TLShapeId)
      if (!parent) break
      ids.push(parent.shape.id)
      parentId = parent.shape.parentId
    }
    return ids
  }
  const bChain = new Set(chain(b))
  for (const id of chain(a)) if (bChain.has(id)) return id
  return null
}

function anchorPoint(rect: Rect, anchor: { x: number; y: number } | null): { x: number; y: number } {
  const ax = anchor ? anchor.x : 0.5
  const ay = anchor ? anchor.y : 0.5
  return { x: rect.x + rect.w * ax, y: rect.y + rect.h * ay }
}

/** Where the straight line from `inside` towards `toward` leaves the shape's outline. */
function exitPoint(
  target: Placed,
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
