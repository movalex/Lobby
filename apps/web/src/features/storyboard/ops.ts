// OWNER: WS2 (wave T, storyboards). Every storyboard write, each ONE `canvas.transact` (one undo step), and only ever
// from the actor's tab (the echo rule, AGENTS.md: a tab that receives a reorder, an insert or a layout only draws it;
// nothing here runs on a remote change):
//  - create (blank, or from a script's beats or the AI's panels): the head and its panels on a grid at a free spot;
//  - insert before/after, duplicate, delete, reorder: the order keys of the panels concerned (canvas-schema
//    planning.ts panelPosBetween; a rebalance of the storyboard past 48 characters, in the same step) and the
//    re-layout of the panels whose slot changed (a frame moves with its children);
//  - a duration, the layout (`perRow` on the head) and Arrange;
//  - Make storyboard from frames: `sb:*` on the selected frames in reading order (and a frame around each selected
//    Shapes-kit storyboard panel), a head above them.
// Shot numbers are never written: every tab derives them from `sb:pos` (canvas-schema `shotNumbers`).
import { newElementId } from '@draftroom/board-ops/elements'
import {
  KANBAN_KEY,
  rebalancedPositions,
  SB_DEFAULT_DUR_MS,
  SB_DUR_KEY,
  SB_HEAD_KEY,
  SB_OF_KEY,
  SB_POS_KEY,
  type SbHeadValue,
  type Storyboard,
  type StoryboardAspect,
  TIMELINE_KEY,
} from '@draftroom/canvas-schema/planning'
import { type CanvasElement, items, type LobbyCanvas, type LobbyTx } from '../../canvas/api/index.ts'
import { spotNear } from '../ai/ported/apply.ts'
import { revealResult } from '../ai/reveal.ts'
import { type Measure, type PanelWords, type Provenance, planHead, planPanel } from './build.ts'
import {
  aroundLocked,
  gridPositions,
  HEAD_GAP,
  insertKeys,
  type KeyedSlot,
  keysAroundLocked,
  moved,
  moveKeys,
  type OrderedPanel,
  orderedOf,
  perRowOf,
} from './model.ts'

export type Sb = Storyboard<CanvasElement>

/** What the writes read of the canvas. */
export type SbCanvas = Pick<
  LobbyCanvas,
  'get' | 'items' | 'transact' | 'select' | 'readOnly' | 'isLocked' | 'index' | 'text' | 'viewport'
>

const measureOf =
  (canvas: Pick<LobbyCanvas, 'text'>): Measure =>
  (t, s) =>
    canvas.text.measure(t, s)

const live = (el: CanvasElement | undefined): el is CanvasElement =>
  !!el && !(el as { isDeleted?: boolean }).isDeleted

// ---- moving panels ----------------------------------------------------------------------------------------------

/** Every element a panel carries with it: its children (labels included) and the labels of its children. */
export function panelMembers(canvas: Pick<LobbyCanvas, 'get' | 'index'>, frameId: string): string[] {
  const out = new Set<string>()
  for (const c of canvas.index.byFrame(frameId)) {
    if (!live(c)) continue
    out.add(c.id)
    const label = items.labelOf(c, (id) => canvas.get(id))
    if (label) out.add(label.id)
  }
  out.delete(frameId)
  return [...out]
}

/** Moves a panel (its frame and everything in it) by (dx, dy) inside `tx`. A locked panel stays. */
function movePanelBy(canvas: SbCanvas, tx: LobbyTx, frameId: string, dx: number, dy: number): boolean {
  if (!dx && !dy) return false
  const frame = canvas.get(frameId)
  if (!live(frame) || frame.locked) return false
  tx.update(frameId, { x: frame.x + dx, y: frame.y + dy })
  for (const id of panelMembers(canvas, frameId)) {
    const el = canvas.get(id)
    if (!live(el)) continue
    tx.update(id, { x: el.x + dx, y: el.y + dy })
  }
  return true
}

/** The top-left the first panel of `sb` goes to: under its head, else where its panels start. */
export function layoutOrigin(canvas: Pick<LobbyCanvas, 'get'>, sb: Sb): { x: number; y: number } {
  const head = sb.head && live(canvas.get(sb.head.id)) ? (canvas.get(sb.head.id) as CanvasElement) : null
  if (head) return { x: Math.round(head.x), y: Math.round(head.y + head.height + HEAD_GAP) }
  const frames = sb.panels.map((p) => canvas.get(p.id)).filter(live)
  if (!frames.length) return { x: 0, y: 0 }
  return { x: Math.min(...frames.map((f) => f.x)), y: Math.min(...frames.map((f) => f.y)) }
}

interface Slot {
  /** an existing panel's id, or null for the one being made */
  readonly id: string | null
  readonly w: number
  readonly h: number
}

/** The grid slots of `slots` (in order) and the moves of the existing panels whose slot changed. */
function placeSlots(canvas: SbCanvas, sb: Sb, slots: readonly Slot[]): { x: number; y: number }[] {
  return gridPositions(slots, layoutOrigin(canvas, sb), perRowOf(sb.settings?.perRow))
}

function moveIntoSlots(
  canvas: SbCanvas,
  tx: LobbyTx,
  slots: readonly Slot[],
  at: readonly { x: number; y: number }[],
): void {
  slots.forEach((s, i) => {
    const to = at[i]
    if (!s.id || !to) return
    const f = canvas.get(s.id)
    if (!live(f)) return
    movePanelBy(canvas, tx, s.id, Math.round(to.x - f.x), Math.round(to.y - f.y))
  })
}

const slotOf = (canvas: Pick<LobbyCanvas, 'get'>, id: string): Slot => {
  const f = canvas.get(id)
  return { id, w: f?.width ?? 0, h: f?.height ?? 0 }
}

const setPos = (tx: LobbyTx, id: string, pos: string) =>
  tx.update(id, { customData: { lobby: { [SB_POS_KEY]: pos } } })

const aspectOf = (sb: Sb): StoryboardAspect => sb.settings?.aspect ?? '16:9'

/** The storyboard's panels as the order maths reads them, with whether each is locked (it takes no write). */
const keyedOf = (canvas: Pick<LobbyCanvas, 'isLocked'>, sb: Sb): (OrderedPanel & { locked: boolean })[] =>
  orderedOf(sb.panels).map((p) => ({ ...p, locked: canvas.isLocked(p.id) }))

interface InsertPlan {
  readonly newKey: string
  readonly rewrites: ReadonlyMap<string, string>
  /** the order after the insert (null: the new panel) */
  readonly order: readonly (string | null)[]
  /** where the new panel lands in it */
  readonly at: number
}

/**
 * The keys and the order of a new panel at `index`. With a locked panel in the storyboard, every locked panel keeps
 * its place (its index, so its slot, and its key: it takes no write) and the new one goes in among the others: it
 * lands at the first free place from `index`. Null when no key fits.
 */
function planInsert(canvas: SbCanvas, sb: Sb, index: number): InsertPlan | null {
  const keyed = keyedOf(canvas, sb)
  const at = Math.max(0, Math.min(keyed.length, index))
  if (!keyed.some((k) => k.locked)) {
    const { newKey, rewrites } = insertKeys(keyed, at)
    const order: (string | null)[] = keyed.map((k) => k.id)
    order.splice(at, 0, null)
    return { newKey, rewrites, order, at }
  }
  const fresh: KeyedSlot = { id: null, pos: '', locked: false }
  const unlocked = keyed.filter((k) => !k.locked)
  const before = keyed.slice(0, at).filter((k) => !k.locked).length
  const next = aroundLocked(keyed, (k) => k.locked, [
    ...unlocked.slice(0, before),
    fresh,
    ...unlocked.slice(before),
  ])
  const keys = keysAroundLocked(next)
  if (!keys?.newKey) return null
  return {
    newKey: keys.newKey,
    rewrites: keys.rewrites,
    order: next.map((k) => k.id),
    at: next.indexOf(fresh),
  }
}

/**
 * The keys and the order of a move of the panel at `from` to `to`. With a locked panel in the storyboard, every
 * locked panel keeps its place and key; the moved one goes to `to` among the others (onto a locked panel's place:
 * the nearest free one past it). Null when nothing changes, the panel is locked or no key fits.
 */
function planMove(
  canvas: SbCanvas,
  sb: Sb,
  from: number,
  to: number,
): { rewrites: ReadonlyMap<string, string>; order: readonly string[] } | null {
  const keyed = keyedOf(canvas, sb)
  const self = keyed[from]
  if (!self || self.locked) return null
  if (!keyed.some((k) => k.locked)) {
    const order = moved(keyed, from, to).map((k) => k.id as string)
    return { rewrites: moveKeys(keyed, from, to), order }
  }
  const unlocked = keyed.filter((k) => !k.locked)
  const others = (list: readonly KeyedSlot[]) => list.filter((k) => !k.locked && k !== self).length
  const place = to < from ? others(keyed.slice(0, to)) : others(keyed.slice(0, to + 1))
  const next = aroundLocked(keyed, (k) => k.locked, moved(unlocked, unlocked.indexOf(self), place))
  if (next.every((k, i) => k === keyed[i])) return null
  const keys = keysAroundLocked(next)
  if (!keys) return null
  return { rewrites: keys.rewrites, order: next.map((k) => k.id as string) }
}

// ---- create ----------------------------------------------------------------------------------------------------

export interface NewPanel extends PanelWords {
  readonly durationMs?: number | null
}

export interface CreateStoryboard {
  readonly title: string
  readonly aspect: StoryboardAspect
  readonly perRow?: number
  readonly defaultMs?: number
  readonly panels: readonly NewPanel[]
  /** where its top-left goes (default: a free spot near the middle of the view) */
  readonly at?: { x: number; y: number } | null
  readonly ai?: Provenance | null
  readonly label?: string
}

/** Makes a storyboard in one step; returns the head's and the panels' ids (empty when nothing was made). */
export function createStoryboard(
  canvas: SbCanvas,
  spec: CreateStoryboard,
  newId: () => string = newElementId,
): { headId: string; panelIds: string[] } | null {
  if (canvas.readOnly() || !spec.panels.length) return null
  const measure = measureOf(canvas)
  const perRow = perRowOf(spec.perRow ?? Math.min(6, spec.panels.length))
  const settings: SbHeadValue = {
    aspect: spec.aspect,
    perRow,
    ...(spec.defaultMs && spec.defaultMs !== SB_DEFAULT_DUR_MS ? { defaultMs: spec.defaultMs } : {}),
  }
  const headId = newId()
  const keys = rebalancedPositions(spec.panels.length)
  // planned at the origin first, for the sizes; then on the grid at the spot
  const dry = spec.panels.map((p) =>
    planPanel(
      { id: 'dry', headId, pos: 'a0', durationMs: 1000, aspect: spec.aspect, x: 0, y: 0, words: p },
      measure,
      () => 'dry',
    ),
  )
  const head0 = planHead({ id: headId, x: 0, y: 0, title: spec.title, settings }, measure)
  const grid0 = gridPositions(
    dry.map((d) => ({ w: d.width, h: d.height })),
    { x: 0, y: head0.height + HEAD_GAP },
    perRow,
  )
  const w = Math.max(...dry.map((d, i) => (grid0[i]?.x ?? 0) + d.width))
  const h = Math.max(...dry.map((d, i) => (grid0[i]?.y ?? 0) + d.height))
  const spot = spec.at ?? spotNear(canvas as LobbyCanvas, { w, h }, [])
  const ox = Math.round(spot.x)
  const oy = Math.round(spot.y)
  const head = planHead({ id: headId, x: ox, y: oy, title: spec.title, settings }, measure)
  const panelIds: string[] = []
  canvas.transact(spec.label ?? 'create storyboard', (tx) => {
    tx.create(head.create.kind, head.create.props)
    spec.panels.forEach((p, i) => {
      const at = grid0[i] ?? { x: 0, y: 0 }
      const planned = planPanel(
        {
          id: newId(),
          headId,
          pos: keys[i] as string,
          durationMs: p.durationMs ?? spec.defaultMs ?? SB_DEFAULT_DUR_MS,
          aspect: spec.aspect,
          x: ox + at.x,
          y: oy + at.y,
          words: p,
          ai: spec.ai ?? null,
        },
        measure,
        newId,
      )
      for (const c of planned.creates) tx.create(c.kind, c.props)
      panelIds.push(planned.id)
    })
  })
  if (!live(canvas.get(headId))) return null
  canvas.select(panelIds.slice(0, 1))
  void revealResult(canvas as LobbyCanvas, [headId, ...panelIds])
  return { headId, panelIds }
}

// ---- insert, duplicate, delete, reorder --------------------------------------------------------------------------

/** A new blank panel at `index` (0 = before the first); the following panels move one slot. Returns its id. */
export function insertPanel(
  canvas: SbCanvas,
  sb: Sb,
  index: number,
  words: NewPanel = {},
  newId: () => string = newElementId,
): string | null {
  if (canvas.readOnly()) return null
  const plan = planInsert(canvas, sb, index)
  if (!plan) return null
  const { newKey, rewrites, at } = plan
  const measure = measureOf(canvas)
  const aspect = aspectOf(sb)
  const dry = planPanel(
    { id: 'dry', headId: sb.id, pos: newKey, durationMs: 1000, aspect, x: 0, y: 0, words },
    measure,
    () => 'dry',
  )
  const slots: Slot[] = plan.order.map((pid) =>
    pid === null ? { id: null, w: dry.width, h: dry.height } : slotOf(canvas, pid),
  )
  const pos = placeSlots(canvas, sb, slots)
  const id = newId()
  canvas.transact('insert panel', (tx) => {
    for (const [pid, key] of rewrites) setPos(tx, pid, key)
    moveIntoSlots(canvas, tx, slots, pos)
    const to = pos[at] ?? { x: 0, y: 0 }
    const planned = planPanel(
      {
        id,
        headId: sb.id,
        pos: newKey,
        durationMs: words.durationMs ?? sb.settings?.defaultMs ?? SB_DEFAULT_DUR_MS,
        aspect,
        x: to.x,
        y: to.y,
        words,
      },
      measure,
      newId,
    )
    for (const c of planned.creates) tx.create(c.kind, c.props)
  })
  if (!live(canvas.get(id))) return null
  canvas.select([id])
  return id
}

/** A copy of the panel at `index` right after it (the copy joins the same storyboard). Returns the copy's id. */
export function duplicatePanel(canvas: SbCanvas, sb: Sb, index: number): string | null {
  if (canvas.readOnly()) return null
  const src = sb.panels[index]
  if (!src || !live(canvas.get(src.id))) return null
  const plan = planInsert(canvas, sb, index + 1)
  if (!plan) return null
  const { newKey, rewrites } = plan
  const srcSlot = slotOf(canvas, src.id)
  const slots: Slot[] = plan.order.map((pid) =>
    pid === null ? { id: null, w: srcSlot.w, h: srcSlot.h } : slotOf(canvas, pid),
  )
  const pos = placeSlots(canvas, sb, slots)
  const frame = canvas.get(src.id) as CanvasElement
  const to = pos[plan.at] ?? { x: frame.x, y: frame.y }
  let copy: string | null = null
  canvas.transact('duplicate panel', (tx) => {
    for (const [pid, key] of rewrites) setPos(tx, pid, key)
    moveIntoSlots(canvas, tx, slots, pos)
    const map = tx.duplicate([src.id, ...panelMembers(canvas, src.id)], {
      x: Math.round(to.x - frame.x),
      y: Math.round(to.y - frame.y),
    })
    copy = map.get(src.id) ?? null
    if (copy) setPos(tx, copy, newKey)
  })
  if (copy) canvas.select([copy])
  return copy
}

/** Deletes panels (each frame with everything in it); the rest close up. */
export function deletePanels(canvas: SbCanvas, sb: Sb, ids: readonly string[]): number {
  if (canvas.readOnly()) return 0
  const gone = new Set(ids.filter((id) => sb.panels.some((p) => p.id === id) && !canvas.isLocked(id)))
  if (!gone.size) return 0
  const rest = sb.panels.filter((p) => !gone.has(p.id))
  const slots = rest.map((p) => slotOf(canvas, p.id))
  const pos = placeSlots(canvas, sb, slots)
  canvas.transact(gone.size === 1 ? 'delete panel' : 'delete panels', (tx) => {
    for (const id of gone) {
      // a container takes its label with it
      for (const m of panelMembers(canvas, id)) {
        const el = canvas.get(m)
        if (el && !(el.type === 'text' && el.containerId)) tx.delete(m)
      }
      tx.delete(id)
    }
    moveIntoSlots(canvas, tx, slots, pos)
  })
  canvas.select([])
  return gone.size
}

/** Moves the panel at `from` to `to` (its order key, a rebalance when needed, and the re-layout): one step. */
export function movePanel(canvas: SbCanvas, sb: Sb, from: number, to: number): boolean {
  if (canvas.readOnly()) return false
  const n = sb.panels.length
  const target = Math.max(0, Math.min(n - 1, to))
  if (from === target || from < 0 || from >= n) return false
  const plan = planMove(canvas, sb, from, target)
  if (!plan) return false
  const slots = plan.order.map((id) => slotOf(canvas, id))
  const pos = placeSlots(canvas, sb, slots)
  canvas.transact('reorder panels', (tx) => {
    for (const [pid, key] of plan.rewrites) setPos(tx, pid, key)
    moveIntoSlots(canvas, tx, slots, pos)
  })
  return true
}

/** A panel's duration (ms, already in range). */
export function setDuration(canvas: SbCanvas, panelId: string, ms: number): void {
  if (canvas.readOnly()) return
  canvas.transact('panel duration', (tx) =>
    tx.update(panelId, { customData: { lobby: { [SB_DUR_KEY]: ms } } }),
  )
}

/** Lays the panels out on the grid again, with a new `perRow` when given (written on the head). */
export function arrange(canvas: SbCanvas, sb: Sb, perRow?: number): void {
  if (canvas.readOnly()) return
  const head = sb.head && live(canvas.get(sb.head.id)) ? sb.head : null
  const next = perRow === undefined ? perRowOf(sb.settings?.perRow) : perRowOf(perRow)
  const settings: SbHeadValue | null = sb.settings ? { ...sb.settings, perRow: next } : null
  const sbNext: Sb = { ...sb, settings }
  const slots = sb.panels.map((p) => slotOf(canvas, p.id))
  const pos = gridPositions(slots, layoutOrigin(canvas, sbNext), next)
  canvas.transact('arrange storyboard', (tx) => {
    if (head && settings && settings.perRow !== sb.settings?.perRow)
      tx.update(head.id, { customData: { lobby: { [SB_HEAD_KEY]: settings } } })
    moveIntoSlots(canvas, tx, slots, pos)
  })
}

// ---- Make storyboard from frames -----------------------------------------------------------------------------

/** The Shapes kits' storyboard panels (wave Q: a grouped box, not a frame), by their piece kind. */
export const KIT_PANEL_KINDS: Readonly<Record<string, StoryboardAspect>> = {
  'piece-sb-16x9': '16:9',
  'piece-sb-9x16': '9:16',
}

export interface FrameCandidates {
  /** frames that are no panel yet (and no Kanban or timeline), top level */
  readonly frames: CanvasElement[]
  /** the Shapes kits' storyboard panels on the open canvas, each as its group's elements and bounds */
  readonly kits: {
    readonly ids: string[]
    readonly x: number
    readonly y: number
    readonly w: number
    readonly h: number
    readonly aspect: StoryboardAspect
  }[]
}

/** What "Make storyboard from frames" would turn into panels from `selection`. */
export function frameCandidates(
  canvas: Pick<LobbyCanvas, 'get' | 'items'>,
  selection: readonly string[],
): FrameCandidates {
  const frames: CanvasElement[] = []
  const kits: FrameCandidates['kits'][number][] = []
  const seenGroups = new Set<string>()
  for (const id of selection) {
    const el = canvas.get(id)
    if (!live(el)) continue
    const lobby = el.customData?.lobby ?? {}
    if (el.type === 'frame') {
      // a Kanban or a timeline is never a panel too (canvas-schema planningElementProblem refuses both at once)
      if (!(SB_OF_KEY in lobby) && !(KANBAN_KEY in lobby) && !(TIMELINE_KEY in lobby) && !el.locked)
        frames.push(el)
      continue
    }
    const kind = lobby.kind
    const aspect = typeof kind === 'string' ? KIT_PANEL_KINDS[kind] : undefined
    const group = items.outerGroupOf(el)
    if (!aspect || !group || el.frameId || seenGroups.has(group)) continue
    seenGroups.add(group)
    const members = canvas.items().filter((e) => e.groupIds.includes(group) && live(e))
    if (members.some((m) => m.locked || m.frameId)) continue
    const top = members.filter((m) => !(m.type === 'text' && m.containerId))
    const xs = top.map((m) => m.x)
    const ys = top.map((m) => m.y)
    const x = Math.min(...xs)
    const y = Math.min(...ys)
    const w = Math.max(...top.map((m) => m.x + m.width)) - x
    const h = Math.max(...top.map((m) => m.y + m.height)) - y
    kits.push({ ids: members.map((m) => m.id), x, y, w, h, aspect })
  }
  return { frames, kits }
}

/** Reading order: rows (boxes whose middles share a band), left to right. */
export function readingOrder<T extends { x: number; y: number; w: number; h: number }>(
  boxes: readonly T[],
): T[] {
  const sorted = [...boxes].sort((a, b) => a.y - b.y || a.x - b.x)
  const rows: T[][] = []
  for (const b of sorted) {
    const mid = b.y + b.h / 2
    const row = rows.find((r) => {
      const first = r[0] as T
      return mid >= first.y && mid <= first.y + first.h
    })
    if (row) row.push(b)
    else rows.push([b])
  }
  return rows.flatMap((r) => r.sort((a, b) => a.x - b.x))
}

/** Turns the candidates into one storyboard (one step). Returns the head's id, or null when there is nothing. */
export function storyboardFromFrames(
  canvas: SbCanvas,
  c: FrameCandidates,
  opts: { title?: string; aspect?: StoryboardAspect } = {},
  newId: () => string = newElementId,
): string | null {
  if (canvas.readOnly()) return null
  type Box = {
    x: number
    y: number
    w: number
    h: number
    frame: string | null
    kit: FrameCandidates['kits'][number] | null
  }
  const boxes: Box[] = [
    ...c.frames.map((f) => ({ x: f.x, y: f.y, w: f.width, h: f.height, frame: f.id, kit: null })),
    ...c.kits.map((k) => ({ x: k.x, y: k.y, w: k.w, h: k.h, frame: null, kit: k })),
  ]
  if (!boxes.length) return null
  const order = readingOrder(boxes)
  const first = order[0] as Box
  const firstRow = order.filter((b) => b.y + b.h / 2 >= first.y && b.y + b.h / 2 <= first.y + first.h).length
  const aspect = opts.aspect ?? c.kits[0]?.aspect ?? '16:9'
  const settings: SbHeadValue = { aspect, perRow: perRowOf(firstRow) }
  const headId = newId()
  const measure = measureOf(canvas)
  const minX = Math.min(...order.map((b) => b.x))
  const minY = Math.min(...order.map((b) => b.y))
  const head0 = planHead({ id: headId, x: 0, y: 0, title: opts.title ?? 'Storyboard', settings }, measure)
  const head = planHead(
    {
      id: headId,
      x: Math.round(minX),
      y: Math.round(minY - head0.height - HEAD_GAP),
      title: opts.title ?? 'Storyboard',
      settings,
    },
    measure,
  )
  const keys = rebalancedPositions(order.length)
  canvas.transact('make storyboard from frames', (tx) => {
    tx.create(head.create.kind, head.create.props)
    order.forEach((b, i) => {
      const lobby = {
        [SB_OF_KEY]: headId,
        [SB_POS_KEY]: keys[i] as string,
        [SB_DUR_KEY]: SB_DEFAULT_DUR_MS,
      }
      if (b.frame) {
        tx.update(b.frame, { customData: { lobby } })
        return
      }
      const kit = b.kit
      if (!kit) return
      const frameId = newId()
      tx.create('frame', {
        id: frameId,
        x: Math.round(kit.x),
        y: Math.round(kit.y),
        width: Math.round(kit.w),
        height: Math.round(kit.h),
        name: 'Panel',
        customData: { lobby },
      })
      tx.setFrame(kit.ids, frameId)
    })
  })
  return live(canvas.get(headId)) ? headId : null
}
