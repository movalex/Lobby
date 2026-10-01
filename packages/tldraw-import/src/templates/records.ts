// The tldraw emitter (the tldraw board page's, until wave 4 part 2; kept here as the reference the
// converter's parity tests and fixtures are made from): a `BoardPlan` as plain tldraw 5.4.2 shape + binding
// records with full default props (from the tldraw ShapeUtil getDefaultProps / ArrowBindingUtil defaults),
// fresh ids, and fractional index keys per parent. The output is what the template builder produced before
// the engine-neutral plan existed (same records, same key order, same index order), because the geometry
// comes from the plan unchanged and the records are made in the plan's creation order.

import type { BoardPlan, PlanNode } from '@draftroom/templates/builder'
import {
  createBindingId,
  createShapeId,
  type TLArrowBinding,
  type TLArrowShape,
  type TLFrameShape,
  type TLGeoShape,
  type TLNoteShape,
  type TLParentId,
  type TLRecord,
  type TLRichText,
  type TLShape,
  type TLShapeId,
  type TLTextShape,
  toRichText,
} from '@tldraw/tlschema'
import { getIndexAbove, type IndexKey } from '@tldraw/utils'
import type { TemplateContext } from './types.ts'

/** Records for `plan` on `ctx.pageId`, top-level shapes above `ctx.indexAbove`. */
export function planToRecords(plan: BoardPlan, ctx: TemplateContext): TLRecord[] {
  const shapes: TLShape[] = []
  const bindings: TLArrowBinding[] = []
  const ids = new Map<PlanNode, TLShapeId>()
  const lastIndex = new Map<TLParentId, IndexKey | null>()
  lastIndex.set(ctx.pageId, ctx.indexAbove ?? null)

  function nextIndex(parentId: TLParentId): IndexKey {
    const next = getIndexAbove(lastIndex.get(parentId) ?? null)
    lastIndex.set(parentId, next)
    return next
  }

  function parentIdOf(node: PlanNode): TLParentId {
    if (!node.parent) return ctx.pageId
    const id = ids.get(node.parent)
    if (!id) throw new Error('template builder: unknown parent')
    return id
  }

  function common(node: PlanNode, opts: { locked?: boolean; meta?: Readonly<Record<string, string>> } = {}) {
    const parentId = parentIdOf(node)
    const id = createShapeId()
    ids.set(node, id)
    return {
      id,
      typeName: 'shape' as const,
      x: node.x,
      y: node.y,
      rotation: 0,
      index: nextIndex(parentId),
      parentId,
      isLocked: opts.locked ?? false,
      opacity: 1,
      meta: { ...opts.meta },
    }
  }

  for (const node of plan.nodes) {
    switch (node.kind) {
      case 'frame': {
        const shape: TLFrameShape = {
          ...common(node),
          type: 'frame',
          props: { w: node.w, h: node.h, name: node.name, color: 'black' },
        }
        shapes.push(shape)
        break
      }
      case 'text': {
        const shape: TLTextShape = {
          ...common(node, { locked: node.locked }),
          type: 'text',
          props: {
            color: node.color,
            size: node.size,
            // tldraw has no display face (the new canvas's Lilita One): headings stay in its sans
            font: node.font === 'display' ? 'sans' : node.font,
            textAlign: node.align,
            w: node.w,
            richText: toRichText(node.text),
            scale: 1,
            autoSize: false,
          },
        }
        shapes.push(shape)
        break
      }
      case 'note': {
        const shape: TLNoteShape = {
          ...common(node),
          type: 'note',
          props: {
            color: node.color,
            labelColor: 'black',
            size: node.size,
            font: 'sans',
            fontSizeAdjustment: 1,
            align: 'middle',
            verticalAlign: 'middle',
            growY: 0,
            url: '',
            richText: toRichText(node.text),
            scale: node.scale,
            textLastEditedBy: null,
          },
        }
        shapes.push(shape)
        break
      }
      case 'geo': {
        const shape: TLGeoShape = {
          ...common(node, { locked: node.locked, meta: node.meta }),
          type: 'geo',
          props: {
            w: node.w,
            h: node.h,
            geo: node.geo,
            dash: node.dash,
            growY: 0,
            url: '',
            scale: 1,
            flipX: false,
            flipY: false,
            color: node.color,
            labelColor: node.labelColor,
            fill: node.fill,
            size: node.size,
            font: 'sans',
            align: 'middle',
            verticalAlign: 'middle',
            richText: node.titled ? titled(node.text) : toRichText(node.text),
          },
        }
        shapes.push(shape)
        break
      }
      case 'arrow': {
        const parentId = parentIdOf(node)
        const id = createShapeId()
        ids.set(node, id)
        const shape: TLArrowShape = {
          id,
          typeName: 'shape',
          type: 'arrow',
          x: node.x,
          y: node.y,
          rotation: 0,
          index: nextIndex(parentId),
          parentId,
          isLocked: false,
          opacity: 1,
          meta: {},
          props: {
            kind: node.elbow ? 'elbow' : 'arc',
            elbowMidPoint: 0.5,
            dash: node.dash,
            size: node.size,
            fill: 'none',
            color: node.color,
            labelColor: 'black',
            bend: 0,
            start: { x: 0, y: 0 },
            end: { x: node.end.x - node.start.x, y: node.end.y - node.start.y },
            arrowheadStart: 'none',
            arrowheadEnd: node.arrowheadEnd,
            richText: toRichText(''),
            labelPosition: 0.5,
            font: 'sans',
            scale: 1,
          },
        }
        shapes.push(shape)
        const fromId = ids.get(node.from)
        const toId = ids.get(node.to)
        if (!fromId || !toId) throw new Error('template builder: arrow endpoints must be built first')
        bindings.push(arrowBinding(id, fromId, 'start', node.startAnchor))
        bindings.push(arrowBinding(id, toId, 'end', node.endAnchor))
        break
      }
    }
  }
  return [...shapes, ...bindings]
}

/** A bold first line (a card's title or a key) over plain lines, as tldraw's rich text stores it. */
function titled(text: string): TLRichText {
  const lines = paragraphTexts(toRichText(text))
  const [title = '', ...rest] = lines
  return {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: title, marks: [{ type: 'bold' }] }] },
      ...rest.map((line) =>
        line ? { type: 'paragraph', content: [{ type: 'text', text: line }] } : { type: 'paragraph' },
      ),
    ],
  }
}

/** The plain text of each paragraph of a `toRichText` document. */
function paragraphTexts(rich: TLRichText): string[] {
  return (rich.content as Array<{ content?: Array<{ text?: string }> }>).map((p) =>
    (p.content ?? []).map((n) => n.text ?? '').join(''),
  )
}

function arrowBinding(
  arrowId: TLShapeId,
  targetId: TLShapeId,
  terminal: 'start' | 'end',
  anchor: { readonly x: number; readonly y: number } | null,
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
