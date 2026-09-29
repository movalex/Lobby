/**
 * The Excalidraw emitter: a `BoardPlan` as the elements Lobby stores on the new canvas (canvas-schema
 * `WireElement`), built through `@draftroom/canvas-schema/engine` (docs/EXCALIDRAW-MIGRATION.md §4.2
 * "Templates … packages/templates emit elements"):
 *
 * - a frame → `frame` (its name, the frame outline colour);
 * - a text → free `text` (plain words, wrapped to the text's width by the engine's `wrapText`, top-aligned,
 *   `autoResize: false` like tldraw's fixed-width text);
 * - a note → `stickynote` + bound label (`buildStickyNote`: the engine's own note layout, `created: null`);
 * - a box → `rectangle` / `ellipse` / `diamond` + bound label (`layoutBoundText`: the engine's label layout);
 *   image slots and swatches carry `customData.lobby.slot` / `swatch` (the converter's mapping of the
 *   tldraw meta markers);
 * - an arrow → `arrow` bound at both ends with `FixedPointBinding`s (the anchor, or the centre, in orbit
 *   mode), its path computed by the server's own re-snap (`resnapArrow`: the same helper the room runs
 *   on every arrow write), elbow arrows routed by the engine's router.
 *
 * Style names map as the converter maps stored tldraw boards (packages/tldraw-import convert.ts), with the
 * palette of `@draftroom/board-ops/elements`, so a template on the new canvas looks like a converted one.
 * Differences from the tldraw build, by design: plain text only (a card's bold title is its plain first
 * line), and no serif face (the tour's serif sample uses its `scene` override).
 *
 * Paint order is tldraw's (each frame, then its children in creation order; each container, then its
 * label); indices are fresh keys above `indexAbove`. Every element passes the server's `checkElement` and
 * the set passes `checkInvariants`, or this throws TemplateError('invalid-output').
 *
 * Text layout needs text metrics: in a browser the engine measures with the canvas; in Node the caller
 * installs the server table first (`installServerTextMetrics`), as apps/sync does at start-up.
 */

import {
  type IdSource,
  LOBBY_FRAME_STROKE,
  LOBBY_SEMI_FILL,
  lobbyColor,
  newElementId,
  randomInt31,
} from '@draftroom/board-ops/elements'
import { checkElement, type WireElement } from '@draftroom/canvas-schema/elements'
import {
  type ArrowElementLike,
  buildStickyNote,
  type EngineElement,
  indexKeysBetween,
  type LobbyFontFamily,
  layoutBoundText,
  resnapArrow,
  type TextElement,
  wrapLabelText,
} from '@draftroom/canvas-schema/engine'
import { checkInvariants } from '@draftroom/canvas-schema/invariants'
import { round2 } from '@draftroom/canvas-schema/limits'
import type {
  BoardPlan,
  LobbyDash,
  LobbyFill,
  LobbyFont,
  LobbySize,
  PlanArrow,
  PlanGeo,
  PlanNode,
} from '../builder.ts'
import { TemplateError } from '../common.ts'

type El = Record<string, unknown>

/** Stroke widths per size (tldraw 5.4.2 STROKE_SIZES; the converter's). */
export const STROKE_WIDTH: Record<LobbySize, number> = { s: 2, m: 3.5, l: 5, xl: 10 }
/** Free-text font sizes per size (tldraw FONT_SIZES × 16). */
export const TEXT_FONT_SIZE: Record<LobbySize, number> = { s: 18, m: 24, l: 36, xl: 44 }
/** Note and shape label font sizes per size (tldraw LABEL_FONT_SIZES × 16). */
export const LABEL_FONT_SIZE: Record<LobbySize, number> = { s: 18, m: 22, l: 26, xl: 32 }
/** Excalifont 5, Nunito 6, Comic Shanns 8 (§2.12); the engine has no serif, so serif reads as Nunito. */
export const FONT_FAMILY: Record<LobbyFont, LobbyFontFamily> = { draw: 5, sans: 6, serif: 6, mono: 8 }
/** Excalidraw's line height for every family Lobby serves (`getLineHeight`). */
export const LINE_HEIGHT = 1.25
const H_ALIGN = { start: 'left', middle: 'center', end: 'right' } as const

export interface SceneEmitOptions {
  /** Fresh indices above this key (the board's top index). */
  indexAbove?: string | null
  /** Where ids come from (default: fresh nanoid-style ids). */
  newId?: IdSource
  /** `updated` of every element (default: now). */
  now?: number
}

export interface SceneEmitResult {
  /** in paint order, with fresh indices */
  elements: WireElement[]
  /** plan node → the element that stands for it (a note's `stickynote`, a box's shape) */
  idOf: Map<PlanNode, string>
}

/** Excalidraw `normalizeFixedPoint`: a ratio within 1e-4 of 0.5 becomes 0.5001 (never exactly the centre). */
function fixedPoint(anchor: { readonly x: number; readonly y: number } | null): [number, number] {
  const fp: [number, number] = anchor ? [anchor.x, anchor.y] : [0.5, 0.5]
  return fp.map((r) => (Math.abs(r - 0.5) < 1e-4 ? 0.5001 : r)) as [number, number]
}

const strokeStyleOf = (dash: LobbyDash) =>
  dash === 'dashed' ? 'dashed' : dash === 'dotted' ? 'dotted' : 'solid'

function backgroundOf(fill: LobbyFill, color: ReturnType<typeof lobbyColor>): string {
  if (fill === 'semi') return LOBBY_SEMI_FILL
  if (fill === 'solid') return color.semi
  if (fill === 'fill') return color.fill
  return 'transparent'
}

/** The converter's customData for the tldraw meta markers (`draftroomSlot` → `slot`, …). */
function markersOf(geo: PlanGeo): El | undefined {
  const lobby: El = {}
  const map: Record<string, string> = {
    draftroomSlot: 'slot',
    draftroomSwatch: 'swatch',
    draftroomPrompt: 'prompt',
  }
  for (const [k, v] of Object.entries(geo.meta)) {
    const key = map[k]
    if (key) lobby[key] = v
  }
  return Object.keys(lobby).length ? { lobby } : undefined
}

export function planToScene(plan: BoardPlan, opts: SceneEmitOptions = {}): SceneEmitResult {
  const newId = opts.newId ?? newElementId
  const now = opts.now ?? Date.now()
  const idOf = new Map<PlanNode, string>()
  /** each node's elements in paint order (the main element first, its label after it) */
  const out = new Map<PlanNode, El[]>()
  const byId = new Map<string, El>()

  const common = (
    id: string,
    type: string,
    node: PlanNode,
    box: { x: number; y: number; w: number; h: number },
  ): El => ({
    id,
    type,
    x: box.x,
    y: box.y,
    width: box.w,
    height: box.h,
    angle: 0,
    strokeColor: '#1e1e1e',
    backgroundColor: 'transparent',
    fillStyle: 'solid',
    strokeWidth: 2,
    strokeStyle: 'solid',
    roundness: null,
    roughness: 0,
    opacity: 100,
    seed: randomInt31(),
    version: 1,
    versionNonce: randomInt31(),
    index: null,
    isDeleted: false,
    groupIds: [],
    frameId: node.parent ? (idOf.get(node.parent) ?? null) : null,
    boundElements: null,
    updated: now,
    created: null,
    link: null,
    locked: false,
  })

  const put = (node: PlanNode, els: El[]) => {
    const main = els[0]
    if (!main) return
    idOf.set(node, main.id as string)
    out.set(node, els)
    for (const e of els) byId.set(e.id as string, e)
  }

  const arrows: El[] = []
  for (const node of plan.nodes) {
    switch (node.kind) {
      case 'frame': {
        put(node, [
          { ...common(newId(), 'frame', node, node.page), strokeColor: LOBBY_FRAME_STROKE, name: node.name },
        ])
        break
      }
      case 'text': {
        const fam = FONT_FAMILY[node.scene.font]
        const size = TEXT_FONT_SIZE[node.size]
        const words = node.scene.text
        const text = wrapLabelText(words, fam, size, node.w)
        const lines = text.split('\n').length
        put(node, [
          {
            ...common(newId(), 'text', node, {
              x: node.page.x,
              y: node.page.y,
              w: node.w,
              h: lines * size * LINE_HEIGHT,
            }),
            strokeColor: lobbyColor(node.color).solid,
            locked: node.locked,
            text,
            fontSize: size,
            fontFamily: fam,
            textAlign: H_ALIGN[node.align],
            verticalAlign: 'top',
            containerId: null,
            originalText: words,
            autoResize: false,
            lineHeight: LINE_HEIGHT,
            baseFontSize: null,
            labelPosition: null,
          },
        ])
        break
      }
      case 'note': {
        const color = lobbyColor(node.color)
        const id = newId()
        const built = buildStickyNote({
          id,
          labelId: newId(),
          x: node.page.x,
          y: node.page.y,
          text: node.text,
          width: node.page.w,
          fontFamily: FONT_FAMILY.sans,
          baseFontSize: Math.min(512, Math.max(1, LABEL_FONT_SIZE[node.size] * node.scale)),
          backgroundColor: color.noteFill,
          strokeColor: color.noteText,
          seed: randomInt31(),
        })
        const frameId = node.parent ? (idOf.get(node.parent) ?? null) : null
        const stamp = (e: object): El => ({ ...e, frameId, versionNonce: randomInt31(), updated: now })
        put(node, built.label ? [stamp(built.note), stamp(built.label)] : [stamp(built.note)])
        break
      }
      case 'geo': {
        const color = lobbyColor(node.color)
        const id = newId()
        const container: El = {
          ...common(id, node.geo, node, node.page),
          strokeColor: color.solid,
          strokeWidth: STROKE_WIDTH[node.size],
          strokeStyle: strokeStyleOf(node.dash),
          roughness: node.dash === 'draw' ? 1 : 0,
          backgroundColor: backgroundOf(node.fill, color),
          locked: node.locked,
        }
        const custom = markersOf(node)
        if (custom) container.customData = custom
        if (!node.text) {
          put(node, [container])
          break
        }
        const labelId = newId()
        container.boundElements = [{ id: labelId, type: 'text' }]
        const label: El = {
          ...common(labelId, 'text', node, { x: node.page.x, y: node.page.y, w: 0, h: 0 }),
          strokeColor: lobbyColor(node.labelColor).solid,
          text: node.text,
          fontSize: LABEL_FONT_SIZE[node.size],
          fontFamily: FONT_FAMILY.sans,
          textAlign: 'center',
          verticalAlign: 'middle',
          containerId: id,
          originalText: node.text,
          autoResize: true,
          lineHeight: LINE_HEIGHT,
          baseFontSize: null,
          labelPosition: null,
        }
        const lay = layoutBoundText(container as unknown as EngineElement, label as unknown as TextElement)
        Object.assign(container, lay.container)
        Object.assign(label, lay.text)
        put(node, [container, label])
        break
      }
      case 'arrow': {
        const arrow = arrowOf(node, common(newId(), 'arrow', node, { x: 0, y: 0, w: 0, h: 0 }), idOf)
        for (const target of [node.from, node.to]) {
          const t = byId.get(idOf.get(target) ?? '')
          if (!t) throw new TemplateError('invalid-output', 'Template arrow bound to a missing element')
          const bound = (t.boundElements as { id: string; type: string }[] | null) ?? []
          if (!bound.some((b) => b.id === arrow.id))
            t.boundElements = [...bound, { id: arrow.id as string, type: 'arrow' }]
        }
        arrows.push(arrow)
        put(node, [arrow])
        break
      }
    }
  }

  // arrow paths: exactly where the room's re-snap puts them (against the targets' final geometry)
  const engineMap = byId as unknown as ReadonlyMap<string, EngineElement>
  // (repeated until it settles: the first re-snap can leave a width or height one float ulp off the
  // points it stores, which the room's own re-snap would then "fix")
  for (const arrow of arrows) {
    for (let i = 0; i < 4; i++) {
      const snapped = resnapArrow(arrow as unknown as ArrowElementLike, engineMap)
      if (!snapped.changed) break
      Object.assign(arrow, snapped.path)
    }
  }

  // paint order: each top-level node, a frame followed by its children; each container by its label
  const ordered: El[] = []
  for (const node of plan.nodes) {
    if (node.parent) continue
    ordered.push(...(out.get(node) ?? []))
    if (node.kind === 'frame')
      for (const child of plan.nodes) if (child.parent === node) ordered.push(...(out.get(child) ?? []))
  }
  const keys = indexKeysBetween(opts.indexAbove ?? null, null, ordered.length)
  const elements: WireElement[] = ordered.map((el, i) => {
    el.index = keys[i]
    const check = checkElement(el)
    if (!check.ok)
      throw new TemplateError('invalid-output', `Template produced an invalid element: ${check.detail}`)
    return el as unknown as WireElement
  })
  const violations = checkInvariants(elements)
  if (violations.length)
    throw new TemplateError(
      'invalid-output',
      `Template elements are inconsistent: ${[...new Set(violations.map((v) => v.code))].join(', ')}`,
    )
  return { elements, idOf }
}

function arrowOf(node: PlanArrow, base: El, idOf: Map<PlanNode, string>): El {
  const color = lobbyColor(node.color)
  const fromId = idOf.get(node.from)
  const toId = idOf.get(node.to)
  if (!fromId || !toId)
    throw new TemplateError('invalid-output', 'Template arrow endpoints must be built first')
  const x = round2(node.start.x)
  const y = round2(node.start.y)
  const dx = round2(node.end.x - x)
  const dy = round2(node.end.y - y)
  const el: El = {
    ...base,
    x,
    y,
    width: Math.abs(dx),
    height: Math.abs(dy),
    strokeColor: color.solid,
    strokeWidth: STROKE_WIDTH[node.size],
    strokeStyle: strokeStyleOf(node.dash),
    points: [
      [0, 0],
      [dx, dy],
    ],
    startBinding: { elementId: fromId, fixedPoint: fixedPoint(node.startAnchor), mode: 'orbit' },
    endBinding: { elementId: toId, fixedPoint: fixedPoint(node.endAnchor), mode: 'orbit' },
    startArrowhead: null,
    endArrowhead: node.arrowheadEnd === 'arrow' ? 'arrow' : null,
    elbowed: node.elbow,
  }
  if (node.elbow) Object.assign(el, { fixedSegments: null, startIsSpecial: false, endIsSpecial: false })
  return el
}
