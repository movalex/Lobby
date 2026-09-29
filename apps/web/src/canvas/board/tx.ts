/**
 * The structural writes of `LobbyTx` beyond C0's create / update / delete (docs/EXCALIDRAW-CONTRACTS.md
 * §2.1): reorder, frame membership, group, ungroup, arrow binding and duplicate. Each is expressed as
 * C0 writes inside the caller's `transact`, so it is one undo step and the sync engine pushes it as
 * ordinary edits; the server validates and repairs as for any edit (final indices, `boundElements`
 * symmetry, bound-arrow re-snap).
 *
 * Excalidraw keeps structure in fields: a bound label shares its container's `frameId` and `groupIds`
 * (so labels are written with their containers), a group is a shared `groupIds` entry with the
 * outermost group last, an arrow end is `startBinding` / `endBinding` plus the target's `boundElements`
 * entry, and paint order is the fractional `index`.
 *
 * Pure (Node-tested): reads go through the transaction's view (the scene plus this step's writes).
 */
import { lobbyKeySpec } from '@draftroom/canvas-schema/custom-data'
import { generateKeyBetween, generateNKeysBetween } from '@excalidraw/fractional-indexing'
import type { CanvasElement, ItemKind, ReorderTo, ScenePoint } from '../api/lobby-canvas.ts'
import type { CustomDataHandlerSpec } from '../registries.ts'

export interface TxView {
  /** an element as this step sees it (the scene with this step's writes), live or deleted */
  get(id: string): CanvasElement | undefined
  /** live elements in paint order, as this step sees them */
  items(): readonly CanvasElement[]
  update(id: string, patch: Readonly<Record<string, unknown>>): void
  create(kind: ItemKind, props: Readonly<Record<string, unknown>>): string
  /** a fresh element or group id */
  newId(): string
}

type Bound = { readonly id: string; readonly type: string }
const boundOf = (el: CanvasElement | undefined): Bound[] => [
  ...(((el as { boundElements?: readonly Bound[] | null } | undefined)?.boundElements ?? []) as Bound[]),
]
const isLabel = (el: CanvasElement) => el.type === 'text' && !!el.containerId
const indexOf = (el: CanvasElement): string | null => (el as { index?: string | null }).index ?? null

/** The ids and their bound labels (labels move, group and frame with their containers). */
function withLabels(view: TxView, ids: readonly string[]): string[] {
  const out = new Set<string>()
  for (const id of ids) {
    const el = view.get(id)
    if (!el || (el as { isDeleted?: boolean }).isDeleted) continue
    const container = isLabel(el) ? view.get(el.containerId as string) : undefined
    const root = container ?? el
    out.add(root.id)
    for (const b of boundOf(root)) if (b.type === 'text') out.add(b.id)
  }
  return [...out]
}

// ---- reorder ----------------------------------------------------------------------------------------------

/**
 * New `index` values for `ids` (labels follow their containers). `front`/`back`: the whole selection to
 * the top or the bottom, relative order kept; `forward`/`backward`: past the next element that is not
 * moving. Returns the id → index map it wrote.
 */
export function reorder(view: TxView, ids: readonly string[], to: ReorderTo): Map<string, string> {
  const order = view.items()
  const moving = new Set(withLabels(view, ids))
  const out = new Map<string, string>()
  if (moving.size === 0) return out
  const rest = order.filter((e) => !moving.has(e.id))
  const block = order.filter((e) => moving.has(e.id))
  let lo: string | null = null
  let hi: string | null = null
  if (to === 'front') lo = rest.length ? indexOf(rest[rest.length - 1] as CanvasElement) : null
  else if (to === 'back') hi = rest.length ? indexOf(rest[0] as CanvasElement) : null
  else {
    const pos = order.map((e) => e.id)
    if (to === 'forward') {
      const topMoving = Math.max(...block.map((e) => pos.indexOf(e.id)))
      const above = order.slice(topMoving + 1).find((e) => !moving.has(e.id))
      if (!above) return out
      const i = rest.indexOf(above)
      lo = indexOf(above)
      hi = i + 1 < rest.length ? indexOf(rest[i + 1] as CanvasElement) : null
    } else {
      const bottomMoving = Math.min(...block.map((e) => pos.indexOf(e.id)))
      const below = [...order.slice(0, bottomMoving)].reverse().find((e) => !moving.has(e.id))
      if (!below) return out
      const i = rest.indexOf(below)
      hi = indexOf(below)
      lo = i > 0 ? indexOf(rest[i - 1] as CanvasElement) : null
    }
  }
  const keys = generateNKeysBetween(lo, hi, block.length)
  block.forEach((e, i) => {
    const key = keys[i] as string
    out.set(e.id, key)
    view.update(e.id, { index: key })
  })
  return out
}

// ---- frames and groups -----------------------------------------------------------------------------------

/** Frame membership (null: out of any frame), labels included. */
export function setFrame(view: TxView, ids: readonly string[], frameId: string | null): void {
  for (const id of withLabels(view, ids)) {
    const el = view.get(id)
    if (!el || el.type === 'frame' || el.frameId === frameId) continue
    view.update(id, { frameId })
  }
}

/** A new outermost group around `ids` (labels included); returns its id. */
export function group(view: TxView, ids: readonly string[]): string {
  const gid = view.newId()
  for (const id of withLabels(view, ids)) {
    const el = view.get(id)
    if (!el) continue
    view.update(id, { groupIds: [...el.groupIds, gid] })
  }
  return gid
}

/** Removes the outermost group of each of `ids` from every element in it. */
export function ungroup(view: TxView, ids: readonly string[]): void {
  const groups = new Set<string>()
  for (const id of ids) {
    const el = view.get(id)
    const outer = el?.groupIds[el.groupIds.length - 1]
    if (outer) groups.add(outer)
  }
  if (!groups.size) return
  for (const el of view.items()) {
    if (!el.groupIds.some((g) => groups.has(g))) continue
    view.update(el.id, { groupIds: el.groupIds.filter((g) => !groups.has(g)) })
  }
}

// ---- arrow binding ---------------------------------------------------------------------------------------

type Pt = readonly [number, number]

/** The scene point of an arrow's start or end. */
function arrowEnd(arrow: CanvasElement, end: 'start' | 'end'): ScenePoint {
  const pts = ((arrow as { points?: readonly Pt[] }).points ?? []) as readonly Pt[]
  const p = (end === 'start' ? pts[0] : pts[pts.length - 1]) ?? [0, 0]
  return { x: arrow.x + p[0], y: arrow.y + p[1] }
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0.5))

/**
 * Binds an arrow end to `targetId` (null unbinds): the arrow's `startBinding`/`endBinding` with the end's
 * position as the target-relative fixed point, and the target's `boundElements` entry (the old target
 * loses its entry). The server re-snaps the end onto the target's outline.
 */
export function bind(view: TxView, arrowId: string, end: 'start' | 'end', targetId: string | null): void {
  const arrow = view.get(arrowId)
  if (arrow?.type !== 'arrow') throw new Error(`bind: ${arrowId} is not an arrow`)
  const field = end === 'start' ? 'startBinding' : 'endBinding'
  const current = (arrow as unknown as Record<string, { elementId?: string } | null | undefined>)[field]
  const oldId = current?.elementId ?? null
  const other = (arrow as unknown as Record<string, { elementId?: string } | null | undefined>)[
    end === 'start' ? 'endBinding' : 'startBinding'
  ]
  if (oldId && oldId !== targetId && other?.elementId !== oldId) {
    const old = view.get(oldId)
    if (old) view.update(oldId, { boundElements: boundOf(old).filter((b) => b.id !== arrowId) })
  }
  if (!targetId) {
    view.update(arrowId, { [field]: null })
    return
  }
  const target = view.get(targetId)
  if (!target || (target as { isDeleted?: boolean }).isDeleted)
    throw new Error(`bind: no element ${targetId}`)
  const p = arrowEnd(arrow, end)
  const fixedPoint = [
    clamp01((p.x - target.x) / (target.width || 1)),
    clamp01((p.y - target.y) / (target.height || 1)),
  ]
  view.update(arrowId, { [field]: { elementId: targetId, fixedPoint, mode: 'orbit' } })
  const bound = boundOf(target)
  if (!bound.some((b) => b.id === arrowId))
    view.update(targetId, { boundElements: [...bound, { id: arrowId, type: 'arrow' }] })
}

// ---- duplicate ---------------------------------------------------------------------------------------------

/**
 * A copy's `customData.lobby` (§3.3 "On duplicate / paste"): a feature's handler decides first (return
 * undefined to strip); otherwise the key's canvas-schema rule: `keep` copies it, `strip` drops it,
 * `relink` (element ids inside, with no handler to relink them) drops it, `strip-index` keeps `present`
 * without its `index`. An unknown key is dropped (the server would refuse it).
 */
export function duplicateLobbyData(
  lobby: Readonly<Record<string, unknown>> | undefined,
  idMap: ReadonlyMap<string, string>,
  handlers: readonly CustomDataHandlerSpec[],
): Record<string, unknown> | undefined {
  if (!lobby) return undefined
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(lobby)) {
    const h = handlers.find((x) => (x.match === 'exact' ? x.id === key : key.startsWith(x.id)))
    if (h?.onDuplicate) {
      const v = h.onDuplicate(value, { idMap })
      if (v !== undefined) out[key] = v
      continue
    }
    const spec = lobbyKeySpec(key)
    if (!spec) continue
    if (spec.duplicate === 'keep') out[key] = structuredClone(value)
    else if (spec.duplicate === 'strip-index' && value && typeof value === 'object') {
      const { index: _index, ...restValue } = value as Record<string, unknown>
      if (Object.keys(restValue).length) out[key] = restValue
    }
  }
  return Object.keys(out).length ? out : undefined
}

/** Fields a copy never takes from its original (identity, versioning, structure it gets anew). */
const SKIP = new Set([
  'id',
  'version',
  'versionNonce',
  'seed',
  'updated',
  'index',
  'isDeleted',
  'boundElements',
  'customData',
  'created',
])

const KIND: Readonly<Record<string, ItemKind>> = {
  stickynote: 'note',
  text: 'text',
  rectangle: 'rectangle',
  ellipse: 'ellipse',
  diamond: 'diamond',
  arrow: 'arrow',
  line: 'line',
  freedraw: 'freedraw',
  frame: 'frame',
  image: 'image',
}

/**
 * Copies `ids` (with their labels; a frame with its children) offset by `offset`, on top of the board.
 * Groups copy to new groups, frame membership and arrow bindings follow the copies when both ends were
 * copied (else the copy is out of the frame, or its end unbound), notes lose their creation footer, and
 * `customData.lobby` goes through `duplicateLobbyData`. Returns original id → copy id.
 */
export function duplicate(
  view: TxView,
  ids: readonly string[],
  offset: ScenePoint,
  handlers: readonly CustomDataHandlerSpec[],
): Map<string, string> {
  const roots = new Set<string>()
  for (const id of withLabels(view, ids)) {
    const el = view.get(id)
    if (el && !isLabel(el)) roots.add(id)
  }
  // a frame's children come with it
  for (const el of view.items()) if (el.frameId && roots.has(el.frameId) && !isLabel(el)) roots.add(el.id)
  const order = view.items().filter((e) => roots.has(e.id))
  const idMap = new Map<string, string>()
  for (const el of order) idMap.set(el.id, view.newId())
  const groupMap = new Map<string, string>()
  const mapGroup = (g: string) => {
    let n = groupMap.get(g)
    if (!n) {
      n = view.newId()
      groupMap.set(g, n)
    }
    return n
  }
  // frames first, so children can join the copied frame; arrows last, so their targets exist
  const rank = (e: CanvasElement) => (e.type === 'frame' ? 0 : e.type === 'arrow' ? 2 : 1)
  const sorted = [...order].sort((a, b) => rank(a) - rank(b))
  for (const el of sorted) {
    const copyId = idMap.get(el.id) as string
    const src = el as unknown as Record<string, unknown>
    const props: Record<string, unknown> = { id: copyId }
    for (const [k, v] of Object.entries(src)) if (!SKIP.has(k)) props[k] = structuredClone(v)
    props.x = el.x + offset.x
    props.y = el.y + offset.y
    props.groupIds = el.groupIds.map(mapGroup)
    props.frameId = el.frameId ? (idMap.get(el.frameId) ?? null) : null
    const lobby = duplicateLobbyData(el.customData?.lobby, idMap, handlers)
    if (lobby) props.customData = { lobby }
    if (el.type === 'arrow') {
      for (const f of ['startBinding', 'endBinding'] as const) {
        const b = src[f] as { elementId?: string } | null | undefined
        const to = b?.elementId ? idMap.get(b.elementId) : undefined
        props[f] = b && to ? { ...structuredClone(b), elementId: to } : null
      }
    }
    const kind = KIND[el.type]
    if (!kind) continue
    if (kind === 'note') {
      const label = boundOf(el)
        .map((b) => view.get(b.id))
        .find((l) => l && l.type === 'text')
      const labelId = label ? view.newId() : undefined
      view.create('note', {
        id: copyId,
        x: props.x,
        y: props.y,
        size: el.width,
        backgroundColor: src.backgroundColor,
        ...(label ? { text: String((label as { originalText?: string }).originalText ?? ''), labelId } : {}),
        ...(lobby ? { customData: { lobby } } : {}),
      })
      // the note builder takes no structure: groups and frame go on the note and its label after
      const structure: Record<string, unknown> = {}
      if (el.groupIds.length) structure.groupIds = props.groupIds
      if (props.frameId) structure.frameId = props.frameId
      if (Object.keys(structure).length) {
        view.update(copyId, structure)
        if (labelId && view.get(labelId)) view.update(labelId, structure)
      }
      continue
    }
    view.create(kind, props)
    // a shape's or an arrow's label
    const label = boundOf(el)
      .filter((b) => b.type === 'text')
      .map((b) => view.get(b.id))
      .find((l) => l && !(l as { isDeleted?: boolean }).isDeleted)
    if (label) {
      const ls = label as unknown as Record<string, unknown>
      const lp: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(ls)) if (!SKIP.has(k)) lp[k] = structuredClone(v)
      const labelId = view.newId()
      lp.id = labelId
      lp.x = label.x + offset.x
      lp.y = label.y + offset.y
      lp.containerId = copyId
      lp.groupIds = props.groupIds
      lp.frameId = props.frameId
      lp.text = String(ls.text ?? ls.originalText ?? '')
      view.create('text', lp)
      view.update(copyId, { boundElements: [{ id: labelId, type: 'text' }] })
    }
  }
  // arrows bound to copied targets: the targets list their copied arrows
  for (const el of sorted) {
    if (el.type !== 'arrow') continue
    const copyId = idMap.get(el.id) as string
    const src = el as unknown as Record<string, { elementId?: string } | null>
    for (const f of ['startBinding', 'endBinding'] as const) {
      const to = src[f]?.elementId ? idMap.get(src[f]?.elementId as string) : undefined
      if (!to) continue
      const target = view.get(to)
      const bound = boundOf(target)
      if (!bound.some((b) => b.id === copyId))
        view.update(to, { boundElements: [...bound, { id: copyId, type: 'arrow' }] })
    }
  }
  return idMap
}

/** A fresh fractional index above `top` (for callers that place one element on top). */
export const indexAbove = (top: string | null): string => generateKeyBetween(top, null)
