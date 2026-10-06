// Presence (docs/EXCALIDRAW-MIGRATION.md §2.7): ephemeral, never written to the board file.
//
//  - Input: `{pointer, button, sel, view, idle, editing, drag?}` at most 20 Hz per session (excess
//    dropped). No identity fields: `sid`, `uid`, `name`, `color`, `guest` come from the ticket (the
//    roster). Pointer coordinates are rounded to integers, drag deltas to 0.1. While a dot vote is open,
//    `sel` is dropped; while it is anonymous (every open vote today), `button` is relayed as 'up' (RT-03,
//    wave J3: a dot is cast with a click on an object, so a peer's button going down there, next to the
//    vote's live counts, told everyone who voted for what). The pointer itself still moves: hiding it
//    over objects needs a hit test per message (not cheap), and the vote's counts now change once per
//    window only (apps/api/src/features/workshops/vote-tally.ts), so a cursor resting on an object no
//    longer lines up with one ballot unless its owner was the only one voting in that window.
//  - `presence` out at 10 Hz, changed peers only. With 41 sessions or fewer, nobody is capped and one
//    frame (serialized once) serves everyone whose own presence did not change; a recipient whose own
//    entry is in the batch gets a copy without it. Above that, each recipient gets at most 40 cursors
//    (CR-3C-1): peers whose pointer is inside its `view` first (the ones it already gets before
//    newcomers), then the others it already gets, then out-of-view newcomers; a peer that falls out of
//    that set is named in `off`, so a view change or a newcomer in view replaces an out-of-view cursor
//    (before, the first 40 stayed for good and nobody else ever appeared). The peer a recipient follows
//    (its `f`) is always delivered, outside the cap: a follower's camera needs its `view`. The room
//    tracks what each recipient holds (`held`), so `off` names only peers it has, and a room that drops
//    back to 41 sends each recipient the peers it was not getting.
//  - The rank (D1, wave D): CR-3C-1 re-ranked every recipient on every tick (200 recipients x 200 peers
//    at 10 Hz on L1's board: about 15 points of the 0.5 CPU quota, C6's NAS re-run). The set it picks is
//    a fixed point: ranked again with nothing moved, it comes out the same. So a recipient is ranked again
//    only when its view or its `f` changed, a peer it held left, the room crossed 41, a congested tick
//    left it behind, or a pointer moved so that the set can change (a held cursor left the view or went
//    away while a cursor it does not hold could take its slot; a cursor it does not hold came into its
//    view while it holds one outside; a cursor appeared while it holds fewer than 40 or one without a
//    pointer); and, as a backstop, every RERANK_EVERY_TICKS ticks. The room keeps, per recipient, where
//    each held peer is relative to its view and how many are in, out and without a pointer, so the test
//    is the pass over what it holds that the frame needs anyway (no lookups: a changed peer carries the
//    tick's number, `sentIn`). A rank keeps what stays in place and uses the tick's lists of the peers
//    in, out of and without a pointer for that view, built once per tick per distinct view and shared by
//    every recipient with that view (`Bucket`). The set is the same as CR-3C-1's on every tick (the
//    differential test against wave A's relay, `apps/sync/test/presence/presence-rank.test.ts`).
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
  /** the tick (`epoch`) whose frames carry its latest change */
  sentIn: number
  /** a rank's scratch: that rank's stamp while the recipient being ranked holds it */
  mark: number
}

/** One peer a recipient holds: the peer, and above 41 sessions its place for that recipient. */
interface Slot {
  readonly peer: Peer
  place: number
  /** the last rank (its stamp) that kept it */
  stamp: number
  /** the rank that added it */
  readonly since: number
}

/** Where a peer is for one recipient (the rank's tiers): its pointer inside the recipient's view, ... */
const IN = 0
/** ... its pointer elsewhere (or the recipient has no view), ... */
const OUT = 1
/** ... no pointer (nothing to draw: kept only while there is room, never added) */
const NONE = 2
/** The followed peer in what a recipient holds: outside the cap, never counted. */
const FOLLOWED = 3
/** A peer held below the cap (41 sessions or fewer): not ranked, its place unknown. */
const UNRANKED = -1

interface Rect {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/** IN, OUT or NONE: the same test as CR-3C-1's rank (the edges are inside). */
const place = (pt: { x: number; y: number } | null, v: Rect | null): number =>
  !pt ? NONE : v && pt.x >= v.x && pt.x <= v.x + v.w && pt.y >= v.y && pt.y <= v.y + v.h ? IN : OUT

/**
 * A recipient is ranked again at least every this many ticks (5 s at 10 Hz), staggered by its handle key,
 * whatever moved: a backstop under the change test, which alone gives the same set (the differential test).
 */
export const RERANK_EVERY_TICKS = 50

/** One view's peers by place, in the room's order, for one tick: shared by every recipient with that view. */
interface Bucket {
  readonly inside: Peer[]
  readonly outside: Peer[]
  readonly none: Peer[]
}

/** What the room knows of one recipient socket (by its handle key). */
interface RecipientState {
  /**
   * the peers it holds: what it was sent, less what `off` and the roster's leaves took away; above 41
   * sessions each with its place (IN, OUT, NONE; FOLLOWED for the peer it follows) as of its last tick
   */
  readonly held: Map<string, Slot>
  /** it has sent `f`: it reads the rev-10 fields (`f`, `view.z`, `followers`) */
  rich: boolean
  /** every peer it holds goes again on the next tick (it just became rich: it holds them without f, z) */
  resend: boolean
  /** the followers list it holds, joined ('' for none: it starts with none) */
  followers: string
  /**
   * `held` is what the rank gives for it, with the places and the counts below current, as of the tick
   * numbered `epoch`, for the view (`vx`.. when `hasView`) and the `f` stored here. False below the cap,
   * after a welcome, and when a peer it held left: its next tick ranks it.
   */
  ranked: boolean
  epoch: number
  /** of the held peers but the followed one: how many are IN, OUT and NONE */
  nIn: number
  nOut: number
  nNone: number
  hasView: boolean
  vx: number
  vy: number
  vw: number
  vh: number
  f: string | null
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
  /** per recipient socket (its handle key) */
  private readonly recipients = new Map<number, RecipientState>()
  private readonly pendingDragEnds: DragOut[] = []
  /** the next tick runs even with nothing changed (a peer left, a socket became rich) */
  private wake = false
  /** the number of the last tick that sent anything (a tick with nothing changed returns early) */
  private epoch = 0
  /** the last rank's number (`Slot.stamp`, `Peer.mark`) */
  private stamp = 0
  inCount = 0
  outCount = 0
  droppedDrags = 0
  /** recipients ranked (CR-3C-1's rank, above 41 sessions; welcomes included) */
  rankCalls = 0
  /** a view's peers sorted by place for a tick (`Bucket`): at most once per distinct view per tick */
  bucketBuilds = 0

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
        sentIn: 0,
        mark: 0,
      }
      this.peers.set(sid, p)
    }
    p.readonly = readonly
    return p
  }

  private recipient(key: number): RecipientState {
    let r = this.recipients.get(key)
    if (!r) {
      r = {
        held: new Map(),
        rich: false,
        resend: false,
        followers: '',
        ranked: false,
        epoch: 0,
        nIn: 0,
        nOut: 0,
        nNone: 0,
        hasView: false,
        vx: 0,
        vy: 0,
        vw: 0,
        vh: 0,
        f: null,
      }
      this.recipients.set(key, r)
    }
    return r
  }

  /**
   * One presence message from a session. Returns false when it was dropped by the 20 Hz cap. `vote`: an
   * open vote drops `sel`; an open ANONYMOUS one also relays `button` as 'up' (RT-03). A boolean means an
   * open anonymous vote, or none (every open vote is anonymous today, workshop-state.ts). `key` is the
   * sending socket's handle: a message with `f` (null included) makes that socket a rev-10 reader, also
   * when the 20 Hz cap drops the rest of the message.
   */
  input(
    sid: string,
    readonly: boolean,
    msg: PresenceIn,
    vote: boolean | { readonly voteOpen: boolean; readonly anonymous: boolean },
    key?: number,
  ): boolean {
    const voteOpen = typeof vote === 'boolean' ? vote : vote.voteOpen
    const secretBallot = typeof vote === 'boolean' ? vote : vote.voteOpen && vote.anonymous
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
      // RT-03: casting a dot is a click on an object; a peer's button going down there is a ballot
      button: secretBallot ? 'up' : msg.button,
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
    if (this.peers.size > CURSORS_PER_RECIPIENT + 1) {
      // ranked again on its first tick (`ranked` is false), as CR-3C-1 did on every tick
      const me = this.peers.get(sid)
      const view = me?.presence.view ?? null
      this.rank(r, this.bucket(view), sid, view, me?.f ? this.peers.get(me.f) : undefined)
    } else
      for (const p of this.peers.values())
        if (p.sid !== sid) r.held.set(p.sid, { peer: p, place: UNRANKED, stamp: 0, since: 0 })
    if (!r.held.size) return null
    const peers: PeerPresence[] = []
    for (const slot of r.held.values()) peers.push(this.plainOf(slot.peer))
    return JSON.stringify({ type: 'presence', peers })
  }

  /** A session left for good: its drag ends; nobody holds it any more (the roster's leave removes it). */
  remove(sid: string): void {
    const p = this.peers.get(sid)
    if (!p) return
    if (p.drag && !p.drag.ended) this.pendingDragEnds.push({ sid, d: p.drag.d, end: true })
    this.peers.delete(sid)
    // a recipient that held it has a free slot: its next tick ranks it
    for (const r of this.recipients.values()) if (r.held.delete(sid)) r.ranked = false
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

  /** Every peer by its place in `view`, in the room's order (a tick shares one per distinct view). */
  private bucket(view: Rect | null): Bucket {
    this.bucketBuilds++
    const b: Bucket = { inside: [], outside: [], none: [] }
    for (const p of this.peers.values()) {
      const c = place(p.presence.pointer, view)
      ;(c === IN ? b.inside : c === OUT ? b.outside : b.none).push(p)
    }
    return b
  }

  /**
   * Ranks recipient `st` (`sid`, its `view`, the peer it follows) in place, CR-3C-1's rank, and returns the
   * sids it no longer gets (`off`). It holds the one it follows (outside the cap), then up to 40 cursors:
   * pointers in its view it already holds, pointers in its view it does not, pointers elsewhere it holds,
   * pointers elsewhere it does not, and last the peers it holds with no pointer. A peer with no pointer is
   * never added (nothing to draw), only kept while there is room. Within a tier the room's order decides
   * who fits; a held tier that fits whole is taken as it is, without the bucket's list. A kept peer keeps
   * its slot (its place brought up to date, `stamp` this rank's); a newcomer's slot has `since` this rank's.
   * `b` is `view`'s bucket. It counts the places; the view and `f` are stored by `settle`.
   */
  private rank(
    st: RecipientState,
    b: Bucket,
    sid: string,
    view: Rect | null,
    followed: Peer | undefined,
  ): string[] {
    this.rankCalls++
    const stamp = ++this.stamp
    const held = st.held
    const hIn: Slot[] = []
    const hOut: Slot[] = []
    const hNone: Slot[] = []
    for (const slot of held.values()) {
      const p = slot.peer
      p.mark = stamp
      if (p === followed) {
        slot.place = FOLLOWED
        slot.stamp = stamp
      } else if (p.sid !== sid) {
        const c = place(p.presence.pointer, view)
        ;(c === IN ? hIn : c === OUT ? hOut : hNone).push(slot)
      }
    }
    const added: Slot[] = []
    if (followed && followed.mark !== stamp)
      added.push({ peer: followed, place: FOLLOWED, stamp, since: stamp })
    st.nIn = 0
    st.nOut = 0
    st.nNone = 0
    const count = (c: number) => {
      if (c === IN) st.nIn++
      else if (c === OUT) st.nOut++
      else st.nNone++
    }
    let room = CURSORS_PER_RECIPIENT
    const keep = (slot: Slot, c: number) => {
      slot.place = c
      slot.stamp = stamp
      count(c)
      room--
    }
    // a held tier: whole when it fits, else the first of it in the room's order
    const takeHeld = (list: Slot[], ordered: readonly Peer[], c: number) => {
      if (list.length <= room) {
        for (const slot of list) keep(slot, c)
        return
      }
      for (const p of ordered) {
        if (room <= 0) return
        if (p.mark === stamp && p !== followed && p.sid !== sid) keep(held.get(p.sid) as Slot, c)
      }
    }
    // newcomers of a tier, in the room's order (`mark`: held)
    const takeNew = (ordered: readonly Peer[], c: number) => {
      for (const p of ordered) {
        if (room <= 0) return
        if (p.mark === stamp || p === followed || p.sid === sid) continue
        added.push({ peer: p, place: c, stamp, since: stamp })
        count(c)
        room--
      }
    }
    takeHeld(hIn, b.inside, IN)
    takeNew(b.inside, IN)
    if (room > 0) takeHeld(hOut, b.outside, OUT)
    if (room > 0) takeNew(b.outside, OUT)
    if (room > 0) takeHeld(hNone, b.none, NONE)
    const off: string[] = []
    for (const slot of held.values())
      if (slot.stamp !== stamp) {
        off.push(slot.peer.sid)
        held.delete(slot.peer.sid)
      }
    for (const slot of added) held.set(slot.peer.sid, slot)
    return off
  }

  /** A held peer moved: its place is now `now` (IN, OUT or NONE), and the counts follow. */
  private replace(st: RecipientState, slot: Slot, now: number): void {
    const was = slot.place
    if (was === now) return
    if (was === IN) st.nIn--
    else if (was === OUT) st.nOut--
    else st.nNone--
    if (now === IN) st.nIn++
    else if (now === OUT) st.nOut++
    else st.nNone++
    slot.place = now
  }

  /** Did a peer recipient `sid` does not hold move into its view this tick? */
  private newcomerIn(changed: readonly Peer[], sid: string, st: RecipientState, view: Rect | null): boolean {
    for (const p of changed)
      if (place(p.presence.pointer, view) === IN && p.sid !== sid && !st.held.has(p.sid)) return true
    return false
  }

  /** After a rank in a tick: what it holds is the rank's for this view and `f`, as of tick `epoch`. */
  private settle(st: RecipientState, view: Rect | null, f: string | null): void {
    st.hasView = view !== null
    st.vx = view?.x ?? 0
    st.vy = view?.y ?? 0
    st.vw = view?.w ?? 0
    st.vh = view?.h ?? 0
    st.f = f
    st.ranked = true
  }

  /** The 10 Hz tick: sends the changed peers and the drag deltas to every recipient. */
  tick(recipients: readonly PresenceRecipient[]): void {
    const changed: Peer[] = []
    for (const p of this.peers.values())
      if (p.dirty) {
        changed.push(p)
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
    const epoch = ++this.epoch
    // a changed peer is one with `sentIn === epoch` (no set lookup per recipient and held peer)
    for (const p of changed) p.sentIn = epoch
    const capped = this.peers.size > CURSORS_PER_RECIPIENT + 1
    const shared = new Map<string, string>()
    // above the cap: the peers with a pointer (what a recipient does not hold of them could take a slot),
    // and each distinct view's bucket, built when a recipient with that view is ranked
    let pointers = 0
    if (capped) for (const p of this.peers.values()) if (p.presence.pointer) pointers++
    const buckets = new Map<string, Bucket>()
    const bucketOf = (view: Rect | null): Bucket => {
      const k = view ? `${view.x},${view.y},${view.w},${view.h}` : ''
      let b = buckets.get(k)
      if (!b) {
        b = this.bucket(view)
        buckets.set(k, b)
      }
      return b
    }
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
      // the tick's own list unless a drag in it is the recipient's
      const ds =
        drags.length && drags.some((d) => d.sid === r.sid) ? drags.filter((d) => d.sid !== r.sid) : drags
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
      const me = this.peers.get(r.sid)
      const own = me?.sentIn === epoch
      let peers: Peer[]
      let off: string[] | undefined
      if (!capped) {
        // everyone gets everyone: the changed peers but itself, and any peer it does not hold yet (the room
        // just dropped to 41, or a congested tick skipped a newcomer), or all of them again (it just became
        // rich: it holds rev-9 entries)
        st.ranked = false
        let have = st.held.size
        for (const p of changed) if (p.sid !== r.sid && !st.held.has(p.sid)) have++
        const missing = st.resend || have < this.peers.size - (me ? 1 : 0)
        if (!missing && !fl) {
          for (const p of changed)
            if (p.sid !== r.sid && !st.held.has(p.sid))
              st.held.set(p.sid, { peer: p, place: UNRANKED, stamp: 0, since: 0 })
          if (changed.length - (own ? 1 : 0) === 0 && !ds.length) continue
          const cacheKey = own || ds.length !== drags.length ? null : st.rich ? 'rich' : 'plain'
          let frame = cacheKey ? shared.get(cacheKey) : undefined
          if (!frame) {
            const list: Peer[] = []
            for (const p of changed) if (p.sid !== r.sid) list.push(p)
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
          const has = st.held.has(p.sid)
          if (st.resend || p.sentIn === epoch || !has) peers.push(p)
          if (!has) st.held.set(p.sid, { peer: p, place: UNRANKED, stamp: 0, since: 0 })
        }
      } else {
        // capped: what it holds is the rank's fixed point, so it is ranked again only when that can change
        const view = me?.presence.view ?? null
        const f = me?.f ?? null
        const followed = f ? this.peers.get(f) : undefined
        let rerank =
          !st.ranked ||
          st.epoch !== epoch - 1 ||
          (epoch + r.key) % RERANK_EVERY_TICKS === 0 ||
          st.f !== f ||
          (view
            ? !st.hasView || st.vx !== view.x || st.vy !== view.y || st.vw !== view.w || st.vh !== view.h
            : st.hasView) ||
          (followed !== undefined && !st.held.has(followed.sid))
        peers = []
        if (!rerank) {
          // the changed peers it holds go out; each one's place is brought up to date
          const full = st.nIn + st.nOut + st.nNone === CURSORS_PER_RECIPIENT
          const allIn = full && st.nOut === 0 && st.nNone === 0
          if (st.resend || changed.length >= st.held.size) {
            for (const slot of st.held.values()) {
              const p = slot.peer
              const moved = p.sentIn === epoch
              if (!moved && !st.resend) continue
              peers.push(p)
              if (moved && slot.place !== FOLLOWED) this.replace(st, slot, place(p.presence.pointer, view))
            }
          } else
            for (const p of changed) {
              const slot = st.held.get(p.sid)
              if (!slot) continue
              peers.push(p)
              if (slot.place !== FOLLOWED) this.replace(st, slot, place(p.presence.pointer, view))
            }
          // can a peer it does not hold now take a slot? (`held` was the rank's fixed point last tick)
          const others =
            pointers -
            st.nIn -
            st.nOut -
            (me?.presence.pointer ? 1 : 0) -
            (followed?.presence.pointer ? 1 : 0)
          if (st.nNone > 0 || !full)
            rerank = others > 0 // any cursor outranks a held peer with no pointer, and fills a free slot
          else if (st.nOut > 0)
            // a cursor in its view outranks a held one outside it. Last tick none it does not hold was in
            // its view, unless all it held were (then the ones that did not fit may be): ranked again
            rerank = allIn || this.newcomerIn(changed, r.sid, st, view)
        }
        if (rerank) {
          // `off` names what it holds and no longer gets; a newcomer goes out whole
          off = this.rank(st, bucketOf(view), r.sid, view, followed)
          const stamp = this.stamp
          peers = []
          for (const slot of st.held.values())
            if (st.resend || slot.since === stamp || slot.peer.sentIn === epoch) peers.push(slot.peer)
          this.settle(st, view, f)
        }
        st.epoch = epoch
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
