/**
 * Presence on the board page (docs/EXCALIDRAW-MIGRATION.md §2.7): what this tab sends, and what it shows
 * of everyone else.
 *
 * Out (through the engine core's `sendPresence`, ≤ 20 Hz, the core keeps a drag's ids and its end):
 *  - the pointer from Lobby's own listener (./pointer.ts, every role), `sel`, `view`, `idle`, and
 *    `editing` (the lease id of this tab's open editor, re-sent at least every 2 s: it renews the lease);
 *  - a drag preview: `{d, ids, dx, dy}` in the drag's FIRST message only (≤ 500 ids: the selection, its
 *    frames' children and its containers' labels), then `{d, dx, dy}` (scene units, rounded to 0.1), and
 *    `drag: null` at the end. Read-only sessions never send one (the server drops it anyway).
 *
 * In (the core's `message` events): `presence` frames (changed peers, `off` for peers past the cursor cap),
 * `drags` (ids once, then deltas) applied as render offsets through `RenderOverrides.setDrag` (the
 * container carries the offset; its label follows), cleared when the peer's drag ends, when the peer
 * leaves, and when the committed positions arrive (the core's `applied` event). `draggerOf(id)` tells
 * O5's hit guard who is moving an element ("Bob is moving this").
 *
 * Browser (uses the overrides and the core's events), but no DOM of its own.
 */

import { MAX_DRAG_IDS } from '@draftroom/canvas-schema/limits'
import type { DragOut, PeerPresence, RosterEntry } from '@draftroom/canvas-schema/protocol'
import type { LobbyEngineCore } from '../sync/core/engine.ts'
import type { GestureState, SceneElement } from '../sync/types.ts'
import type { PresenceSample } from './pointer.ts'

/** What O5's overrides.ts `RenderOverrides` offers for drag previews (its existing API). */
export interface DragOverrides {
  setDrag(source: string, offsets: ReadonlyMap<string, { x: number; y: number }> | null): void
  clearDragFor(ids: Iterable<string>): void
}

export interface PeerView {
  readonly sid: string
  readonly uid: string
  readonly name: string
  readonly color: string
  readonly guest: boolean
  readonly pointer: { readonly x: number; readonly y: number } | null
  readonly editing: string | null
  readonly idle: boolean
  /** the peer's selection (ids), empty when hidden or counted */
  readonly sel: readonly string[]
}

export interface PresenceHubOptions {
  readonly core: LobbyEngineCore
  readonly overrides: DragOverrides | null
  /** the current scene (drag ids: frame children and labels) */
  readonly elements: () => readonly SceneElement[]
  /** the visible scene rectangle */
  readonly view: () => { x: number; y: number; w: number; h: number } | null
  readonly readOnly: () => boolean
  readonly now?: () => number
  readonly setTimer?: (fn: () => void, ms: number) => unknown
  readonly clearTimer?: (h: unknown) => void
}

const RENEW_MS = 2_000
const round1 = (v: number) => Math.round(v * 10) / 10

export class PresenceHub {
  private readonly o: PresenceHubOptions
  private readonly peersBySid = new Map<string, PeerPresence>()
  private readonly remoteDrags = new Map<string, { d: number; ids: readonly string[] }>()
  private readonly listeners = new Set<() => void>()
  private pointer: { x: number; y: number } | null = null
  private button: 'up' | 'down' = 'up'
  private editing: string | null = null
  private idle = false
  private sel: string[] = []
  private dragSeq = 0
  private localDrag: {
    d: number
    ids: string[]
    anchor: string
    x0: number
    y0: number
    sentIds: boolean
  } | null = null
  private renewTimer: unknown = null
  private readonly off: (() => void)[] = []
  private version = 0

  constructor(o: PresenceHubOptions) {
    this.o = o
    this.off.push(
      o.core.on((e) => {
        if (e.kind === 'message') {
          const m = e.message
          if (m.type === 'presence') this.onPresence(m.peers, m.off ?? [], m.drags ?? [])
          else if (m.type === 'welcome') {
            this.peersBySid.clear()
            for (const sid of [...this.remoteDrags.keys()]) this.endRemoteDrag(sid)
            this.onPresence([], [], m.drags)
          } else if (m.type === 'roster') {
            for (const ev of m.events)
              if (ev.k === 'leave') {
                this.peersBySid.delete(ev.sid)
                this.endRemoteDrag(ev.sid)
              }
            this.changed()
          } else if (m.type === 'lease') this.changed()
        } else if (e.kind === 'applied') {
          // committed positions arrived: the preview offset of those elements is done
          const dragged = new Set<string>()
          for (const d of this.remoteDrags.values()) for (const id of d.ids) dragged.add(id)
          const done = e.ids.filter((id) => dragged.has(id))
          if (done.length) this.o.overrides?.clearDragFor(done)
        }
      }),
    )
  }

  dispose(): void {
    for (const f of this.off.splice(0)) f()
    if (this.renewTimer !== null) (this.o.clearTimer ?? clearTimeout)(this.renewTimer as never)
    for (const sid of [...this.remoteDrags.keys()]) this.endRemoteDrag(sid)
  }

  // ---- reads -------------------------------------------------------------------------------------

  subscribe(l: () => void): () => void {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  /** bumps on every change (useSyncExternalStore's snapshot) */
  get revision(): number {
    return this.version
  }

  peers(): PeerView[] {
    const roster = this.o.core.roster()
    const me = this.o.core.sid
    const out: PeerView[] = []
    for (const [sid, p] of this.peersBySid) {
      if (sid === me) continue
      const r: RosterEntry | undefined = roster.get(sid)
      out.push({
        sid,
        uid: r?.uid ?? sid.split(':')[0] ?? sid,
        name: r?.name ?? 'Someone',
        color: r?.color ?? '#6b7280',
        guest: r?.guest ?? false,
        pointer: p.pointer,
        editing: p.editing,
        idle: p.idle,
        sel: Array.isArray(p.sel) ? p.sel : [],
      })
    }
    return out
  }

  /** Who is dragging `id` right now (O5's "Bob is moving this"), or null. */
  draggerOf(id: string): { sid: string; name: string } | null {
    for (const [sid, d] of this.remoteDrags) {
      if (!d.ids.includes(id)) continue
      return { sid, name: this.o.core.roster().get(sid)?.name ?? 'Someone' }
    }
    return null
  }

  private changed(): void {
    this.version++
    for (const l of [...this.listeners]) l()
  }

  // ---- in ----------------------------------------------------------------------------------------

  private onPresence(
    peers: readonly PeerPresence[],
    off: readonly string[],
    drags: readonly DragOut[],
  ): void {
    for (const p of peers) this.peersBySid.set(p.sid, p)
    for (const sid of off) this.peersBySid.delete(sid)
    for (const d of drags) {
      if ('end' in d) {
        this.endRemoteDrag(d.sid)
        continue
      }
      if (d.ids) this.remoteDrags.set(d.sid, { d: d.d, ids: d.ids })
      const known = this.remoteDrags.get(d.sid)
      // a delta for a drag whose start this client missed is ignored (it sees the move at commit)
      if (!known || known.d !== d.d) continue
      this.o.overrides?.setDrag(d.sid, new Map(known.ids.map((id) => [id, { x: d.dx, y: d.dy }])))
    }
    this.changed()
  }

  private endRemoteDrag(sid: string): void {
    if (!this.remoteDrags.delete(sid)) return
    this.o.overrides?.setDrag(sid, null)
  }

  // ---- out ---------------------------------------------------------------------------------------

  /** Lobby's pointer listener (./pointer.ts). */
  onPointer(s: PresenceSample): void {
    this.pointer = s.pointer ? { x: Math.round(s.pointer.x), y: Math.round(s.pointer.y) } : null
    this.button = s.button
    this.idle = false
    this.send()
  }

  /** This tab's open editor (its lease id), or null: presence renews the lease at least every 2 s. */
  setEditing(leaseId: string | null): void {
    if (this.editing === leaseId) return
    this.editing = leaseId
    const setT = this.o.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
    const clearT = this.o.clearTimer ?? ((h: unknown) => clearTimeout(h as never))
    if (this.renewTimer !== null) clearT(this.renewTimer)
    this.renewTimer = null
    const renew = () => {
      this.renewTimer = null
      if (!this.editing) return
      this.send()
      this.renewTimer = setT(renew, RENEW_MS - 200)
    }
    this.send()
    if (leaseId) this.renewTimer = setT(renew, RENEW_MS - 200)
  }

  /** Every scene change: the selection, and a local drag's start, moves and end. */
  onGesture(g: GestureState): void {
    const sel = g.selectedElementIds.slice(0, 200)
    const selChanged = sel.length !== this.sel.length || sel.some((id, i) => id !== this.sel[i])
    this.sel = sel
    if (g.dragging && g.selectedElementIds.length > 0 && !this.o.readOnly()) {
      const els = this.o.elements()
      const byId = new Map(els.map((e) => [e.id, e]))
      if (!this.localDrag) {
        const ids = this.dragIds(g.selectedElementIds, els)
        const anchor = g.selectedElementIds.find((id) => byId.has(id)) as string | undefined
        const a = anchor ? byId.get(anchor) : undefined
        if (!anchor || !a) return
        this.localDrag = {
          d: ++this.dragSeq,
          ids: ids.slice(0, MAX_DRAG_IDS),
          anchor,
          x0: a.x as number,
          y0: a.y as number,
          sentIds: false,
        }
      }
      const drag = this.localDrag
      const a = byId.get(drag.anchor)
      if (!a) return
      const dx = round1((a.x as number) - drag.x0)
      const dy = round1((a.y as number) - drag.y0)
      const first = !drag.sentIds
      drag.sentIds = true
      this.send(first ? { d: drag.d, ids: drag.ids, dx, dy } : { d: drag.d, dx, dy })
      return
    }
    if (this.localDrag) {
      this.localDrag = null
      this.send(null)
      return
    }
    if (selChanged) this.send()
  }

  private dragIds(selected: readonly string[], els: readonly SceneElement[]): string[] {
    const out = new Set(selected)
    for (const el of els) {
      if (el.isDeleted) continue
      const frameId = (el as { frameId?: string | null }).frameId
      if (frameId && out.has(frameId)) out.add(el.id)
    }
    // a label follows its container's offset; the container is what moves
    return [...out].filter((id) => {
      const el = els.find((e) => e.id === id)
      return !(el?.type === 'text' && (el as { containerId?: string | null }).containerId)
    })
  }

  private send(drag?: { d: number; ids?: string[]; dx: number; dy: number } | null): void {
    const sel = this.sel.length > 200 ? { count: this.sel.length } : this.sel
    this.o.core.sendPresence({
      pointer: this.pointer,
      button: this.button,
      sel,
      view: this.o.view(),
      idle: this.idle,
      editing: this.editing,
      ...(drag !== undefined ? { drag } : {}),
    })
  }
}
