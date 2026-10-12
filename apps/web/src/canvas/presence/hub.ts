/**
 * Presence on the board page (docs/EXCALIDRAW-MIGRATION.md §2.7): what this tab sends, and what it shows
 * of everyone else.
 *
 * Out (through the engine core's `sendPresence`, ≤ 20 Hz, the core keeps a drag's ids and its end):
 *  - the pointer from Lobby's own listener (./pointer.ts, every role), `sel`, `view`, `idle`, and
 *    `editing` (the lease id of this tab's open editor, re-sent at least every 2 s: it renews the lease);
 *  - CONTRACTS_REV 10 (CR-3C-1, CR-3CF-1): `f`, the session this tab follows (3c's follow part sets it
 *    through ./follow-target.ts `setPresenceFollow(core, sid)`, so the board session needs no new
 *    wiring), and `view.z`, this tab's zoom (the board session's `view` gives it). Both go out ONLY on
 *    a socket whose room sent a `contracts` frame naming rev 10 or later
 *    after its welcome: a rev-9 room refuses them (its parse is strict: the socket would close
 *    INVALID_MESSAGE). From that frame on, every message carries `f` (null included), which tells the
 *    room this socket reads the rev-10 fields; this tab sends one at once so the room knows without a
 *    pointer move. A new welcome (a reconnect, maybe to an older room) goes back to rev-9 messages;
 *  - CONTRACTS_REV 12 (wave L, L6-1, the shared laser): `t` ('laser' while this tab's laser tool is pressed,
 *    else null) in every message, and with the laser `trail`, the samples the pointer listener took since the
 *    previous message (./laser.ts `laserTrailOut`: at most 6 integer points). ONLY on a socket whose room's
 *    `contracts` frame named PRESENCE_LASER_REV or later: a rev-11 room refuses both (strict); this tab
 *    sends one message at once when that frame comes, so the room knows it reads the laser fields. Whether
 *    the laser is the active tool comes from the canvas API (./laser.ts `laserToolOn`, keyed by the core);
 *    M2-6 (wave M): while the laser is pressed, (1) the hub spaces its messages by the 20 Hz interval itself and
 *    keeps the samples that arrive meanwhile for the next one, so the core never has to coalesce a laser message
 *    (it replaces a pending message by the newest, and the trail of the replaced one was lost), and (2) a laser
 *    held still re-sends its last point every LASER_RESEND_MS (the fields above only), so the others do not
 *    count it released after LASER_HOLD_MS;
 *  - a drag preview: `{d, ids, dx, dy}` in the drag's FIRST message only (≤ 500 ids: the selection, its
 *    frames' children and its containers' labels), then `{d, dx, dy}` (scene units, rounded to 0.1), and
 *    `drag: null` at the end. Read-only sessions never send one (the server drops it anyway).
 *
 * In (the core's `message` events): `presence` frames (changed peers, `off` for peers past the cursor cap),
 * `drags` (ids once, then deltas) applied as render offsets through `RenderOverrides.setDrag` (the
 * container carries the offset; its label follows), cleared when the peer's drag ends, when the peer
 * leaves, and when the committed positions arrive (the core's `applied` event). `draggerOf(id)` tells
 * O5's hit guard who is moving an element ("Bob is moving this"). The other sessions' lasers (`t`, `trail`,
 * CONTRACTS_REV 12) go into ./laser.ts `LaserTrails`, which the canvas API reads (`presence.lasers()`).
 *
 * Browser (uses the overrides and the core's events), but no DOM of its own.
 */

import { MAX_DRAG_IDS, PRESENCE_IN_HZ } from '@draftroom/canvas-schema/limits'
import {
  type DragOut,
  MAX_PRESENCE_ZOOM,
  type PeerPresence,
  PRESENCE_FOLLOW_REV,
  PRESENCE_LASER_REV,
  type RosterEntry,
} from '@draftroom/canvas-schema/protocol'
import type { LobbyEngineCore } from '../sync/core/engine.ts'
import type { GestureState, SceneElement } from '../sync/types.ts'
import { noteSceneWalk } from '../sync/walks.ts'
import { planDragArrows } from './drag-arrows.ts'
import { onPresenceFollow, presenceFollowOf } from './follow-target.ts'
import {
  LASER_RESEND_MS,
  LASER_STILL_MAX_MS,
  LaserTrails,
  laserToolOn,
  laserTrailOut,
  provideLasers,
  thinPoints,
} from './laser.ts'
import type { PresencePoint, PresenceSample } from './sample.ts'

/** What O5's overrides.ts `RenderOverrides` offers for drag previews (its existing API). */
export interface DragOverrides {
  setDrag(source: string, offsets: ReadonlyMap<string, { x: number; y: number }> | null): void
  clearDragFor(ids: Iterable<string>): void
  /** the engine draws these invisible while Lobby draws them re-routed (D1: bound arrows, ./drag-arrows.ts) */
  setPreviewHidden?(source: string, ids: Iterable<string> | null): void
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
  /** the scene by id (the bound arrows of a peer's drag, D1); built from `elements` when absent */
  readonly elementMap?: () => ReadonlyMap<string, SceneElement>
  /**
   * N1-6 (wave N): the live children of a frame (the scene index, `canvas.index.byFrame`), for a drag's ids: a drag
   * then reads no whole scene at all. Absent (or null: no index yet): one walk at the drag's start
   */
  readonly frameChildren?: (frameId: string) => readonly SceneElement[] | null

  /** the visible scene rectangle (with this tab's zoom `z` when the page knows it) */
  readonly view: () => PresenceViewRect | null
  readonly readOnly: () => boolean
  readonly now?: () => number
  readonly setTimer?: (fn: () => void, ms: number) => unknown
  readonly clearTimer?: (h: unknown) => void
}

const RENEW_MS = 2_000
/** The most laser samples held between two sends (a stalled send keeps the latest shape, thinned). */
const MAX_PENDING_TRAIL = 64
/** The least time between two presence messages the hub hands the core while the laser is pressed (20 Hz). */
export const LASER_SEND_INTERVAL_MS = 1000 / PRESENCE_IN_HZ
/**
 * A message this close to its slot (ms) goes at once. The core counts in whole milliseconds (`Date.now()`), the hub in
 * fractions (`performance.now()`), and a pointer sample that comes a hair before its 50 ms would otherwise wait for a timer
 * (about 15 ms on Windows) to cover a gap the core does not see. The core's own cap still holds the message for what is
 * left of it; the hub's next one is more than the core's window away, so the core never has two to choose between.
 */
export const LASER_GATE_SLACK_MS = 5
const round1 = (v: number) => Math.round(v * 10) / 10
/** A zoom on the wire: 3 decimals (0.1 to 30 in Excalidraw). */
const roundZoom = (z: number) => Math.round(z * 1000) / 1000

/** The visible scene rectangle a hub sends, and this tab's zoom when its page knows it. */
export interface PresenceViewRect {
  x: number
  y: number
  w: number
  h: number
  /** screen px per scene unit (rev 10's `view.z`; never sent to a rev-9 room) */
  z?: number
}

export class PresenceHub {
  private readonly o: PresenceHubOptions
  private readonly peersBySid = new Map<string, PeerPresence>()
  private readonly remoteDrags = new Map<
    string,
    { d: number; ids: readonly string[]; dx: number; dy: number }
  >()
  /** ids of a remote drag whose committed positions arrived before its end (their offset is done) */
  private readonly settled = new Set<string>()
  /** per dragging peer: copies of the bound arrows its drag re-routes (D1; drawn, never written) */
  private readonly arrowCopies = new Map<string, SceneElement[]>()
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
  /** the contracts revision the current socket's room announced (0 until its `contracts` frame) */
  private roomRev = 0
  /** this tab's laser is pressed (the laser tool, the button down; CONTRACTS_REV 12) */
  private laserDown = false
  /** laser samples since the last message (scene points, oldest first) */
  private pendingTrail: PresencePoint[] = []
  /** M2-6: when the hub last handed the core a message (the hub's clock) */
  private lastHandover = Number.NEGATIVE_INFINITY
  /** M2-6: the timer of a laser message waiting for its 20 Hz slot */
  private parkTimer: unknown = null
  /** M2-6: the timer that re-sends a held laser */
  private resendTimer: unknown = null
  /** wave N.1: when the last pointer sample came (the hub's clock); the re-send does not count */
  private lastPointerAt = Number.NEGATIVE_INFINITY
  /** the last sample's trail taken (a sample handed over again brings no new points) */
  private lastTrail: readonly PresencePoint[] | null = null
  /** the other sessions' lasers (CONTRACTS_REV 12) */
  private readonly lasers = new LaserTrails()
  private readonly clock: () => number

  constructor(o: PresenceHubOptions) {
    this.o = o
    this.clock = o.now ?? (() => performance.now())
    this.off.push(
      // the canvas API reads the lasers this hub receives (./laser.ts, keyed by the core)
      provideLasers(o.core, (now) => this.lasers.trails(now)),
      // 3c's follow part set whom this tab follows (./follow-target.ts): a rev-10 room hears it now
      onPresenceFollow(o.core, () => this.followChanged()),
      o.core.on((e) => {
        if (e.kind === 'message') {
          const m = e.message
          if (m.type === 'presence') this.onPresence(m.peers, m.off ?? [], m.drags ?? [])
          else if (m.type === 'welcome') {
            // a new socket: rev-9 messages until its room says otherwise
            this.roomRev = 0
            this.peersBySid.clear()
            this.lasers.clear()
            this.pendingTrail = []
            this.laserDown = false
            this.stopLaserTimers()
            for (const sid of [...this.remoteDrags.keys()]) this.endRemoteDrag(sid)
            this.onPresence([], [], m.drags)
          } else if (m.type === 'contracts') {
            const before = this.rev10
            const before12 = this.rev12
            this.roomRev = m.rev
            // tell the room now that this socket reads the rev-10 fields (and whom it follows), and since
            // rev 12 the laser's (`t`)
            if ((!before && this.rev10) || (!before12 && this.rev12)) this.send()
          } else if (m.type === 'roster') {
            for (const ev of m.events)
              if (ev.k === 'leave') {
                this.peersBySid.delete(ev.sid)
                this.lasers.remove(ev.sid)
                this.endRemoteDrag(ev.sid)
              }
            this.changed()
          } else if (m.type === 'lease') this.changed()
        } else if (e.kind === 'applied') {
          // committed positions arrived: the preview offset of those elements is done
          const dragged = new Set<string>()
          for (const d of this.remoteDrags.values()) for (const id of d.ids) dragged.add(id)
          const done = e.ids.filter((id) => dragged.has(id))
          if (done.length) {
            this.o.overrides?.clearDragFor(done)
            for (const id of done) this.settled.add(id)
            this.changed()
          }
          // a re-routed arrow's committed (re-snapped) copy arrived: its drawn copy goes
          const applied = new Set(e.ids)
          for (const [sid, copies] of this.arrowCopies) {
            const keep = copies.filter((c) => !applied.has(c.id))
            if (keep.length === copies.length) continue
            this.setArrowCopies(sid, keep)
            this.changed()
          }
        }
      }),
    )
  }

  dispose(): void {
    for (const f of this.off.splice(0)) f()
    if (this.renewTimer !== null) (this.o.clearTimer ?? clearTimeout)(this.renewTimer as never)
    this.stopLaserTimers()
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

  /** The bound arrows peers' drags re-route right now (copies, D1): the drag-preview layer draws them. */
  arrowPreviews(): readonly SceneElement[] {
    const out: SceneElement[] = []
    for (const copies of this.arrowCopies.values()) out.push(...copies)
    return out
  }

  /** Whether this socket's room reads presence `f` and `view.z` (CONTRACTS_REV 10). */
  get rev10(): boolean {
    return this.roomRev >= PRESENCE_FOLLOW_REV
  }

  /** Whether this socket's room reads presence `t` and `trail`, the laser (CONTRACTS_REV 12). */
  get rev12(): boolean {
    return this.roomRev >= PRESENCE_LASER_REV
  }

  /**
   * The offset a remote drag shows `id` at right now (scene units), or null when nobody drags it: the
   * remote selection outlines (W5-28) follow the preview, as the elements do.
   */
  dragOffsetOf(id: string): { x: number; y: number } | null {
    if (this.settled.has(id)) return null
    for (const d of this.remoteDrags.values()) if (d.ids.includes(id)) return { x: d.dx, y: d.dy }
    return null
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
    const now = this.clock()
    for (const p of peers) {
      this.peersBySid.set(p.sid, p)
      this.lasers.apply(p, now)
    }
    for (const sid of off) {
      this.peersBySid.delete(sid)
      this.lasers.remove(sid)
    }
    for (const d of drags) {
      if ('end' in d) {
        this.endRemoteDrag(d.sid)
        continue
      }
      if (d.ids) {
        this.remoteDrags.set(d.sid, { d: d.d, ids: d.ids, dx: d.dx, dy: d.dy })
        for (const id of d.ids) this.settled.delete(id)
      }
      const known = this.remoteDrags.get(d.sid)
      // a delta for a drag whose start this client missed is ignored (it sees the move at commit)
      if (!known || known.d !== d.d) continue
      known.dx = d.dx
      known.dy = d.dy
      const offsets = new Map(known.ids.map((id) => [id, { x: d.dx, y: d.dy }]))
      // D1: the arrows bound to what moves follow it, drawn only (./drag-arrows.ts)
      const plan = this.planArrows(offsets)
      for (const [id, o] of plan?.moveWith ?? []) offsets.set(id, o)
      this.o.overrides?.setDrag(d.sid, offsets)
      this.setArrowCopies(d.sid, plan?.reroute ?? [])
    }
    this.changed()
  }

  private endRemoteDrag(sid: string): void {
    const drag = this.remoteDrags.get(sid)
    if (!drag || !this.remoteDrags.delete(sid)) return
    for (const id of drag.ids) this.settled.delete(id)
    this.o.overrides?.setDrag(sid, null)
    this.setArrowCopies(sid, [])
  }

  private planArrows(offsets: ReadonlyMap<string, { x: number; y: number }>) {
    if (!this.o.overrides?.setPreviewHidden) return null
    return planDragArrows(this.o.elementMap?.() ?? this.mapOfElements(), offsets)
  }

  private setArrowCopies(sid: string, copies: SceneElement[]): void {
    if (copies.length) this.arrowCopies.set(sid, copies)
    else if (!this.arrowCopies.delete(sid)) return
    this.o.overrides?.setPreviewHidden?.(sid, copies.length ? copies.map((c) => c.id) : null)
  }

  // ---- out ---------------------------------------------------------------------------------------

  private followChanged(): void {
    if (this.rev10) this.send()
  }

  /** Lobby's pointer listener (./pointer.ts). */
  onPointer(s: PresenceSample): void {
    const before = this.pointer
    // M2-6: the previous sample's own message is still waiting for its 20 Hz slot (it never went out)
    const unsent = this.laserDown && this.parkTimer !== null
    this.pointer = s.pointer ? { x: Math.round(s.pointer.x), y: Math.round(s.pointer.y) } : null
    this.button = s.button
    this.idle = false
    this.lastPointerAt = this.clock()
    // CONTRACTS_REV 12: the laser is pressed while the laser tool is active and the button down on the board;
    // the samples since the last message go with the next one (a selection-tool press never carries `t`)
    const was = this.laserDown
    this.laserDown = this.rev12 && s.button === 'down' && s.pointer !== null && laserToolOn(this.o.core)
    if (!this.laserDown) this.pendingTrail = []
    else if (was) {
      // a point that was to go as a message's `pointer` and was replaced by a newer sample is a point of the path
      if (unsent && before) this.pendingTrail.push(before)
      // the board session re-sends its last sample on a camera move (a fresh `view`): its trail went already
      if (s.trail?.length && s.trail !== this.lastTrail) {
        this.lastTrail = s.trail
        for (const p of s.trail) this.pendingTrail.push(p)
      }
      if (this.pendingTrail.length > MAX_PENDING_TRAIL)
        this.pendingTrail = [...thinPoints(this.pendingTrail, MAX_PENDING_TRAIL / 2)]
    }
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
      // N1-6: the engine's own map (no walk per pointer move on a 10k board); a scene built from `elements` only
      // where the page gives none (tests)
      const byId = this.o.elementMap?.() ?? this.mapOfElements()
      if (!this.localDrag) {
        const ids = this.dragIds(g.selectedElementIds, byId)
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

  /** The scene by id from `elements` (a page that gives no `elementMap`): one walk. */
  private mapOfElements(): ReadonlyMap<string, SceneElement> {
    noteSceneWalk('presence.elements')
    return new Map(this.o.elements().map((e) => [e.id, e]))
  }

  /**
   * A local drag's ids, at its start: the selection, the live children of every selected frame (the scene index;
   * one walk only without it), without the bound labels (a label follows its container's offset; the container
   * is what moves).
   */
  private dragIds(selected: readonly string[], byId: ReadonlyMap<string, SceneElement>): string[] {
    const out = new Set(selected)
    const frames = selected.filter((id) => byId.get(id)?.type === 'frame')
    if (frames.length) {
      const indexed = frames.map((f) => this.o.frameChildren?.(f) ?? null)
      if (indexed.every((c) => c !== null)) {
        for (const children of indexed) for (const el of children ?? []) if (!el.isDeleted) out.add(el.id)
      } else {
        noteSceneWalk('presence.dragStart')
        for (const el of byId.values()) {
          if (el.isDeleted) continue
          const frameId = (el as { frameId?: string | null }).frameId
          if (frameId && out.has(frameId)) out.add(el.id)
        }
      }
    }
    return [...out].filter((id) => {
      const el = byId.get(id)
      return !(el?.type === 'text' && (el as { containerId?: string | null }).containerId)
    })
  }

  private send(drag?: { d: number; ids?: string[]; dx: number; dy: number } | null): void {
    // M2-6: while the laser is pressed, a message that comes less than one 20 Hz interval after the last one waits
    // for its slot (the samples it would have carried stay in `pendingTrail`, the pointer and the view are read
    // when it goes), instead of being handed to a core that would hold it and let a newer message replace it.
    if (drag === undefined && this.laserDown) {
      const wait = this.lastHandover + LASER_SEND_INTERVAL_MS - this.clock()
      if (wait > LASER_GATE_SLACK_MS) {
        if (this.parkTimer === null) {
          const setT = this.o.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
          this.parkTimer = setT(() => {
            this.parkTimer = null
            this.send()
          }, wait)
        }
        return
      }
    }
    this.handOver(drag)
  }

  /** Cancels a parked laser message and the held laser's re-send. */
  private stopLaserTimers(): void {
    const clearT = this.o.clearTimer ?? ((h: unknown) => clearTimeout(h as never))
    if (this.parkTimer !== null) clearT(this.parkTimer)
    if (this.resendTimer !== null) clearT(this.resendTimer)
    this.parkTimer = null
    this.resendTimer = null
  }

  /**
   * M2-6: a laser pressed and held still sends nothing by itself, and the others count it released after
   * LASER_HOLD_MS. So every message that goes while it is pressed starts a timer; if it runs out (no pointer
   * event, no other message in LASER_RESEND_MS), the last point goes again: the same fields as any laser
   * message, no trail, through the same gate.
   */
  private armResend(): void {
    const clearT = this.o.clearTimer ?? ((h: unknown) => clearTimeout(h as never))
    if (this.resendTimer !== null) clearT(this.resendTimer)
    this.resendTimer = null
    if (!this.laserDown) return
    const setT = this.o.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
    this.resendTimer = setT(() => {
      this.resendTimer = null
      if (!this.laserDown || !this.rev12) return
      // wave N.1: no pointer event for this long, still "pressed": its release was lost. The press ends here (t: null goes
      // out once, the others' laser fades) instead of being re-sent for ever; the next real sample is a new press.
      if (this.clock() - this.lastPointerAt >= LASER_STILL_MAX_MS) {
        this.laserDown = false
        this.button = 'up'
        this.pendingTrail = []
      }
      this.send()
    }, LASER_RESEND_MS)
  }

  private handOver(drag?: { d: number; ids?: string[]; dx: number; dy: number } | null): void {
    if (this.parkTimer !== null) {
      ;(this.o.clearTimer ?? ((h: unknown) => clearTimeout(h as never)))(this.parkTimer)
      this.parkTimer = null
    }
    this.lastHandover = this.clock()
    const sel = this.sel.length > 200 ? { count: this.sel.length } : this.sel
    const v = this.o.view()
    const rich = this.rev10
    // a rev-9 room refuses `view.z` and `f` (strict): both only after this socket's `contracts` frame
    const z = rich && v?.z !== undefined && Number.isFinite(v.z) ? roundZoom(v.z) : 0
    const zoomOk = z > 0 && z <= MAX_PRESENCE_ZOOM
    const view = v ? { x: v.x, y: v.y, w: v.w, h: v.h, ...(zoomOk ? { z } : {}) } : null
    // a rev-11 room refuses `t` and `trail` (strict): both only after this socket's rev-12 `contracts` frame
    const laser = this.rev12
    const trail = laser && this.laserDown ? laserTrailOut(this.pendingTrail, this.pointer) : []
    this.pendingTrail = []
    this.o.core.sendPresence({
      pointer: this.pointer,
      button: this.button,
      sel,
      view,
      idle: this.idle,
      editing: this.editing,
      ...(drag !== undefined ? { drag } : {}),
      ...(rich ? { f: this.followTarget() } : {}),
      ...(laser ? { t: this.laserDown ? ('laser' as const) : null } : {}),
      ...(trail.length ? { trail } : {}),
    })
    this.armResend()
  }

  /** Whom this tab follows (never itself), for `f`. */
  private followTarget(): string | null {
    const sid = presenceFollowOf(this.o.core)
    return sid && sid !== this.o.core.sid ? sid : null
  }
}
