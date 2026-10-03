// THE ORACLE (D1, wave D): the rev-10 presence relay exactly as it was at efda5096 (wave A's CR-3C-1, which
// re-ranks every recipient's 40-cursor set on every tick), kept verbatim below this header but for the
// class name (`ReferencePresenceHub`).
// `presence-rank.test.ts` drives it and the room's PresenceHub with the same inputs and compares what every
// recipient holds after every tick. Never imported by the server.
//
// ---- verbatim from apps/sync/src/room/presence.ts at efda5096 ---------------------------------------------
// Presence (docs/EXCALIDRAW-MIGRATION.md §2.7): ephemeral, never written to the board file.
//
//  - Input: `{pointer, button, sel, view, idle, editing, drag?}` at most 20 Hz per session (excess
//    dropped). No identity fields: `sid`, `uid`, `name`, `color`, `guest` come from the ticket (the
//    roster). Pointer coordinates are rounded to integers, drag deltas to 0.1. While a dot vote is open,
//    `sel` is dropped.
//  - `presence` out at 10 Hz, changed peers only. With 41 sessions or fewer, nobody is capped and one
//    frame (serialized once) serves everyone whose own presence did not change; a recipient whose own
//    entry is in the batch gets a copy without it. Above that, each recipient gets at most 40 cursors,
//    re-ranked on every tick (CR-3C-1): peers whose pointer is inside its `view` first (the ones it
//    already gets before newcomers), then the others it already gets, then out-of-view newcomers; a peer
//    that falls out of that set is named in `off`, so a view change or a newcomer in view replaces an
//    out-of-view cursor (before, the first 40 stayed for good and nobody else ever appeared). The peer a
//    recipient follows (its `f`) is always delivered, outside the cap: a follower's camera needs its
//    `view`. The room tracks what each recipient holds (`delivered`), so `off` names only peers it
//    has, and a room that drops back to 41 sends each recipient the peers it was not getting.
//  - CONTRACTS_REV 10 (CR-3C-1, CR-3CF-1): `f` (whom the sender follows) and `view.z` (its zoom), and
//    per recipient `followers` (the sessions following it, uncapped, when the list changes). A socket
//    reads them once it has sent `f` (a rev-10 client sends `f` in every message after the room's
//    `contracts` frame); every other socket gets the rev-9 entries (no `f`, no `view.z`), which a
//    rev-9 client's strict parse accepts. A socket's first `f` re-sends what it holds, now with them.
//  - The drag relay (open item 6): ids once per drag (the first frame after its start, and in `welcome`),
//    then `{sid, d, dx, dy}`, then `{sid, d, end: true}`. Not subject to the cursor cap. Checks are shape
//    and caps only: at most 500 ids, one active drag per session, and a read-only session's drag is
//    dropped (B5 R1). A drag that fails a check is dropped; the rest of the message is kept.
//  - `roster`: join, leave and update events, uncapped, on change.

import { CURSORS_PER_RECIPIENT, MAX_DRAG_IDS, PRESENCE_IN_HZ } from '@draftroom/canvas-schema/limits'
import {
  CONTRACTS_REV,
  type DragOut,
  MAX_FOLLOWERS,
  type PeerPresence,
  type PresenceIn,
  type RosterEntry,
} from '@draftroom/canvas-schema/protocol'

/** The frame a room sends right after every welcome (CONTRACTS_REV 10): the revision it speaks. */
export const CONTRACTS_FRAME = JSON.stringify({ type: 'contracts', rev: CONTRACTS_REV })

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
  /** the rev-10 entry (`f` when it follows someone, `view.z` when it sent one); `plainOf` is rev 9's */
  presence: PeerPresence
  /** the session it follows (never itself), or null */
  f: string | null
  dirty: boolean
  tokens: number
  last: number
  drag: DragState | null
  /** the drag the relay ended because it expired: that drag (`d`) cannot start again */
  expiredD: number | null
  readonly: boolean
}

/** What the room knows of one recipient socket (by its handle key). */
interface RecipientState {
  /** the peers it holds: what it was sent, less what `off` and the roster's leaves took away */
  readonly delivered: Set<string>
  /** it has sent `f`: it reads the rev-10 fields (`f`, `view.z`, `followers`) */
  rich: boolean
  /** every peer it holds goes again on the next tick (it just became rich: it holds them without f, z) */
  resend: boolean
  /** the followers list it holds, joined ('' for none: it starts with none) */
  followers: string
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

export class ReferencePresenceHub {
  private readonly peers = new Map<string, Peer>()
  /** per recipient socket (its handle key) */
  private readonly recipients = new Map<number, RecipientState>()
  private readonly pendingDragEnds: DragOut[] = []
  /** the next tick runs even with nothing changed (a peer left, a socket became rich) */
  private wake = false
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
        f: null,
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

  private recipient(key: number): RecipientState {
    let r = this.recipients.get(key)
    if (!r) {
      r = { delivered: new Set(), rich: false, resend: false, followers: '' }
      this.recipients.set(key, r)
    }
    return r
  }

  /**
   * One presence message from a session. Returns false when it was dropped by the 20 Hz cap. `voteOpen`
   * drops `sel`. `key` is the sending socket's handle: a message with `f` (null included) makes that
   * socket a rev-10 reader, also when the 20 Hz cap drops the rest of the message.
   */
  input(sid: string, readonly: boolean, msg: PresenceIn, voteOpen: boolean, key?: number): boolean {
    const p = this.peer(sid, readonly)
    if (key !== undefined && msg.f !== undefined) {
      const r = this.recipient(key)
      if (!r.rich) {
        r.rich = true
        r.resend = true
        r.followers = ''
        this.wake = true
      }
    }
    const now = this.now()
    p.tokens = Math.min(PRESENCE_IN_HZ, p.tokens + ((now - p.last) / 1000) * PRESENCE_IN_HZ)
    p.last = now
    if (p.tokens < 1) return false
    p.tokens -= 1
    this.inCount++
    // a session never follows itself; a rev-9 sender (no `f`) follows nobody the room knows of
    const f = typeof msg.f === 'string' && msg.f !== sid ? msg.f : null
    p.f = f
    p.presence = {
      sid,
      pointer: msg.pointer ? { x: Math.round(msg.pointer.x), y: Math.round(msg.pointer.y) } : null,
      button: msg.button,
      sel: voteOpen ? null : msg.sel,
      view: msg.view,
      idle: msg.idle,
      editing: msg.editing,
      ...(f ? { f } : {}),
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

  /** The last presence of every peer (rev-10 entries). */
  current(): PeerPresence[] {
    return [...this.peers.values()].map((p) => p.presence)
  }

  /**
   * A late joiner's first frame (right after its welcome), or null when there is nobody to show: every
   * other peer, or above 41 sessions the 40 it starts with (`rank`), as rev-9 entries (the socket has
   * not said it reads rev 10 yet). What it holds starts as exactly this.
   */
  welcomeFrame(key: number, sid: string): string | null {
    this.recipients.delete(key)
    const r = this.recipient(key)
    const capped = this.peers.size > CURSORS_PER_RECIPIENT + 1
    const sids = capped ? [...this.rank(sid, r)] : [...this.peers.keys()].filter((s) => s !== sid)
    for (const s of sids) r.delivered.add(s)
    if (!sids.length) return null
    return JSON.stringify({
      type: 'presence',
      peers: sids.map((s) => this.plainOf(this.peers.get(s) as Peer)),
    })
  }

  /** A session left for good: its drag ends; nobody holds it any more (the roster's leave removes it). */
  remove(sid: string): void {
    const p = this.peers.get(sid)
    if (!p) return
    if (p.drag && !p.drag.ended) this.pendingDragEnds.push({ sid, d: p.drag.d, end: true })
    this.peers.delete(sid)
    for (const r of this.recipients.values()) r.delivered.delete(sid)
    this.wake = true
  }

  forgetRecipient(key: number): void {
    this.recipients.delete(key)
  }

  /** The rev-9 entry of a peer: no `f`, no `view.z` (the same object when it has neither). */
  private plainOf(p: Peer): PeerPresence {
    const pr = p.presence
    if (pr.f === undefined && pr.view?.z === undefined) return pr
    const v = pr.view
    return {
      sid: pr.sid,
      pointer: pr.pointer,
      button: pr.button,
      sel: pr.sel,
      view: v ? { x: v.x, y: v.y, w: v.w, h: v.h } : null,
      idle: pr.idle,
      editing: pr.editing,
    }
  }

  /**
   * The peers recipient `sid` should hold above 41 sessions: the one it follows (outside the cap), then
   * up to 40 cursors: pointers in its view it already holds, pointers in its view it does not, pointers
   * elsewhere it holds, pointers elsewhere it does not, and last the peers it holds with no pointer. A
   * peer with no pointer is never added (nothing to draw), only kept while there is room.
   */
  private rank(sid: string, r: RecipientState): Set<string> {
    const me = this.peers.get(sid)
    const view = me?.presence.view ?? null
    const followed = me?.f ? this.peers.get(me.f) : undefined
    const tiers: string[][] = [[], [], [], [], []]
    for (const p of this.peers.values()) {
      if (p.sid === sid || p === followed) continue
      const has = r.delivered.has(p.sid)
      const pt = p.presence.pointer
      if (!pt) {
        if (has) tiers[4]?.push(p.sid)
        continue
      }
      const inView =
        !!view && pt.x >= view.x && pt.x <= view.x + view.w && pt.y >= view.y && pt.y <= view.y + view.h
      tiers[inView ? (has ? 0 : 1) : has ? 2 : 3]?.push(p.sid)
    }
    const out = new Set<string>()
    if (followed) out.add(followed.sid)
    let room = CURSORS_PER_RECIPIENT
    for (const tier of tiers)
      for (const s of tier) {
        if (room <= 0) return out
        out.add(s)
        room--
      }
    return out
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
    const wake = this.wake
    this.wake = false
    if (!changed.length && !drags.length && !wake) return
    const capped = this.peers.size > CURSORS_PER_RECIPIENT + 1
    const changedSids = new Set(changed.map((c) => c.sid))
    const shared = new Map<string, string>()
    // each changed peer is serialized once per tick and form (rev 10, rev 9); a recipient's frame joins the
    // entries it gets (the same JSON as stringifying the object: `{type, peers, off?, drags?, followers?}`
    // in that key order). On a 200-session board the per-view frames (40 cursors each, 200 recipients,
    // 10 Hz) were about a third of sync's CPU in B9's steady state, most of it this serialization
    const richJson = new Map<string, string>()
    const plainJson = new Map<string, string>()
    const entry = (p: Peer, rich: boolean): string => {
      const cache = rich ? richJson : plainJson
      let j = cache.get(p.sid)
      if (j === undefined) {
        j = JSON.stringify(rich ? p.presence : this.plainOf(p))
        cache.set(p.sid, j)
      }
      return j
    }
    const frameFor = (
      peers: readonly Peer[],
      rich: boolean,
      ds: DragOut[],
      off?: readonly string[],
      fl?: readonly string[],
    ) => {
      let s = '{"type":"presence","peers":['
      for (let i = 0; i < peers.length; i++) s += (i ? ',' : '') + entry(peers[i] as Peer, rich)
      s += ']'
      if (off?.length) s += `,"off":${JSON.stringify(off)}`
      if (ds.length) s += `,"drags":${JSON.stringify(ds)}`
      if (fl) s += `,"followers":${JSON.stringify(fl)}`
      return `${s}}`
    }
    // who follows whom (built once per tick, and only when a rev-10 recipient asks)
    let followersOf: Map<string, string[]> | null = null
    const followersFor = (sid: string): string[] => {
      if (!followersOf) {
        const index = new Map<string, string[]>()
        for (const p of this.peers.values()) {
          if (!p.f) continue
          const list = index.get(p.f)
          if (list) list.push(p.sid)
          else index.set(p.f, [p.sid])
        }
        for (const list of index.values()) list.sort()
        followersOf = index
      }
      return (followersOf.get(sid) ?? []).slice(0, MAX_FOLLOWERS)
    }
    for (const r of recipients) {
      const st = this.recipient(r.key)
      const ds = drags.filter((d) => d.sid !== r.sid)
      if (r.congested) {
        // a congested socket gets the drags only; what it holds and its followers list wait
        if (ds.length) {
          r.send(frameFor([], false, ds))
          this.outCount++
        }
        continue
      }
      let fl: string[] | undefined
      let flKey = st.followers
      if (st.rich) {
        const list = followersFor(r.sid)
        flKey = list.join('\n')
        if (flKey !== st.followers) fl = list
      }
      const own = changedSids.has(r.sid)
      let peers: Peer[]
      let off: string[] | undefined
      if (!capped) {
        // everyone gets everyone: the changed peers but itself, and any peer it does not hold yet (the room
        // just dropped to 41, or a congested tick skipped a newcomer), or all of them again (it just became
        // rich: it holds rev-9 entries)
        let have = st.delivered.size
        for (const c of changed) if (c.sid !== r.sid && !st.delivered.has(c.sid)) have++
        const missing = st.resend || have < this.peers.size - (this.peers.has(r.sid) ? 1 : 0)
        if (!missing && !fl) {
          for (const c of changed) if (c.sid !== r.sid) st.delivered.add(c.sid)
          if (changed.length - (own ? 1 : 0) === 0 && !ds.length) continue
          const cacheKey = own || ds.length !== drags.length ? null : st.rich ? 'rich' : 'plain'
          let frame = cacheKey ? shared.get(cacheKey) : undefined
          if (!frame) {
            const list: Peer[] = []
            for (const c of changed) if (c.sid !== r.sid) list.push(this.peers.get(c.sid) as Peer)
            frame = frameFor(list, st.rich, ds)
            if (cacheKey) shared.set(cacheKey, frame)
          }
          r.send(frame)
          this.outCount++
          continue
        }
        peers = []
        for (const p of this.peers.values()) {
          if (p.sid === r.sid) continue
          if (st.resend || changedSids.has(p.sid) || !st.delivered.has(p.sid)) peers.push(p)
          st.delivered.add(p.sid)
        }
      } else {
        // capped: re-ranked on every tick; `off` names what it holds and no longer gets
        const want = this.rank(r.sid, st)
        off = []
        for (const sid of st.delivered) if (!want.has(sid)) off.push(sid)
        peers = []
        for (const sid of want)
          if (st.resend || changedSids.has(sid) || !st.delivered.has(sid))
            peers.push(this.peers.get(sid) as Peer)
        st.delivered.clear()
        for (const sid of want) st.delivered.add(sid)
      }
      st.resend = false
      if (fl) st.followers = flKey
      if (!peers.length && !ds.length && !off?.length && !fl) continue
      r.send(frameFor(peers, st.rich, ds, off, fl))
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
