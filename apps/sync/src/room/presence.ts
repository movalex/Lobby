// Presence (docs/EXCALIDRAW-MIGRATION.md §2.7): ephemeral, never written to the board file.
//
//  - Input: `{pointer, button, sel, view, idle, editing, drag?}` at most 20 Hz per session (excess
//    dropped). No identity fields: `sid`, `uid`, `name`, `color`, `guest` come from the ticket (the
//    roster). Pointer coordinates are rounded to integers, drag deltas to 0.1. While a dot vote is open,
//    `sel` is dropped.
//  - `presence` out at 10 Hz, changed peers only, at most 40 cursors per recipient, preferring peers
//    inside the recipient's `view`; `off` names peers a recipient stops getting. With 41 sessions or
//    fewer, nobody is capped and one frame (serialized once) serves everyone whose own presence did not
//    change; a recipient whose own entry is in the batch gets a copy without it.
//  - The drag relay (open item 6): ids once per drag (the first frame after its start, and in `welcome`),
//    then `{sid, d, dx, dy}`, then `{sid, d, end: true}`. Not subject to the cursor cap. Checks are shape
//    and caps only: at most 500 ids, one active drag per session, and a read-only session's drag is
//    dropped (B5 R1). A drag that fails a check is dropped; the rest of the message is kept.
//  - `roster`: join, leave and update events, uncapped, on change.

import { CURSORS_PER_RECIPIENT, MAX_DRAG_IDS, PRESENCE_IN_HZ } from '@draftroom/canvas-schema/limits'
import type { DragOut, PeerPresence, PresenceIn, RosterEntry } from '@draftroom/canvas-schema/protocol'

interface DragState {
  d: number
  ids: string[]
  dx: number
  dy: number
  startSent: boolean
  dirty: boolean
  ended: boolean
  /** the last frame of this drag (the relay ends a drag that has been quiet for DRAG_TTL_MS) */
  at: number
  /** when this drag started (the relay ends any drag DRAG_MAX_MS after its start) */
  readonly startedAt: number
}

/**
 * A relayed drag with no frame for this long ends (V2: a drag never expired, so one editor could keep a
 * preview up on up to 500 ids for everyone, late joiners included, and B12's hit guard swallowed clicks on
 * them). A dragging client sends a frame on every pointer move.
 */
export const DRAG_TTL_MS = 15_000
/**
 * A relayed drag ends this long after it started, frames or not (V2's re-check: one frame every 10 s kept
 * a drag, and its preview of up to 500 ids, up for everyone indefinitely). A real drag is over in seconds;
 * a longer one only loses its live preview, and its result still syncs at pointer-up. An expired drag
 * (its `d`) cannot start again by re-sending its ids.
 */
export const DRAG_MAX_MS = 60_000

interface Peer {
  readonly sid: string
  presence: PeerPresence
  dirty: boolean
  tokens: number
  last: number
  drag: DragState | null
  /** the drag the relay ended because it expired: that drag (`d`) cannot start again */
  expiredD: number | null
  readonly: boolean
}

export interface PresenceRecipient {
  readonly sid: string
  /** the handle id: a sid can have two sockets for a moment (a replaced socket) */
  readonly key: number
  readonly congested: boolean
  send(frame: string): void
}

const round1 = (v: number) => Math.round(v * 10) / 10
/** A drag quiet for DRAG_TTL_MS, or started more than DRAG_MAX_MS ago, is over. */
const expired = (d: DragState, now: number) => now - d.at > DRAG_TTL_MS || now - d.startedAt > DRAG_MAX_MS

export class PresenceHub {
  private readonly peers = new Map<string, Peer>()
  /** per recipient (capped rooms only): the peers it currently gets */
  private readonly shown = new Map<number, Set<string>>()
  private readonly pendingDragEnds: DragOut[] = []
  inCount = 0
  outCount = 0
  droppedDrags = 0

  private readonly now: () => number
  constructor(now: () => number) {
    this.now = now
  }

  private peer(sid: string, readonly: boolean): Peer {
    let p = this.peers.get(sid)
    if (!p) {
      p = {
        sid,
        presence: {
          sid,
          pointer: null,
          button: 'up',
          sel: [],
          view: null,
          idle: false,
          editing: null,
        },
        dirty: false,
        tokens: PRESENCE_IN_HZ,
        last: this.now(),
        drag: null,
        expiredD: null,
        readonly,
      }
      this.peers.set(sid, p)
    }
    p.readonly = readonly
    return p
  }

  /**
   * One presence message from a session. Returns false when it was dropped by the 20 Hz cap. `voteOpen`
   * drops `sel`.
   */
  input(sid: string, readonly: boolean, msg: PresenceIn, voteOpen: boolean): boolean {
    const p = this.peer(sid, readonly)
    const now = this.now()
    p.tokens = Math.min(PRESENCE_IN_HZ, p.tokens + ((now - p.last) / 1000) * PRESENCE_IN_HZ)
    p.last = now
    if (p.tokens < 1) return false
    p.tokens -= 1
    this.inCount++
    p.presence = {
      sid,
      pointer: msg.pointer ? { x: Math.round(msg.pointer.x), y: Math.round(msg.pointer.y) } : null,
      button: msg.button,
      sel: voteOpen ? null : msg.sel,
      view: msg.view,
      idle: msg.idle,
      editing: msg.editing,
    }
    p.dirty = true
    if (msg.drag !== undefined) this.dragInput(p, msg.drag)
    return true
  }

  private dragInput(p: Peer, drag: PresenceIn['drag']): void {
    if (drag === null || drag === undefined) {
      if (p.drag && !p.drag.ended) {
        p.drag.ended = true
        p.drag.dirty = true
      }
      return
    }
    if (p.readonly) {
      this.droppedDrags++
      return
    }
    const active = p.drag && !p.drag.ended ? p.drag : null
    if (drag.ids) {
      if (
        drag.ids.length > MAX_DRAG_IDS ||
        (active && active.d !== drag.d) ||
        (!active && drag.d === p.expiredD)
      ) {
        this.droppedDrags++
        return
      }
      if (active && active.d === drag.d) {
        active.dx = round1(drag.dx)
        active.dy = round1(drag.dy)
        active.dirty = true
        active.at = this.now()
        return
      }
      p.drag = {
        d: drag.d,
        ids: [...drag.ids],
        dx: round1(drag.dx),
        dy: round1(drag.dy),
        startSent: false,
        dirty: true,
        ended: false,
        at: this.now(),
        startedAt: this.now(),
      }
      return
    }
    if (!active || active.d !== drag.d) {
      this.droppedDrags++
      return
    }
    active.dx = round1(drag.dx)
    active.dy = round1(drag.dy)
    active.dirty = true
    active.at = this.now()
  }

  /** The active drags with their ids (welcome). */
  activeDrags(): DragOut[] {
    const out: DragOut[] = []
    const now = this.now()
    for (const p of this.peers.values())
      if (p.drag && !p.drag.ended && !expired(p.drag, now))
        out.push({ sid: p.sid, d: p.drag.d, ids: [...p.drag.ids], dx: p.drag.dx, dy: p.drag.dy })
    return out
  }

  /** The last presence of every peer (a late joiner's first frame). */
  current(): PeerPresence[] {
    return [...this.peers.values()].map((p) => p.presence)
  }

  /** A session left for good: its drag ends. */
  remove(sid: string): void {
    const p = this.peers.get(sid)
    if (!p) return
    if (p.drag && !p.drag.ended) this.pendingDragEnds.push({ sid, d: p.drag.d, end: true })
    this.peers.delete(sid)
  }

  forgetRecipient(key: number): void {
    this.shown.delete(key)
  }

  /** The 10 Hz tick: sends the changed peers and the drag deltas to every recipient. */
  tick(recipients: readonly PresenceRecipient[]): void {
    const changed: PeerPresence[] = []
    for (const p of this.peers.values())
      if (p.dirty) {
        changed.push(p.presence)
        p.dirty = false
      }
    const drags: DragOut[] = [...this.pendingDragEnds]
    this.pendingDragEnds.length = 0
    const now = this.now()
    for (const p of this.peers.values()) {
      const dr = p.drag
      if (dr && !dr.ended && expired(dr, now)) {
        dr.ended = true
        dr.dirty = true
        p.expiredD = dr.d
      }
      if (!dr?.dirty) continue
      dr.dirty = false
      if (dr.ended) {
        if (dr.startSent) drags.push({ sid: p.sid, d: dr.d, end: true })
        p.drag = null
      } else if (!dr.startSent) {
        dr.startSent = true
        drags.push({ sid: p.sid, d: dr.d, ids: [...dr.ids], dx: dr.dx, dy: dr.dy })
      } else drags.push({ sid: p.sid, d: dr.d, dx: dr.dx, dy: dr.dy })
    }
    if (!changed.length && !drags.length) return
    const capped = this.peers.size > CURSORS_PER_RECIPIENT + 1
    const shared = new Map<string, string>()
    const frameFor = (peers: PeerPresence[], ds: DragOut[], off?: string[]) =>
      JSON.stringify({
        type: 'presence',
        peers,
        ...(off?.length ? { off } : {}),
        ...(ds.length ? { drags: ds } : {}),
      })
    for (const r of recipients) {
      const ds = drags.filter((d) => d.sid !== r.sid)
      if (!capped) {
        if (r.congested && !ds.length) continue
        const own = changed.some((c) => c.sid === r.sid)
        const peers = r.congested ? [] : own ? changed.filter((c) => c.sid !== r.sid) : changed
        if (!peers.length && !ds.length) continue
        const cacheKey = own || r.congested || ds.length !== drags.length ? null : 'all'
        let frame = cacheKey ? shared.get(cacheKey) : undefined
        if (!frame) {
          frame = frameFor(peers, ds)
          if (cacheKey) shared.set(cacheKey, frame)
        }
        r.send(frame)
        this.outCount++
        continue
      }
      // capped: keep up to 40 peers per recipient, preferring peers inside its view
      const me = this.peers.get(r.sid)
      const view = me?.presence.view ?? null
      const shown = this.shown.get(r.key) ?? new Set<string>()
      const off: string[] = []
      for (const sid of shown) if (!this.peers.has(sid)) shown.delete(sid)
      const added: string[] = []
      if (shown.size < CURSORS_PER_RECIPIENT) {
        const inView = (p: Peer) =>
          !!view &&
          !!p.presence.pointer &&
          p.presence.pointer.x >= view.x &&
          p.presence.pointer.x <= view.x + view.w &&
          p.presence.pointer.y >= view.y &&
          p.presence.pointer.y <= view.y + view.h
        const candidates = [...this.peers.values()]
          .filter((p) => p.sid !== r.sid && !shown.has(p.sid) && p.presence.pointer)
          .sort((a, b) => Number(inView(b)) - Number(inView(a)))
        for (const p of candidates) {
          if (shown.size >= CURSORS_PER_RECIPIENT) break
          shown.add(p.sid)
          added.push(p.sid)
        }
      }
      this.shown.set(r.key, shown)
      const peers = r.congested
        ? []
        : [
            ...changed.filter((c) => shown.has(c.sid) && !added.includes(c.sid)),
            ...added.map((sid) => (this.peers.get(sid) as Peer).presence),
          ]
      if (!peers.length && !ds.length && !off.length) continue
      r.send(frameFor(peers, ds, off))
      this.outCount++
    }
  }
}

/** A roster entry from a session's ticket identity. */
export const rosterEntry = (s: {
  sid: string
  uid: string
  name: string
  color: string
  role: RosterEntry['role']
  guest: boolean
}): RosterEntry => ({ sid: s.sid, uid: s.uid, name: s.name, color: s.color, role: s.role, guest: s.guest })
