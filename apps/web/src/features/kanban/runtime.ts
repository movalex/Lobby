// OWNER: WS4 (wave T; docs/WAVE-T-CONTRACTS.md §2, §6.2). The Kanban drop: when THIS person moves a card (or a note
// or a rectangle) into or within a Kanban's column, the card's position (snapped into the column, kept under the
// header) and its status (the column's) are written as part of the same undo step as the move (`joinPrevious`), so
// one Ctrl+Z takes back both. A plain note or rectangle dropped into a Kanban becomes a card of that column.
//
// The echo rule (AGENTS.md): only the acting tab writes. A change from the server (someone else's move, a rev-13
// tab's move that could not write a status) or from this tab's own undo/redo only updates what this runtime has
// seen, and writes nothing: a reader never infers a status from a position, it shows the mismatch (and Tidy).
// A card that moved only because its frame moved (the whole Kanban dragged) is not a drop: its place in the frame
// did not change. Nothing is written while a gesture or a text editor is still open (the write would cut the
// person's step in two); the gate writes once they are over.
import { cardOf, type PlanningElement } from '@draftroom/canvas-schema/planning'
import type { CanvasChange, CanvasElement, LobbyCanvas } from '../../canvas/api/index.ts'
import { react, untracked } from '../../lib/signals.ts'
import { isCardable, lobbyPatch, makeCardLobby } from '../cards/model.ts'
import { dropPlacement } from './layout.ts'
import { kanbanAt, kanbanUnder, rectOf } from './scene.ts'

export type RuntimeCanvas = Pick<
  LobbyCanvas,
  'get' | 'index' | 'transact' | 'isLocked' | 'on' | 'gesture' | 'editingId'
>

export interface KanbanRuntimeOptions {
  /** Kanban writes are offered now (the switch, a rev-14 room, not read-only) */
  readonly kanbanOffered: () => boolean
  /** cards may be made now (a plain note dropped in a Kanban becomes one) */
  readonly cardsOffered: () => boolean
}

interface Seen {
  readonly frameId: string | null
  /** where the element is on the board */
  readonly x: number
  readonly y: number
  /** its place in its frame (relative to the frame's top-left; the board position without a frame) */
  readonly rx: number
  readonly ry: number
}

const near = (a: number, b: number) => Math.abs(a - b) < 0.5
const live = (el: CanvasElement | undefined): el is CanvasElement =>
  !!el && !(el as { isDeleted?: boolean }).isDeleted

export class KanbanRuntime {
  private readonly seen = new Map<string, Seen>()
  private readonly dirty = new Set<string>()
  private queued = false
  private disposed = false
  private readonly disposers: (() => void)[] = []

  private readonly canvas: RuntimeCanvas
  private readonly opts: KanbanRuntimeOptions

  constructor(canvas: RuntimeCanvas, opts: KanbanRuntimeOptions) {
    this.canvas = canvas
    this.opts = opts
  }

  start(): () => void {
    untracked(() => {
      for (const el of [...this.canvas.index.notes(), ...this.canvas.index.byType('rectangle')])
        this.remember(el)
    })
    this.disposers.push(
      this.canvas.on('change', (c) => this.onChange(c)),
      // the gate: a drop waiting for a gesture or an editor is written once they are over
      react('kanban.drop-gate', () => {
        const blocked = this.blocked()
        if (!blocked && untracked(() => this.dirty.size > 0)) this.schedule()
      }),
    )
    return () => this.dispose()
  }

  dispose() {
    this.disposed = true
    for (const d of this.disposers.splice(0)) d()
    this.dirty.clear()
  }

  private place(el: CanvasElement): Seen {
    const frame = el.frameId ? this.canvas.get(el.frameId) : undefined
    return frame
      ? { frameId: el.frameId, x: el.x, y: el.y, rx: el.x - frame.x, ry: el.y - frame.y }
      : { frameId: el.frameId ?? null, x: el.x, y: el.y, rx: el.x, ry: el.y }
  }

  private remember(el: CanvasElement | undefined): Seen | null {
    if (!live(el) || !isCardable(el)) return null
    const s = this.place(el)
    this.seen.set(el.id, s)
    return s
  }

  /** @internal (tests) the changes a batch made this runtime want to look at */
  onChange(c: CanvasChange): void {
    if (this.disposed) return
    untracked(() => {
      const local = c.source === 'local'
      for (const id of [...c.created, ...c.updated]) {
        const el = this.canvas.get(id)
        if (!live(el) || !isCardable(el)) {
          this.seen.delete(id)
          continue
        }
        const before = this.seen.get(id)
        const now = this.remember(el)
        if (!local || !now) continue
        // moved on the board AND in its frame: a drag of the card (a dragged frame moves its cards on the board only,
        // a frame resized from its left edge moves them in the frame only: neither is a drop)
        const moved = !near(before?.x ?? Number.NaN, now.x) || !near(before?.y ?? Number.NaN, now.y)
        const inFrame = !near(before?.rx ?? Number.NaN, now.rx) || !near(before?.ry ?? Number.NaN, now.ry)
        if (!before || before.frameId !== now.frameId || (moved && inFrame)) this.dirty.add(id)
      }
      for (const id of c.deleted) {
        this.seen.delete(id)
        this.dirty.delete(id)
      }
    })
    if (this.dirty.size) this.schedule()
  }

  /** This tab is in the middle of a gesture or typing: a write now would cut it into two undo steps. */
  private blocked(): boolean {
    const g = this.canvas.gesture()
    return (g !== 'idle' && g !== 'tool') || this.canvas.editingId() !== null
  }

  private schedule() {
    if (this.queued || this.disposed) return
    this.queued = true
    queueMicrotask(() => {
      this.queued = false
      if (this.disposed || untracked(() => this.blocked())) return
      this.flush()
    })
  }

  /** @internal (tests) writes the drops waiting, as part of this person's last step */
  flush(): void {
    const ids = [...this.dirty]
    this.dirty.clear()
    if (!ids.length || !this.opts.kanbanOffered()) return
    const writes = untracked(() => this.plan(ids))
    if (!writes.length) return
    this.canvas.transact(
      'kanban: drop',
      (tx) => {
        for (const w of writes) {
          if (w.frameId) tx.setFrame([w.id], w.frameId)
          tx.update(w.id, { x: w.x, y: w.y, ...(w.lobby ? lobbyPatch(w.lobby) : {}) })
        }
      },
      { joinPrevious: true },
    )
  }

  private plan(ids: readonly string[]) {
    const out: {
      id: string
      x: number
      y: number
      frameId: string | null
      lobby: Record<string, unknown> | null
    }[] = []
    for (const id of ids) {
      const el = this.canvas.get(id)
      if (!live(el) || !isCardable(el) || this.canvas.isLocked(id)) continue
      let k = kanbanAt(this.canvas, el.frameId)
      let join: string | null = null
      if (!k && !el.frameId) {
        // dropped onto a Kanban the engine did not put it in: its centre inside the frame joins it
        k = kanbanUnder(this.canvas, { x: el.x + el.width / 2, y: el.y + el.height / 2 })
        join = k?.el.id ?? null
      }
      if (!k || this.canvas.isLocked(k.el.id)) continue
      const drop = dropPlacement(rectOf(k.el), k.value, el)
      if (!drop) continue
      const card = cardOf(el as PlanningElement)
      if (!card && !this.opts.cardsOffered()) continue
      const lobby = !card
        ? makeCardLobby(drop.status)
        : card.status !== drop.status
          ? { 'card:status': drop.status }
          : null
      const moves = !near(el.x, drop.at.x) || !near(el.y, drop.at.y)
      if (!lobby && !moves && !join) continue
      out.push({ id, x: drop.at.x, y: drop.at.y, frameId: join, lobby })
    }
    return out
  }
}
