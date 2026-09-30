// MAK-18 "Arrange as grid" on the new canvas (the layout rules are the tldraw build's, arrange-grid.ts).
// One undo step per arrangement (and per column change from the stepper); ordinary element updates, so
// collaborators see the result through sync like any move.
//
// What moves, as on the tldraw board: the selected items, minus locked ones (or ones inside a locked
// frame), minus connectors bound at either end (the server re-snaps them to what they connect), minus
// items whose frame is selected too (they move with it). A grouped item moves as its whole outermost
// group; a frame moves with its children. Excalidraw keeps structure in fields, not parents, so a unit's
// move is written to every element of it (bound labels included). The grid lives in the frame every unit
// shares; when they sit in different frames (or some in none), on the board, and they leave their frames.
import {
  type Bounds,
  type CanvasElement,
  type CanvasFeatureContext,
  geometry,
  items,
  type LobbyCanvas,
  type LobbyTx,
} from '../../../../canvas/api/index.ts'
import { arrangeAsGrid, type GridItem } from '../../arrange-grid.ts'
import { lockedInCanvas } from './model.ts'
import { type GridSession, gridSession } from './state.ts'

const sortedIds = (ids: readonly string[]) => [...ids].sort()

/** A connector bound at either end: it follows the elements it connects. */
function followsBindings(el: CanvasElement): boolean {
  if (el.type !== 'arrow') return false
  const ends = items.arrowEnds(el)
  return ends.start !== null || ends.end !== null
}

/** The element ids the canvas's selection stands for (a bound label is its container), de-duplicated. */
function selectedRoots(canvas: LobbyCanvas): CanvasElement[] {
  const out = new Map<string, CanvasElement>()
  for (const id of canvas.selection) {
    const el = canvas.get(id)
    if (!el || el.isDeleted) continue
    const root = items.containerOf(el, (x) => canvas.get(x))
    if (!root.isDeleted) out.set(root.id, root)
  }
  return [...out.values()]
}

export interface ArrangeableSelection {
  readonly elements: CanvasElement[]
  /** selected items that stay where they are because they (or their frame) are locked */
  readonly locked: number
}

/**
 * The selected items "Arrange as grid" moves (reactive: fine inside useValue). With `stopAt`, stops once
 * that many movable items are found (the selection bar only needs "two or more").
 */
export function arrangeableSelection(
  canvas: LobbyCanvas,
  stopAt = Number.POSITIVE_INFINITY,
): ArrangeableSelection {
  const roots = selectedRoots(canvas)
  const selected = new Set(roots.map((e) => e.id))
  const elements: CanvasElement[] = []
  let locked = 0
  const get = (id: string) => canvas.get(id)
  for (const el of roots) {
    if (elements.length >= stopAt) break
    if (el.frameId && selected.has(el.frameId)) continue
    if (lockedInCanvas(el, get)) {
      locked++
      continue
    }
    if (followsBindings(el)) continue
    elements.push(el)
  }
  return { elements, locked }
}

/** At least two units (items, or outermost groups) of the selection can be arranged. */
export function hasArrangeable(canvas: LobbyCanvas): boolean {
  const keys = new Set<string>()
  for (const el of arrangeableSelection(canvas).elements) {
    keys.add(items.outerGroupOf(el) ?? el.id)
    if (keys.size >= 2) return true
  }
  return false
}

export function canArrangeAsGrid(canvas: LobbyCanvas): boolean {
  return !canvas.readOnly() && hasArrangeable(canvas)
}

/** One thing the grid places: an item, or an outermost group; with every element that moves with it. */
interface Unit {
  /** the element id, or the group id */
  readonly key: string
  /** the element ids that move (group members, a frame's children, bound labels) */
  readonly members: readonly string[]
  /** the unit's frame (null on the board) */
  readonly frameId: string | null
  readonly bounds: Bounds
}

/** The unit `el` belongs to (its outermost group, else itself), with everything that moves with it. */
function unitOf(canvas: LobbyCanvas, el: CanvasElement, all: readonly CanvasElement[]): Unit {
  const group = items.outerGroupOf(el)
  const heads = group ? all.filter((e) => e.groupIds.includes(group)) : [el]
  const members = new Set<string>()
  const add = (e: CanvasElement) => {
    members.add(e.id)
    const label = items.labelOf(e, (x) => canvas.get(x))
    if (label) members.add(label.id)
  }
  for (const h of heads) {
    add(h)
    if (h.type === 'frame') for (const c of all) if (c.frameId === h.id) add(c)
  }
  const bounds = geometry.union(heads.map((h) => canvas.bounds(h.id))) ?? {
    x: el.x,
    y: el.y,
    width: 0,
    height: 0,
  }
  return { key: group ?? el.id, members: [...members], frameId: el.frameId, bounds }
}

/** Scene coordinates as the server keeps a line's or an arrow's (canvas-schema limits.ts: 2 decimals). */
const round2 = (v: number) => Math.round(v * 100) / 100

/** Moves every element of a unit by (dx, dy) in the caller's step. */
export function moveUnit(
  tx: LobbyTx,
  canvas: LobbyCanvas,
  members: readonly string[],
  dx: number,
  dy: number,
): void {
  if (!dx && !dy) return
  for (const id of members) {
    const e = canvas.get(id)
    if (e) tx.update(id, { x: round2(e.x + dx), y: round2(e.y + dy) })
  }
}

const gridItemOf = (u: Unit, origin: { x: number; y: number }): GridItem => ({
  id: u.key,
  x: u.bounds.x - origin.x,
  y: u.bounds.y - origin.y,
  w: u.bounds.width,
  h: u.bounds.height,
})

/** The stepper's session when it still describes the current selection and nothing has moved since. */
export function currentGridSession(canvas: LobbyCanvas): GridSession | null {
  const s = gridSession(canvas).get()
  if (!s) return null
  const selection = sortedIds(canvas.selection)
  if (selection.length !== s.selection.length || selection.some((id, i) => id !== s.selection[i])) return null
  for (const [id, p] of Object.entries(s.placed)) {
    const el = canvas.get(id)
    if (!el || el.isDeleted || el.x !== p.x || el.y !== p.y) return null
  }
  return s
}

export interface ArrangeOutcome {
  readonly moved: number
  readonly columns: number
  readonly rows: number
  readonly frameGrew: boolean
  readonly locked: number
  /** F2-03: neighbours moved down to make room for the grid */
  readonly pushed: number
}

/**
 * Arranges the selection as a grid. `columns` = an explicit count (the stepper): it keeps the fill order
 * of the grid being adjusted. Null when there is nothing to arrange (fewer than two movable units, or a
 * read-only board).
 */
export function arrangeSelectionAsGrid(
  canvas: LobbyCanvas,
  opts: { columns?: number } = {},
): ArrangeOutcome | null {
  if (canvas.readOnly()) return null
  const { elements, locked } = arrangeableSelection(canvas)
  if (elements.length < 2) return null
  const session = opts.columns !== undefined ? currentGridSession(canvas) : null
  const selection = sortedIds(canvas.selection)
  const all = items.contentItems(canvas.items())
  const units = new Map<string, Unit>()
  for (const el of elements) {
    const u = unitOf(canvas, el, all)
    if (!units.has(u.key)) units.set(u.key, u)
  }
  const list = [...units.values()]
  if (list.length < 2) return null

  // the grid's frame: the one every unit shares, else the board (units leave their frames)
  const first = list[0]?.frameId ?? null
  const frameId = list.every((u) => u.frameId === first) ? first : null
  const frameEl = frameId ? canvas.get(frameId) : undefined
  const origin = frameEl ? { x: frameEl.x, y: frameEl.y } : { x: 0, y: 0 }
  const moving = new Set(list.flatMap((u) => u.members))
  // F2-03: the other units on the board, which the grid should not grow over (none inside a frame)
  const neighbours: Unit[] = []
  if (!frameEl) {
    const seen = new Set<string>()
    for (const e of all) {
      if (e.frameId || moving.has(e.id) || canvas.isHidden(e.id) || followsBindings(e)) continue
      const u = unitOf(canvas, e, all)
      if (seen.has(u.key) || u.members.some((m) => moving.has(m))) continue
      seen.add(u.key)
      neighbours.push(u)
    }
  }
  const plan = arrangeAsGrid({
    items: list.map((u) => gridItemOf(u, origin)),
    columns: opts.columns,
    order: session?.order,
    frame: frameEl ? { w: frameEl.width, h: frameEl.height } : undefined,
    obstacles: neighbours.map((u) => gridItemOf(u, origin)),
  })
  if (!plan) return null

  let pushed = 0
  canvas.transact('arrange as grid', (tx) => {
    for (const u of list) {
      if (!frameEl && u.frameId) tx.setFrame(u.members, null)
      const to = plan.positions[u.key]
      if (to) moveUnit(tx, canvas, u.members, to.x + origin.x - u.bounds.x, to.y + origin.y - u.bounds.y)
    }
    for (const u of neighbours) {
      const to = plan.pushed?.[u.key]
      if (!to || u.members.some((m) => lockedInCanvas(canvas.get(m) as CanvasElement, (x) => canvas.get(x))))
        continue
      moveUnit(tx, canvas, u.members, to.x + origin.x - u.bounds.x, to.y + origin.y - u.bounds.y)
      pushed++
    }
    if (plan.frameSize && frameEl)
      tx.update(frameEl.id, { width: plan.frameSize.w, height: plan.frameSize.h })
  })
  // what each arranged unit's elements hold now: any later move (by anyone) ends the stepper's session
  const placed: Record<string, { x: number; y: number }> = {}
  for (const u of list) {
    for (const id of u.members) {
      const e = canvas.get(id)
      if (e) placed[id] = { x: e.x, y: e.y }
    }
  }
  gridSession(canvas).set({ selection, order: plan.order, columns: plan.columns, placed })
  return {
    moved: list.length,
    columns: plan.columns,
    rows: plan.rows,
    frameGrew: !!plan.frameSize,
    locked,
    pushed,
  }
}

/** The shortcut / menu / selection-bar entry point: arranges, then says what needs saying. */
export function runArrangeAsGrid(
  ctx: CanvasFeatureContext,
  opts: { columns?: number } = {},
): ArrangeOutcome | null {
  const { canvas } = ctx
  const outcome = arrangeSelectionAsGrid(canvas, opts)
  if (!outcome) {
    if (!canvas.readOnly() && canvas.selection.length > 0) {
      ctx.notify({
        key: 'arrange-grid',
        text: 'Select at least two unlocked objects to arrange them as a grid.',
        testId: 'arrange-grid-notice',
        timeoutMs: 4000,
      })
    }
    return null
  }
  const notes: string[] = []
  if (outcome.frameGrew) notes.push('The frame grew to fit the grid.')
  if (outcome.pushed) {
    notes.push(
      outcome.pushed === 1
        ? 'One object below moved down to make room.'
        : `${outcome.pushed} objects below moved down to make room.`,
    )
  }
  if (outcome.locked) {
    notes.push(
      outcome.locked === 1
        ? 'One locked object stayed where it was.'
        : `${outcome.locked} locked objects stayed where they were.`,
    )
  }
  if (notes.length) {
    ctx.notify({ key: 'arrange-grid', text: notes.join(' '), testId: 'arrange-grid-notice', timeoutMs: 5000 })
  } else ctx.dismiss('arrange-grid')
  return outcome
}
