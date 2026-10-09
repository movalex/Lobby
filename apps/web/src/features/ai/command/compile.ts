// OWNER: W3 (wave L, L3-3). Board command ops (@draftroom/contracts AiCommandOp, from the local grammar or
// from AI) compiled into ONE transact: one undo step, ordinary element writes the sync engine pushes and the
// server validates op by op. The geometry is the menus': align and distribute are canvas-ux align.ts's
// (unitsOf: groups move whole, a frame with what is in it, a container with its label), the grid is
// canvas-ux arrange-grid.ts's arrangeAsGrid, colours are the style panel's vocabulary, tags the tags
// feature's plan (the tag's board definition is written just before, so it travels in the same push).
// Ops run in order on a draft, so a later op sees what an earlier one moved.
//
// What is never written (each counted, so the palette can say so):
//  - a locked element (its own lock, its container's, its frame's);
//  - an element whose text another tab holds the lease on (canvas.leaseHolder): its words, layout and fit
//    are that tab's while they type;
//  - a connector bound at either end, for every op that moves or reframes: the server re-snaps its ends to
//    what it connects (a client never pushes an arrow change that only moved its bound endpoints);
//  - in 'find' mode (a viewer's AI command), every op but select and zoomTo.
// Ids that are not live elements of this board are dropped.

import { fromShapeRef } from '@draftroom/canvas-schema/refs'
import type { AiColorName, AiCommandOp } from '@draftroom/contracts'
import {
  type Bounds,
  type CanvasElement,
  geometry,
  items,
  type LobbyCanvas,
} from '../../../canvas/api/index.ts'
import { arrangeAsGrid } from '../../canvas-ux/arrange-grid.ts'
import {
  type AlignOp,
  alignDeltas,
  type Delta,
  distributeDeltas,
  type Unit,
  unitsOf,
} from '../../canvas-ux/ported/align.ts'
import { lockTargets } from '../../canvas-ux/ported/commands.ts'
import { lockedInCanvas } from '../../canvas-ux/ported/navigation/model.ts'
import { isPolygonLine } from '../../canvas-ux/ported/polygons.ts'
import {
  type ColorName,
  fillNameOf,
  HIGHLIGHT_SHADES,
  noteFillOf,
  SHADES,
  shapeFields,
} from '../../canvas-ux/ported/style-vocabulary.ts'
import { boardTagRows, boardTagsOf, isTaggable, planSetTag } from '../../tags/ported/model.ts'
import { resolveTypedTag } from '../../tags/tag-core.ts'
import type { AiPreviewPlan } from '../ported/public.ts'

export type CommandMode = 'find' | 'do'

export interface CommandSkips {
  /** locked (or inside a locked frame) */
  readonly locked: number
  /** another tab holds its text lease */
  readonly leased: number
  /** a connector bound at either end, left to the server's re-snap */
  readonly bound: number
  /** write ops dropped in 'find' mode */
  readonly refused: number
}

export interface NewFrame {
  readonly props: { x: number; y: number; width: number; height: number; name: string }
  /** the items it holds (their labels follow in setFrame) */
  readonly members: readonly string[]
}

export interface CompiledCommand {
  /** what to select afterwards (null: leave the selection) */
  readonly select: readonly string[] | null
  /** what to bring into view afterwards (null: leave the camera) */
  readonly zoom: readonly string[] | null
  /** element id → its fields, written in the one transact */
  readonly updates: ReadonlyMap<string, Readonly<Record<string, unknown>>>
  readonly frames: readonly NewFrame[]
  /** lb_doc keys the tags need (written just before the transact, so they go in the same push) */
  readonly doc: Readonly<Record<string, unknown>>
  readonly skipped: CommandSkips
  /** the items it changes (roots: containers, not their labels) */
  readonly changed: readonly string[]
  /** a tag that could not be made (a bad name, a full board), in words */
  readonly problems: readonly string[]
  /** what the shared preview draws */
  readonly preview: Pick<AiPreviewPlan, 'moves' | 'recolors' | 'creates'>
}

/** Whether a compiled command writes anything. */
export const writesAnything = (c: CompiledCommand): boolean =>
  c.updates.size > 0 || c.frames.length > 0 || Object.keys(c.doc).length > 0

const FIND_OPS: ReadonlySet<AiCommandOp['op']> = new Set(['select', 'zoomTo'])
/** A new frame's margin around what it holds. */
export const FRAME_PADDING = 40

const live = (el: CanvasElement | undefined): el is CanvasElement =>
  !!el && !(el as { isDeleted?: boolean }).isDeleted
const round2 = (v: number) => Math.round(v * 100) / 100

/** A connector bound at either end (it follows what it connects). */
export function boundConnector(el: CanvasElement): boolean {
  if (el.type !== 'arrow') return false
  const ends = items.arrowEnds(el)
  return ends.start !== null || ends.end !== null
}

const ALIGN: Readonly<Record<string, AlignOp>> = {
  left: 'left',
  center: 'center-horizontal',
  right: 'right',
  top: 'top',
  middle: 'center-vertical',
  bottom: 'bottom',
}

type CommandCanvas = Pick<
  LobbyCanvas,
  'get' | 'items' | 'bounds' | 'isLocked' | 'isHidden' | 'leaseHolder' | 'doc' | 'engine'
>

/**
 * The ops as writes. `selfSid`: this tab's session (default: the engine's); a lease held by any other
 * session keeps its element out.
 */
export function compileCommand(
  canvas: CommandCanvas,
  ops: readonly AiCommandOp[],
  mode: CommandMode,
  opts: { selfSid?: string | null } = {},
): CompiledCommand {
  const selfSid = opts.selfSid !== undefined ? opts.selfSid : (canvas.engine?.welcome?.sid ?? null)
  const get = (id: string) => canvas.get(id)
  const all = canvas.items()
  const skips = { locked: new Set<string>(), leased: new Set<string>(), bound: new Set<string>(), refused: 0 }
  const updates = new Map<string, Record<string, unknown>>()
  const frames: NewFrame[] = []
  const doc: Record<string, unknown> = {}
  const changed = new Set<string>()
  const problems: string[] = []
  const recolors = new Map<string, string>()
  let select: Set<string> | null = null
  let zoom: Set<string> | null = null

  // the draft: every element's move so far
  const moved = new Map<string, Delta>()
  const draft = {
    get: (id: string) => {
      const el = canvas.get(id)
      const d = el ? moved.get(id) : undefined
      return el && d ? ({ ...el, x: el.x + d.dx, y: el.y + d.dy } as CanvasElement) : el
    },
    bounds: (id: string): Bounds | null => {
      const b = canvas.bounds(id)
      const d = moved.get(id)
      return b && d ? { ...b, x: b.x + d.dx, y: b.y + d.dy } : b
    },
    isLocked: (id: string) => canvas.isLocked(id),
  }
  const put = (id: string, fields: Record<string, unknown>) => {
    const prev = updates.get(id) ?? {}
    const lobby = {
      ...((prev.customData as { lobby?: object } | undefined)?.lobby ?? {}),
      ...((fields.customData as { lobby?: object } | undefined)?.lobby ?? {}),
    }
    const next = { ...prev, ...fields }
    if (Object.keys(lobby).length) next.customData = { lobby }
    updates.set(id, next)
  }

  const heldElsewhere = (id: string): boolean => {
    const holder = canvas.leaseHolder(id)
    return !!holder && holder.sid !== selfSid
  }
  const leased = (el: CanvasElement): boolean => {
    if (heldElsewhere(el.id)) return true
    const label = items.labelOf(el, get)
    return !!label && heldElsewhere(label.id)
  }

  /** The live, shown items an op names (labels as their containers), de-duplicated. */
  const rootsOf = (refs: readonly string[]): CanvasElement[] => {
    const out = new Map<string, CanvasElement>()
    for (const ref of refs) {
      const id = fromShapeRef(ref)
      const el = id ? canvas.get(id) : undefined
      if (!live(el)) continue
      const root = items.containerOf(el, get)
      if (live(root) && !canvas.isHidden(root.id)) out.set(root.id, root)
    }
    return [...out.values()]
  }
  /** The roots a write may touch: not locked, not leased elsewhere, and (for moves) not a bound connector. */
  const writable = (roots: readonly CanvasElement[], moving: boolean): CanvasElement[] =>
    roots.filter((el) => {
      if (lockedInCanvas(el, get)) {
        skips.locked.add(el.id)
        return false
      }
      if (leased(el)) {
        skips.leased.add(el.id)
        return false
      }
      if (moving && boundConnector(el)) {
        skips.bound.add(el.id)
        return false
      }
      return true
    })

  /** Moves a unit's elements in the draft (labels and a frame's children with them; never a locked one). */
  const moveUnitsDraft = (units: readonly Unit[], deltas: ReadonlyMap<string, Delta>) => {
    const once = new Set<string>()
    const move = (id: string, d: Delta) => {
      if (once.has(id)) return
      const el = canvas.get(id)
      if (!live(el) || el.locked) return
      if (boundConnector(el)) {
        skips.bound.add(el.id)
        return
      }
      if (heldElsewhere(el.id)) {
        skips.leased.add(el.id)
        return
      }
      once.add(id)
      const prev = moved.get(id) ?? { dx: 0, dy: 0 }
      moved.set(id, { dx: prev.dx + d.dx, dy: prev.dy + d.dy })
      if (!(el.type === 'text' && el.containerId)) changed.add(id)
      const label = items.labelOf(el, get)
      if (label) move(label.id, d)
      if (el.type === 'frame') for (const c of items.childrenOf(el.id, all)) move(c, d)
    }
    for (const u of units) {
      const d = deltas.get(u.id)
      if (!d || (!d.dx && !d.dy)) continue
      for (const m of u.members) move(m, d)
    }
  }

  const recolor = (el: CanvasElement, name: AiColorName) => {
    const c = SHADES[name as ColorName]
    const e = el as { backgroundColor?: string; strokeColor?: string; fillStyle?: string }
    const kind = isPolygonLine(el) ? 'shape' : items.itemKindOf(el)
    let fields: Record<string, unknown> | null = null
    if (kind === 'note') {
      const fill = noteFillOf(name)
      if (e.backgroundColor !== fill) fields = { backgroundColor: fill }
    } else if (kind === 'shape') {
      const fill = fillNameOf(e.backgroundColor, e.fillStyle)
      const f = shapeFields(name as ColorName, fill ?? 'none')
      const next: Record<string, unknown> =
        fill && fill !== 'none'
          ? { strokeColor: f.strokeColor, backgroundColor: f.backgroundColor }
          : { strokeColor: c.solid }
      fields = Object.fromEntries(
        Object.entries(next).filter(([k, v]) => (e as Record<string, unknown>)[k] !== v),
      )
    } else if (
      kind === 'text' ||
      kind === 'arrow' ||
      kind === 'line' ||
      kind === 'draw' ||
      kind === 'highlight'
    ) {
      const stroke = kind === 'highlight' ? HIGHLIGHT_SHADES[name as ColorName] : c.solid
      if (e.strokeColor !== stroke) fields = { strokeColor: stroke }
    }
    if (fields && Object.keys(fields).length) {
      put(el.id, fields)
      changed.add(el.id)
      recolors.set(el.id, name)
    }
  }

  for (const op of ops) {
    if (mode === 'find' && !FIND_OPS.has(op.op)) {
      skips.refused++
      continue
    }
    const roots = rootsOf(op.ids)
    if (!roots.length) continue
    switch (op.op) {
      case 'select':
        select = new Set([...(select ?? []), ...roots.map((r) => r.id)])
        break
      case 'zoomTo':
        zoom = new Set([...(zoom ?? []), ...roots.map((r) => r.id)])
        break
      case 'recolor':
        for (const el of writable(roots, false)) recolor(el, op.color)
        break
      case 'setFill': {
        for (const el of writable(roots, false)) {
          if (
            !(el.type === 'rectangle' || el.type === 'ellipse' || el.type === 'diamond' || isPolygonLine(el))
          )
            continue
          const e = el as { strokeColor?: string; backgroundColor?: string; fillStyle?: string }
          const name =
            (Object.keys(SHADES) as ColorName[]).find((n) => SHADES[n].solid === e.strokeColor) ?? 'black'
          const f = shapeFields(name, op.fill === 'solid' ? 'solid' : 'pattern')
          const next = { backgroundColor: f.backgroundColor, fillStyle: op.fill }
          if (e.backgroundColor === next.backgroundColor && e.fillStyle === next.fillStyle) continue
          put(el.id, next)
          changed.add(el.id)
        }
        break
      }
      case 'lock': {
        const targets = writable(
          roots.filter((r) => !r.locked),
          false,
        )
        for (const id of lockTargets(canvas as unknown as LobbyCanvas, targets)) {
          const el = canvas.get(id)
          if (!live(el) || el.locked || heldElsewhere(id)) continue
          put(id, { locked: true })
          if (!(el.type === 'text' && el.containerId)) changed.add(id)
        }
        break
      }
      case 'tag': {
        const targets = writable(roots, false).filter((el) => isTaggable(el))
        if (!targets.length) break
        const board = boardTagsOf(canvas.doc.entries('tagDef:'))
        const resolved = resolveTypedTag(boardTagRows(board, all), op.tag)
        if (!resolved.ok) {
          problems.push(resolved.error)
          break
        }
        const tag = resolved.value.tag
        const plan = planSetTag(targets, tag, true, board.has(tag.key) || tag.key in doc, (el) =>
          lockedInCanvas(el, get),
        )
        Object.assign(doc, plan.doc)
        for (const p of plan.elements) {
          put(p.id, { customData: { lobby: p.lobby } })
          changed.add(p.id)
        }
        if (plan.full) problems.push(`${plan.full} already had the most tags an item can have.`)
        break
      }
      case 'align':
      case 'distribute': {
        const ids = writable(roots, true).map((r) => r.id)
        const units = unitsOf(draft, ids)
        const deltas =
          op.op === 'align' ? alignDeltas(units, ALIGN[op.edge] as AlignOp) : distributeDeltas(units, op.axis)
        moveUnitsDraft(units, deltas)
        break
      }
      case 'arrangeGrid': {
        const ids = writable(roots, true).map((r) => r.id)
        const units = unitsOf(draft, ids)
        if (units.length < 2) break
        // the grid stays in the frame every unit shares (as Arrange as grid does), else on the board
        const frameIds = new Set(units.map((u) => draft.get(u.members[0] as string)?.frameId ?? null))
        const shared = frameIds.size === 1 ? ([...frameIds][0] ?? null) : null
        const frameEl = shared ? draft.get(shared) : undefined
        const frameOk = !!frameEl && !lockedInCanvas(frameEl, get) && !leased(frameEl)
        const origin = frameEl && frameOk ? { x: frameEl.x, y: frameEl.y } : { x: 0, y: 0 }
        const plan = arrangeAsGrid({
          items: units.map((u) => ({
            id: u.id,
            x: u.bounds.x - origin.x,
            y: u.bounds.y - origin.y,
            w: u.bounds.width,
            h: u.bounds.height,
          })),
          ...(frameEl && frameOk ? { frame: { w: frameEl.width, h: frameEl.height } } : {}),
        })
        if (!plan) break
        const deltas = new Map<string, Delta>()
        for (const u of units) {
          const to = plan.positions[u.id]
          if (to) deltas.set(u.id, { dx: to.x + origin.x - u.bounds.x, dy: to.y + origin.y - u.bounds.y })
        }
        moveUnitsDraft(units, deltas)
        if (plan.frameSize && frameEl && frameOk) {
          put(frameEl.id, { width: plan.frameSize.w, height: plan.frameSize.h })
          changed.add(frameEl.id)
        }
        break
      }
      case 'wrapInFrame': {
        const members = writable(
          roots.filter((r) => r.type !== 'frame'),
          true,
        )
        const box = geometry.union(members.map((m) => draft.bounds(m.id)))
        if (!members.length || !box) break
        frames.push({
          props: {
            x: round2(box.x - FRAME_PADDING),
            y: round2(box.y - FRAME_PADDING),
            width: round2(box.width + FRAME_PADDING * 2),
            height: round2(box.height + FRAME_PADDING * 2),
            name: op.name,
          },
          members: members.map((m) => m.id),
        })
        for (const m of members) changed.add(m.id)
        break
      }
    }
  }

  // the moves as writes (rounded as the server keeps coordinates)
  const moves: { id: string; x: number; y: number }[] = []
  for (const [id, d] of moved) {
    const el = canvas.get(id)
    if (!el || (!d.dx && !d.dy)) continue
    put(id, { x: round2(el.x + d.dx), y: round2(el.y + d.dy) })
    if (!(el.type === 'text' && el.containerId))
      moves.push({ id, x: round2(el.x + d.dx), y: round2(el.y + d.dy) })
  }
  const roots = [...changed].filter((id) => {
    const el = canvas.get(id)
    return !!el && !(el.type === 'text' && el.containerId)
  })
  return {
    select: select ? [...select] : null,
    zoom: zoom ? [...zoom] : null,
    updates,
    frames,
    doc,
    skipped: {
      locked: skips.locked.size,
      leased: skips.leased.size,
      bound: skips.bound.size,
      refused: skips.refused,
    },
    changed: roots,
    problems,
    preview: {
      moves,
      recolors: [...recolors].map(([id, to]) => ({ id, to })),
      creates: frames.map((f) => ({
        x: f.props.x,
        y: f.props.y,
        w: f.props.width,
        h: f.props.height,
        kind: 'frame',
      })),
    },
  }
}

/**
 * Writes a compiled command: the tags' board definitions first (the same push), then everything else as
 * ONE transact (one undo step). Returns the new frames' ids.
 */
export function applyCompiled(
  canvas: Pick<LobbyCanvas, 'transact' | 'doc' | 'readOnly'>,
  compiled: CompiledCommand,
  label: string,
): string[] {
  if (canvas.readOnly() || !writesAnything(compiled)) return []
  if (Object.keys(compiled.doc).length) canvas.doc.set(compiled.doc)
  if (!compiled.updates.size && !compiled.frames.length) return []
  return canvas.transact(label, (tx) => {
    const made: string[] = []
    for (const f of compiled.frames) {
      const id = tx.create('frame', f.props)
      tx.setFrame(f.members, id)
      // behind what it holds, as a frame drawn first would be
      tx.reorder([id], 'back')
      made.push(id)
    }
    for (const [id, patch] of compiled.updates) tx.update(id, patch)
    return made
  })
}

/** The toast line that names what was left alone, or null. */
export function skipsText(s: CommandSkips): string | null {
  const parts: string[] = []
  const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`
  if (s.locked) parts.push(n(s.locked, 'locked item was left as it is', 'locked items were left as they are'))
  if (s.leased)
    parts.push(`${n(s.leased, 'item someone is typing in was', 'items someone is typing in were')} skipped`)
  if (s.bound)
    parts.push(
      `${n(s.bound, 'connector follows', 'connectors follow')} what ${s.bound === 1 ? 'it connects' : 'they connect'}`,
    )
  if (s.refused)
    parts.push(
      `${n(s.refused, 'change was', 'changes were')} left out: you can view this board, not change it`,
    )
  if (!parts.length) return null
  const text = parts.join('; ')
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`
}
