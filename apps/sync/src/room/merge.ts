// One push through the accept algorithm (docs/EXCALIDRAW-MIGRATION.md §2.4.3, steps 1–12), inside the
// drain's transaction and the push's SAVEPOINT. Synchronous and deterministic given the stored rows, the
// lease table and the clock; the room owns the transaction and the fan-out.
//
//   A. each op: READ_ONLY, GONE, caps, TYPE_CHANGE, lock, lease (partial accept), customData classes,
//      STALE, merge (groups overlaid, `path` whole, boundElements add/remove, customData per key,
//      lobbyServer stamped), the conditional fit (§2.9.4), rounding (§3.5), the element schema;
//   B. cross-element invariants (§2.4.4, room/invariants.ts): rejections, then repairs;
//   C. server-derived bound arrows (§2.9.4 rule 7, room/fit.ts): re-snaps and their labels;
//   D. index (step 11): null, invalid or duplicate keys, labels after their containers;
//   E. the ack: per-op `fix`, `fitDropped`, `denied`, and `derived` rows;
//   F. upsert with this clock, `lb_deleted` rows for isDeleted false→true, lb_doc writes.

import { canWriteDocKey, DocSet, docValueProblem, TAG_DEF_KEY_PREFIX } from '@draftroom/canvas-schema/doc'
import { checkElement, redactTombstone, type WireElement } from '@draftroom/canvas-schema/elements'
import { isBindable, layoutBoundText, layoutStickyNote } from '@draftroom/canvas-schema/engine'
import {
  fieldGroupOf,
  kindOf,
  overlayPatch,
  pathUnitOf,
  RESNAP_TRIGGER_FIELDS,
  stripEngineArtifacts,
} from '@draftroom/canvas-schema/groups'
import {
  GEOMETRY_TOLERANCE_PX,
  GUEST_BOARD_ITEM_CAP,
  GUEST_ITEM_CAP,
  GUEST_TAG_DEF_CAP,
  isAllowedLink,
  MAX_ITEMS,
  MAX_LIVE_ELEMENTS,
  MAX_TAG_DEFS,
  pdfPageOf,
  roundGeometry,
  STALE_REPLAY_MS,
  versionIdOf,
} from '@draftroom/canvas-schema/limits'
import {
  type AckResult,
  CONTRACTS_REV,
  type CreateOp,
  type DerivedRow,
  GROUP_NAMES,
  lobbyWriteOf,
  type PatchOp,
  pathUnitProblem,
  type RejectCode,
} from '@draftroom/canvas-schema/protocol'
import type { FileRefAnswer, FileRefsCache } from '../file-refs.ts'
import type { GroupMap, LiveCounts, WriterLedger } from './caches.ts'
import {
  type CustomDataContext,
  canonicalizeFile,
  checkCreateLobby,
  checkPatchLobby,
  freshLobbyServer,
  lockExemptKey,
  tagDefKey,
  type Writer,
} from './custom-data.ts'
import { resnapDerived } from './fit.ts'
import { type IndexCache, isValidIndexKey, keyAbove } from './index-keys.ts'
import { enforceInvariants } from './invariants.ts'
import type { LeaseTable } from './lease.ts'
import type { BoardStore, ElementRow } from './store.ts'
import type { PreparedPush, PushOutcome, SessionIdentity } from './types.ts'

// biome-ignore lint/suspicious/noExplicitAny: stored elements are schema-checked WireElements, read field by field
export type El = WireElement & Record<string, any>

/** What the push reads and updates besides the board file. */
export interface MergeEnv {
  readonly store: BoardStore
  readonly leases: LeaseTable
  readonly index: IndexCache
  readonly groups: GroupMap
  readonly counts: LiveCounts
  /** the dot-vote state: open, closed, or unknown (the api pull has not answered) */
  readonly voteOpen: boolean | null
  readonly fileCache: FileRefsCache
  readonly ledger: WriterLedger
  /** items created by each guest (by uid, not session: a new tab id is no new budget, V2), live at open or since */
  readonly guestCreated: Map<string, number>
  readonly now: number
  readonly epoch: string
  /** the room session `lb_deleted` rows name (one per room open; store.ts DeletedRowWrite.session) */
  readonly deletedSession: string
  nonce(): number
}

/** One element as this push sees it. */
export interface Work {
  readonly id: string
  readonly row: ElementRow | null
  /** as stored when the push began (null: not stored) */
  readonly before: El | null
  el: El | null
  gclock: Record<string, number>
  /** ops of this push that wrote it */
  writers: number[]
  /** the server re-snapped it or laid out its label (rule 7) */
  derived: boolean
  /** as it stood right after the last op of this push that wrote it (for `fix`) */
  opAfter: El | null
}

interface OpState {
  readonly id: string
  readonly kind: 'c' | 'p'
  ok: boolean
  code?: RejectCode
  create?: El
  patch?: PatchOp
  /** groups and keys the op applied (for `fix`) */
  applied: { groups: Record<string, Record<string, unknown>>; c: Record<string, unknown> }
  fitDropped?: boolean
  denied?: { groups: string[]; code: RejectCode }
}

const equal = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T))
const isLabel = (el: El | null | undefined): boolean => !!el && el.type === 'text' && !!el.containerId
const isFreeText = (el: El | null | undefined): boolean => !!el && el.type === 'text' && !el.containerId
/** The largest `version` a create may carry from a client. */
const MAX_CLIENT_VERSION = 2 ** 31
/**
 * TAGS-1: the last places of the board's tag list (MAX_TAG_DEFS) kept for members: name-only guests, every uid
 * together, add a new tag-list key only while the list has fewer than MAX_TAG_DEFS - this (180 of 200), so a
 * workshop of guests (10 keys each, GUEST_TAG_DEF_CAP) cannot fill it for the board's own people. A guest's
 * refused key answers GUEST_LIMIT, as its own cap does.
 */
export const MEMBER_TAG_DEF_RESERVE = 20
const FIT_CONTAINERS = new Set(['rectangle', 'ellipse', 'diamond', 'stickynote'])
/** The lease id that protects an element's `text`, `layout` and `life`: a label's container, else itself. */
export const leaseIdOf = (el: El): string => (isLabel(el) ? (el.containerId as string) : el.id)

/** Server-owned and bookkeeping fields: never compared as "the user's change". */
const NOT_CONTENT = new Set(['version', 'versionNonce', 'updated'])
/** The element's axis-aligned box meets the frame's (Excalidraw's membership rule; rotation ignored). */
const overlapsFrame = (el: El, frame: El): boolean => {
  const box = (e: El) => {
    const w = Math.abs(Number(e.width ?? 0))
    const h = Math.abs(Number(e.height ?? 0))
    const x = Math.min(Number(e.x), Number(e.x) + Number(e.width ?? 0))
    const y = Math.min(Number(e.y), Number(e.y) + Number(e.height ?? 0))
    return { x1: x, y1: y, x2: x + w, y2: y + h }
  }
  const a = box(el)
  const f = box(frame)
  return a.x1 <= f.x2 && a.x2 >= f.x1 && a.y1 <= f.y2 && a.y2 >= f.y1
}

/** What a create over a tombstone may differ in and still be that tombstone's content coming back. */
const NOT_REVIVED_CONTENT = new Set([
  ...NOT_CONTENT,
  'isDeleted',
  'customData',
  'index',
  'created',
  'status',
  'locked',
  'boundElements',
])
const sameRevivedContent = (tombstone: El, pushed: El): boolean => {
  const keys = (e: El) => Object.keys(e).filter((k) => !NOT_REVIVED_CONTENT.has(k) && e[k] !== undefined)
  const ka = keys(tombstone)
  const kb = keys(pushed)
  if (ka.length !== kb.length) return false
  for (const k of ka) if (!equal(tombstone[k], pushed[k])) return false
  return true
}

const sameContent = (a: El, b: El): boolean => {
  const ka = Object.keys(a).filter((k) => !NOT_CONTENT.has(k) && a[k] !== undefined)
  const kb = Object.keys(b).filter((k) => !NOT_CONTENT.has(k) && b[k] !== undefined)
  if (ka.length !== kb.length) return false
  for (const k of ka) if (!equal(a[k], b[k])) return false
  return true
}

export class PushApplier {
  private readonly work = new Map<string, Work>()
  private readonly ops: OpState[] = []
  private readonly writer: Writer
  private readonly ctx: CustomDataContext
  private readonly docWrites: Record<string, unknown> = {}
  private docDenied: { keys: string[]; code: RejectCode } | undefined
  /** why each refused doc key of this push was refused (a `tag:<key>` on it answers the same, CR-3D-5) */
  private readonly docDeniedCodes = new Map<string, RejectCode>()
  /**
   * The `tagDef:*` keys this guest wrote while the room is open (their lb_doc clock is one of its pushes,
   * by the writer ledger), plus this push's: GUEST_TAG_DEF_CAP counts them (CR-3D-5). Loaded on first use.
   */
  private guestTagKeys: Set<string> | null = null
  /** arrows whose own geometry or bindings this push wrote (rule 7 trigger 2) */
  readonly resnapArrows = new Set<string>()
  /** bindable elements whose x, y, width, height or angle changed (rule 7 trigger 1) */
  readonly movedTargets = new Set<string>()
  /** live elements and items this push added so far (the caps count them before Phase F) */
  private addedElements = 0
  private addedItems = 0
  /**
   * Items this push adds to a guest's count, by guest uid (D5): items with a new id this guest created, live
   * or deleted, and labels detached into free texts, counted against the label's CREATOR, whoever
   * detaches (V2 re-check P-G4: counted against the detacher, a second guest uid grew the first one's items
   * past the cap).
   */
  private readonly addedGuestItems = new Map<string, number>()
  /** the same items, summed over every guest uid (GUEST_BOARD_ITEM_CAP, CR-W5-FIX-3) */
  private addedGuestTotal = 0
  /** every guest uid's items before this push, summed on first use (env.guestCreated is fixed until Phase F) */
  private guestBoardBefore: number | null = null
  /** frames this push moves (a `pos` patch on a live, unlocked frame): id → the move (W5-05) */
  private readonly frameMoves = new Map<string, { dx: number; dy: number }>()
  /** locked elements whose position this push moved with their frame (W5-05): id → the frame */
  private readonly followers = new Map<string, string>()

  private readonly env: MergeEnv
  private readonly s: SessionIdentity
  private readonly push: PreparedPush
  /** this push's clock (used only if it writes anything) */
  readonly clock: number
  /** the contracts revision of the push's socket (CONTRACTS_REV 12; this room's for the server's own writes) */
  private readonly writerRev: number

  constructor(env: MergeEnv, s: SessionIdentity, push: PreparedPush, clock: number) {
    this.env = env
    this.s = s
    this.push = push
    this.clock = clock
    this.writerRev = push.writerRev ?? CONTRACTS_REV
    this.writer = { uid: s.uid, name: s.name, guest: s.guest, role: s.role }
    this.ctx = {
      writer: this.writer,
      voteOpen: env.voteOpen,
      tagExists: (key) => this.tagExists(key),
      tagDenied: (key) => this.docDeniedCodes.get(tagDefKey(key)) ?? null,
      fileRef: (v) => this.fileRef(v),
    }
  }

  // ---- the working set -------------------------------------------------------------------------

  /** The element's working copy (loaded once from the board file). */
  get(id: string): Work {
    let w = this.work.get(id)
    if (!w) {
      const row = this.env.store.get(id)
      const before = row ? (row.el as El) : null
      w = {
        id,
        row,
        before,
        el: before ? clone(before) : null,
        gclock: { ...(row?.gclock ?? {}) },
        writers: [],
        derived: false,
        opAfter: null,
      }
      this.work.set(id, w)
    }
    return w
  }
  /** The live working element, or null. */
  live(id: string | null | undefined): El | null {
    if (!id) return null
    const el = this.get(id).el
    return el && !el.isDeleted ? el : null
  }
  worked(): Iterable<Work> {
    return this.work.values()
  }
  get sessionId(): string {
    return this.s.sid
  }
  get now(): number {
    return this.env.now
  }
  get leases(): LeaseTable {
    return this.env.leases
  }
  get store(): BoardStore {
    return this.env.store
  }
  get groupMap(): GroupMap {
    return this.env.groups
  }
  opsState(): readonly OpState[] {
    return this.ops
  }
  /** Is `id` leased by another session now? */
  leasedByOther(id: string): boolean {
    const h = this.env.leases.holderOf(id, this.env.now)
    return !!h && h.sid !== this.s.sid
  }

  private tagExists(tagKey: string): boolean {
    const key = tagDefKey(tagKey)
    if (key in this.docWrites) return this.docWrites[key] !== null
    const d = this.env.store.docGet(key)
    return !!d && d.value !== null
  }
  private fileRef(versionId: string): FileRefAnswer | undefined {
    return this.push.files.get(versionId) ?? this.env.fileCache.get(versionId)
  }

  /** A server write (repair, re-snap, label layout) to `w`: bumps the version once per push. */
  bump(w: Work): void {
    const el = w.el as El
    if (!w.before || el.version <= w.before.version) {
      el.version = (w.before?.version ?? 0) + 1
      el.versionNonce = this.env.nonce()
      el.updated = this.env.now
    }
  }

  // ---- the run ---------------------------------------------------------------------------------

  run(): PushOutcome {
    if (this.push.relayout) this.serverRelayout(this.push.relayout)
    this.applyDoc()
    if (!this.s.readonly) this.planFrameMoves()
    this.push.ops.forEach((pre, i) => {
      this.ops[i] = { id: pre.id, kind: pre.op?.k ?? 'p', ok: false, applied: { groups: {}, c: {} } }
      if (pre.reject) this.reject(i, pre.reject)
      else if (this.s.readonly) this.reject(i, 'READ_ONLY')
      else if (pre.op.k === 'c') this.applyCreate(i, pre.op)
      else this.applyPatch(i, pre.op)
    })
    this.settleFollowers()
    enforceInvariants(this) // B
    // a frame the invariants put back takes its locked members' moves back with it (never half a move)
    if (this.settleFollowers()) enforceInvariants(this)
    resnapDerived(this) // C
    this.assignIndexes() // D
    return this.finish() // E, F
  }

  // ---- A: ops ----------------------------------------------------------------------------------

  /** Refuses op `i`: nothing of it is applied. */
  reject(i: number, code: RejectCode): void {
    const st = this.ops[i] as OpState
    st.ok = false
    st.code = code
  }

  /** Reverts every op of this push that wrote `id` (the element goes back to its state before the push). */
  revert(id: string, code: RejectCode): void {
    const w = this.get(id)
    for (const i of w.writers) this.reject(i, code)
    w.writers = []
    w.el = w.before ? clone(w.before) : null
    w.gclock = { ...(w.row?.gclock ?? {}) }
    w.opAfter = null
    this.resnapArrows.delete(id)
    this.movedTargets.delete(id)
  }

  private writerOk(w: Work, i: number, next: El): void {
    w.el = next
    w.writers.push(i)
    w.opAfter = clone(next)
  }

  /**
   * CONTRACTS_REV 12 (the stale-client rule, canvas-schema protocol.ts `lobbyWriteOf`): the `customData.lobby`
   * values this push writes, with the fields its writer's revision cannot know kept from the stored values. A
   * rev-11 tab writes `present` whole as `{index, skip}` (or removes it) and has never heard of `mins`: its
   * reorder or skip keeps the frame's planned minutes. `c` itself when nothing is kept (every writer of this
   * revision). The caller keeps what was pushed for the ack, so its `fix` names the stored value (`c:<key>`),
   * which the writer folds into its undo step like any server fix.
   */
  private keepUnknownFields(
    c: Readonly<Record<string, unknown>>,
    stored: Readonly<Record<string, unknown>>,
  ): Record<string, unknown> {
    if (this.writerRev >= CONTRACTS_REV) return c as Record<string, unknown>
    let out: Record<string, unknown> | null = null
    for (const [k, v] of Object.entries(c)) {
      const kept = lobbyWriteOf(this.writerRev, k, v, stored[k])
      if (kept === v) continue
      out ??= { ...c }
      out[k] = kept
    }
    return out ?? (c as Record<string, unknown>)
  }

  private fileProblem(el: El): RejectCode | null {
    if (el.type !== 'image') return null
    const fileId = el.fileId as string
    const ans = this.fileRef(versionIdOf(fileId))
    if (!ans) return 'UNAVAILABLE'
    if (ans.status !== 'ok') return 'INVALID'
    const page = pdfPageOf(fileId)
    if (page !== null && ans.ref.pageCount !== null && page > ans.ref.pageCount) return 'INVALID'
    return null
  }

  /** ELEMENT_LIMIT for one more live element (§3.5), counting this push's earlier ones. */
  private capProblem(el: El): RejectCode | null {
    const label = isLabel(el)
    if (this.env.counts.elements + this.addedElements + 1 > MAX_LIVE_ELEMENTS) return 'ELEMENT_LIMIT'
    if (!label && this.env.counts.items + this.addedItems + 1 > MAX_ITEMS) return 'ELEMENT_LIMIT'
    return null
  }
  /**
   * GUEST_LIMIT for one more item a guest creates under a new id (§3.5, D5): counted per guest uid over
   * every item the board holds that the guest created, live AND deleted. A tombstone create counts like a
   * live one, and a revival (a create over a tombstone, a `life` patch) creates nothing new, so minting
   * tombstones and reviving them no longer gets past the cap (V2's re-check: 650 live items against 500).
   *
   * Every guest uid together is held to GUEST_BOARD_ITEM_CAP the same way (CR-W5-FIX-3): the api mints a
   * new guest uid for each cookie-less join of an editor link, so the per-uid cap alone multiplied by the
   * number of incognito windows. Rebuilt from the rows when the room opens (element-room.ts rebuildCaches).
   */
  private guestCapProblem(el: El, uid = this.s.uid): RejectCode | null {
    // an account is never held to the guests' caps (applyCreate asks for every writer)
    if (!this.s.guest || isLabel(el)) return null
    if ((this.env.guestCreated.get(uid) ?? 0) + (this.addedGuestItems.get(uid) ?? 0) + 1 > GUEST_ITEM_CAP)
      return 'GUEST_LIMIT'
    if (this.guestBoardBefore === null) {
      let n = 0
      for (const v of this.env.guestCreated.values()) n += v
      this.guestBoardBefore = n
    }
    return this.guestBoardBefore + this.addedGuestTotal + 1 > GUEST_BOARD_ITEM_CAP ? 'GUEST_LIMIT' : null
  }
  private addGuestItem(uid: string): void {
    this.addedGuestItems.set(uid, (this.addedGuestItems.get(uid) ?? 0) + 1)
    this.addedGuestTotal++
  }
  /** The element's stored author is this session's user. */
  private createdByWriter(el: El): boolean {
    return (el.customData?.lobbyServer?.createdBy?.uid as string | undefined) === this.s.uid
  }
  /** The guest uid that created the element (its stored author), or null when an account did. */
  private guestCreator(el: El): string | null {
    const by = el.customData?.lobbyServer?.createdBy as { uid?: string; guest?: boolean } | undefined
    return by?.guest && typeof by.uid === 'string' ? by.uid : null
  }
  /**
   * Whether this session may bring a tombstone back (a create over its id, a `life` patch). Accounts may;
   * a name-only guest only its own: an element it created, or one it deleted itself (its undo). The api
   * refuses guests "Recently deleted" and restore (DANA-05), and the redacted snapshot carries no
   * tombstone content, so a guest reviving other people's tombstones read every deleted word, link, file
   * id and author of the board through the room (V2 P-W6); now that is GONE, as for a purged element.
   */
  private mayRevive(tombstone: El): boolean {
    if (!this.s.guest) return true
    if (this.createdByWriter(tombstone)) return true
    return this.env.store.deletedBy(tombstone.id) === this.s.uid
  }
  /**
   * P-W5: an undelete by patch (`life` false) based on a version below the tombstone's was made before
   * this writer saw the deletion (a stale tab, an offline replay): it brings the element back only for the
   * deleter of record (its own undo, whatever its tab knew) or an owner; anyone else's is STALE, and the
   * client resets to the (redacted) tombstone. Before, the room never read `pv`, so an account editor's
   * stale revive of someone else's deletion landed and showed every client its content (V2 P-W5). An
   * undelete based on the tombstone's own version (the client saw the deletion: an undo, a redo, a replay
   * with the corrected `pv`) is unaffected.
   */
  private mayReviveStale(tombstone: El): boolean {
    if (this.s.role === 'owner') return true
    // deleted by an earlier op of this very push (its `lb_deleted` row is written in Phase F)
    if (this.get(tombstone.id).before?.isDeleted === false) return true
    return this.env.store.deletedBy(tombstone.id) === this.s.uid
  }
  private countAdded(el: El, newId: boolean): void {
    if (!el.isDeleted) {
      this.addedElements++
      if (!isLabel(el)) this.addedItems++
    }
    if (newId && this.s.guest && !isLabel(el)) this.addGuestItem(this.s.uid)
  }

  private applyCreate(i: number, op: CreateOp) {
    const st = this.ops[i] as OpState
    const pushed = op.el as El
    st.create = pushed
    const w = this.get(pushed.id)
    const prev = w.el
    if (prev && prev.type !== pushed.type) return this.reject(i, 'TYPE_CHANGE')
    if (prev && !prev.isDeleted) return this.reject(i, 'INVALID')
    if (prev && this.leasedByOther(leaseIdOf(prev))) return this.reject(i, 'LEASED')
    if (prev && !this.mayRevive(prev)) return this.reject(i, 'GONE')
    if (!pushed.isDeleted) {
      const cap = this.capProblem(pushed)
      if (cap) return this.reject(i, cap)
    }
    if (!prev) {
      const cap = this.guestCapProblem(pushed)
      if (cap) return this.reject(i, cap)
    }
    const prevLobby = (prev?.customData?.lobby as Record<string, unknown> | undefined) ?? null
    const lobby = checkCreateLobby(
      pushed.customData?.lobby as Record<string, unknown> | undefined,
      this.ctx,
      prevLobby,
    )
    if (!lobby.ok) return this.reject(i, lobby.code)
    const fileCode = this.fileProblem(pushed)
    if (fileCode) return this.reject(i, fileCode)
    // a create over a tombstone from an older revision keeps what it cannot know of the keys it writes
    // (CONTRACTS_REV 12, keepUnknownFields); the ack's fix names the stored value
    const lobbyValue = prevLobby ? this.keepUnknownFields(lobby.value, prevLobby) : lobby.value

    let next = stripEngineArtifacts({ ...clone(pushed) }) as El
    // guests can neither lock nor unlock (§3.5), a create included: a guest's element (or its undelete of a
    // tombstone) is stored unlocked, and the ack's `fix` says so (V2: a guest could lock by creating)
    if (this.s.guest && next.locked) next.locked = false
    const text = next.type === 'text' && typeof next.originalText === 'string' && next.originalText.length > 0
    // authorship is the session's (§3.3): a create over a tombstone keeps the tombstone's createdBy only
    // when this writer is its creator or the create brings the tombstone's own content back (an undo of
    // a delete, a restore). Other content under another user's deleted id is this writer's element, with
    // this writer as its author and last editor: before, the tombstone's lobbyServer was reused as it
    // was, so a name-only guest published words every client attributed to a staff member (V2 P-W7, P-W8)
    const prevLs = prev?.customData?.lobbyServer
    const keepPrev =
      !!prevLs &&
      ((prevLs.createdBy?.uid ?? null) === this.writer.uid || (!!prev && sameRevivedContent(prev, next)))
    let lobbyServer = keepPrev ? prevLs : freshLobbyServer(this.writer, this.env.now, text)
    if (keepPrev && text && prev && next.originalText !== prev.originalText)
      lobbyServer = {
        ...lobbyServer,
        lastEditedBy: { uid: this.writer.uid, name: this.writer.name, guest: this.writer.guest },
        lastEditedAt: this.env.now,
      }
    const canon = canonicalizeFile(next.type, next.fileId as string | undefined, lobbyValue)
    if (!canon.ok) return this.reject(i, canon.code)
    next.customData = {
      ...(Object.keys(canon.value).length ? { lobby: canon.value } : {}),
      lobbyServer,
    }
    // version = max(stored, client) + 1, the client's capped (a forged 2^53 would break the arithmetic)
    next.version = Math.max(prev?.version ?? 0, Math.min(pushed.version, MAX_CLIENT_VERSION)) + 1
    next.versionNonce = this.env.nonce()
    next.updated = this.env.now
    next.created = next.type === 'stickynote' ? null : (prev?.created ?? this.env.now)
    if (next.type === 'image') next.status = 'saved'
    next = roundGeometry(next as never) as El
    if (next.link && !isAllowedLink(next.link, { guest: this.s.guest })) return this.reject(i, 'INVALID')
    // W5-01 under a concurrent frame move (V1 re-check round 3, W2): a member created where its frame no
    // longer is (the frame moved while the create was on the wire) is a free element, as Excalidraw's own
    // membership rule (an element overlaps its frame) reads it against the frame as stored; the ack's
    // `fix` says so. A label's frameId follows its container (its container is checked instead)
    if (typeof next.frameId === 'string' && !isLabel(next)) {
      const f = this.live(next.frameId)
      if (f?.type === 'frame' && !overlapsFrame(next, f)) next.frameId = null
    }
    const check = checkElement(next)
    if (!check.ok) return this.reject(i, check.code)

    if (prev) for (const g of GROUP_NAMES) w.gclock[g] = this.clock
    this.writerOk(w, i, next)
    st.ok = true
    this.countAdded(next, !prev)
    if (next.type === 'arrow') this.resnapArrows.add(next.id)
    if ((next.boundElements ?? []).some((r: { type: string }) => r.type === 'arrow'))
      this.movedTargets.add(next.id)
  }

  private applyPatch(i: number, op: PatchOp) {
    const st = this.ops[i] as OpState
    st.patch = op
    const w = this.get(op.id)
    const cur = w.el
    if (!cur) return this.reject(i, 'GONE')
    // V2 re-check (P-X1, P-X1b): a tombstone takes no patch but its undelete (`life` false, the revive flow
    // below). A re-delete (`life` true: two people deleting the same element, a cascaded label's own op) is
    // acked ok and writes nothing, so the deleter of record stays; anything else is GONE with the redacted
    // tombstone, as for an unknown id. Before, a guest's text patch or detach of a deleted label rewrote the
    // stored tombstone (its text, `lastEditedBy` the guest), a clock-moving write nobody could see.
    if (cur.isDeleted) {
      const life = (op.g?.life as { isDeleted?: unknown } | undefined)?.isDeleted
      if (life === true) {
        this.writerOk(w, i, cur)
        st.ok = true
        st.applied = { groups: {}, c: {} }
        return
      }
      if (life !== false) return this.reject(i, 'GONE')
    }

    // every field in the group its element kind puts it in (a label's x is layout, a free text's x is pos)
    const bindG = op.g?.bind as Record<string, unknown> | undefined
    const containerId =
      bindG && 'containerId' in bindG ? (bindG.containerId as string | null) : (cur.containerId ?? null)
    // the fields' groups follow the stored kind while the text's own lease denies its `bind` (step 6):
    // a denied detach must not make the rest of the op read as a free text's (a label's x is layout)
    const bindDenied =
      cur.type === 'text' &&
      containerId !== (cur.containerId ?? null) &&
      (this.leasedByOther(leaseIdOf(cur)) || (!!containerId && this.leasedByOther(containerId)))
    const kindEl = { type: cur.type, containerId: bindDenied ? (cur.containerId ?? null) : containerId }
    if (!kindOf(kindEl)) return this.reject(i, 'INVALID')
    for (const [group, fields] of Object.entries(op.g ?? {}))
      for (const f of Object.keys(fields as object))
        if (fieldGroupOf(kindEl, f) !== group) return this.reject(i, 'INVALID')
    if (op.g?.path) {
      if (cur.type !== 'arrow' && cur.type !== 'line') return this.reject(i, 'INVALID')
      if (pathUnitProblem(op.g.path, cur.type)) return this.reject(i, 'INVALID')
    }

    const groups: Record<string, Record<string, unknown>> = { ...((op.g ?? {}) as object) } as Record<
      string,
      Record<string, unknown>
    >
    let c: Record<string, unknown> | undefined = op.c ? { ...op.c } : undefined
    let fit = op.fit
    let denied: { groups: string[]; code: RejectCode } | undefined
    const deny = (names: string[], code: RejectCode) => {
      if (!names.length) return
      denied ??= { groups: [], code }
      denied.groups.push(...names)
    }

    // 5. lock (a label follows its container's lock); guests can neither lock nor unlock
    const meta = groups.meta
    if (this.s.guest && meta && 'locked' in meta) {
      delete groups.meta
      deny(['meta'], 'LOCKED')
    }
    const container = isLabel(cur) ? this.live(cur.containerId) : null
    const locked = !!cur.locked || !!container?.locked
    const unlocking = groups.meta?.locked === false && !isLabel(cur)
    // W5-05: a locked element moved by exactly its frame's move in this push moves with the frame (a
    // template's locked heading and description); any other change of it stays refused
    let follows: { group: string; frame: string } | null = null
    if (locked && !unlocking) {
      follows = this.followsFrame(cur, container, groups)
      const kept: Record<string, Record<string, unknown>> = {}
      const names: string[] = []
      for (const [g, fields] of Object.entries(groups)) {
        if (g === 'z' || (g === 'meta' && Object.keys(fields).every((k) => k === 'locked'))) kept[g] = fields
        else if (follows && g === follows.group) kept[g] = fields
        else names.push(g)
      }
      for (const g of Object.keys(groups)) delete groups[g]
      Object.assign(groups, kept)
      // CR-3F-2, CR-3b-4: the writer's own +1 and an account's `present` on a frame pass the lock (the
      // registry's lockExempt); every other key stays LOCKED, another uid's +1 included
      if (c) {
        const exempt: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(c)) {
          if (lockExemptKey(k, cur.type, this.writer)) exempt[k] = v
          else names.push(`c:${k}`)
        }
        c = Object.keys(exempt).length ? exempt : undefined
      }
      deny(names, 'LOCKED')
      if (fit) {
        fit = undefined
        st.fitDropped = true
      }
    }

    // 6. lease: text, layout and life of an element (or a label of a container) leased by another session.
    // For a TEXT element also `bind` (V2): its `containerId` decides which lease protects it, so a
    // non-holder who could detach a leased label (containerId null) or move a leased label or free text
    // into a note of its own would take it out from under the lease and could then rewrite or delete it
    // (the holder's next push STALE, its text lost while Saved showed)
    const leaseIds = new Set([leaseIdOf(cur)])
    if (containerId && containerId !== cur.containerId) leaseIds.add(containerId)
    if ([...leaseIds].some((id) => this.leasedByOther(id))) {
      const leasedGroups =
        cur.type === 'text' ? ['text', 'layout', 'life', 'bind'] : ['text', 'layout', 'life']
      const names = leasedGroups.filter((g) => g in groups)
      for (const g of names) delete groups[g]
      deny(names, 'LEASED')
    }
    if (fit) {
      const holder = this.env.leases.holderOf(op.id, this.env.now)
      const fields = Object.keys(fit)
      const allowed = FIT_CONTAINERS.has(cur.type)
        ? fields.every((f) => ['height', 'width', 'x', 'y'].includes(f))
        : isFreeText(cur) && fields.every((f) => f === 'x' || f === 'y')
      if (!holder || holder.sid !== this.s.sid || !allowed || cur.isDeleted) {
        fit = undefined
        st.fitDropped = true
      }
    }

    // 8. stale offline writes, and text written by someone else after the base
    const base = this.push.base
    const otherAfter = (slot: string) => {
      const at = w.gclock[slot] ?? 0
      return at > base && this.env.ledger.get(at) !== this.s.uid
    }
    if (op.off !== undefined && op.off > STALE_REPLAY_MS) {
      const slots = [...Object.keys(groups), ...Object.keys(c ?? {}).map((k) => `c:${k}`)]
      if (op.b) slots.push('bound')
      if (slots.some(otherAfter)) return this.reject(i, 'STALE')
    }
    if (groups.text && otherAfter('text')) return this.reject(i, 'STALE')

    // 7. customData classes
    const storedLobby = (cur.customData?.lobby ?? {}) as Record<string, unknown>
    let cApplied: Record<string, unknown> = {}
    if (c) {
      const v = checkPatchLobby(
        c,
        storedLobby,
        (cur.customData?.lobbyServer?.createdBy?.uid as string | undefined) ?? null,
        this.ctx,
      )
      if (!v.ok) return this.reject(i, v.code)
      cApplied = v.value
    }

    const nothing = Object.keys(groups).length === 0 && Object.keys(cApplied).length === 0 && !op.b && !fit
    if (nothing && denied && !st.fitDropped) {
      st.denied = denied
      return this.reject(i, denied.code)
    }
    // what the writer's revision cannot know of a value it writes stays as stored (CONTRACTS_REV 12); `cApplied`
    // stays what was pushed, so the ack's fix names the stored value
    const cStored = this.keepUnknownFields(cApplied, storedLobby)

    // 9. merge: the groups (path whole), boundElements by id, customData.lobby per key
    let next = overlayPatch(cur, {
      g: groups,
      ...(Object.keys(cStored).length ? { c: cStored } : {}),
      ...(op.b ? { b: op.b } : {}),
    }) as El
    if (groups.file?.fileId !== undefined) {
      const code = this.fileProblem(next)
      if (code) return this.reject(i, code)
    }
    // the holder's fit, last and conditional (§2.9.4 rule 3)
    let fitApplied = false
    if (fit) {
      const clean = isFreeText(cur)
        ? (w.gclock.pos ?? 0) <= base
        : (w.gclock.pos ?? 0) <= base && (w.gclock.shape ?? 0) <= base
      if (clean) {
        next = { ...next, ...fit }
        fitApplied = true
      } else st.fitDropped = true
    }
    next = stripEngineArtifacts(next)
    next = roundGeometry(next as never) as El
    if (next.type === 'image') next.status = 'saved'
    const canon = canonicalizeFile(
      next.type,
      next.fileId as string | undefined,
      (next.customData?.lobby ?? {}) as Record<string, unknown>,
    )
    if (!canon.ok) return this.reject(i, canon.code)
    if (next.customData || Object.keys(canon.value).length) {
      const cd = { ...(next.customData ?? {}) } as Record<string, unknown>
      if (Object.keys(canon.value).length) cd.lobby = canon.value
      else delete cd.lobby
      next.customData = cd
    }
    // lastEditedBy on text changes of text elements (§3.3)
    if (next.type === 'text' && groups.text && next.originalText !== cur.originalText) {
      const ls = next.customData?.lobbyServer ?? freshLobbyServer(this.writer, this.env.now, true)
      next.customData = {
        ...(next.customData ?? {}),
        lobbyServer: {
          ...ls,
          lastEditedBy: { uid: this.writer.uid, name: this.writer.name, guest: this.writer.guest },
          lastEditedAt: this.env.now,
        },
      }
    }
    if (groups.meta && next.link && !isAllowedLink(next.link, { guest: this.s.guest }))
      return this.reject(i, 'INVALID')
    const check = checkElement(next)
    if (!check.ok) return this.reject(i, check.code)
    // an undelete by patch (life false) counts toward the caps like a create
    const revived = cur.isDeleted && !next.isDeleted
    if (revived) {
      if (!this.mayRevive(cur)) return this.reject(i, 'GONE')
      if (op.pv < cur.version && !this.mayReviveStale(cur)) return this.reject(i, 'STALE')
      const cap = this.capProblem(next)
      if (cap) return this.reject(i, cap)
    }
    // a guest's label detached into a free text is one more item of the guest who CREATED it (D5): before
    // wave 5 a label was never counted and its detach made an uncounted item, so the 500-item cap did not
    // hold (V2 P-G2); then the detach counted against the detacher, so a second guest uid detaching the
    // first one's labels grew its items past the cap (V2 re-check P-G4). Now the creator's count takes it
    // (as the rebuild counts, caches.ts), and a guest detaching at that creator's cap gets GUEST_LIMIT. An
    // account editor's detach is never refused (the creator's count may then stand above the cap, which
    // only stops that guest from creating more).
    const detached = isLabel(cur) && !isLabel(next) && !next.isDeleted
    const detachedCreator = detached ? this.guestCreator(next) : null
    if (detachedCreator && this.s.guest) {
      const cap = this.guestCapProblem(next, detachedCreator)
      if (cap) return this.reject(i, cap)
    }

    const changed = !sameContent(cur, next)
    if (changed) {
      next.version = cur.version + 1
      next.versionNonce = this.env.nonce()
      next.updated = this.env.now
      for (const [g, fields] of Object.entries(groups))
        if (Object.keys(fields).some((f) => !equal(cur[f], next[f]))) w.gclock[g] = this.clock
      for (const k of Object.keys(cApplied))
        if (!equal(storedLobby[k], (next.customData?.lobby as Record<string, unknown> | undefined)?.[k]))
          w.gclock[`c:${k}`] = this.clock
      if (op.b && !equal(cur.boundElements, next.boundElements)) w.gclock.bound = this.clock
      if (fitApplied && Object.keys(fit ?? {}).some((f) => !equal(cur[f], next[f]))) w.gclock.fit = this.clock
    } else next = cur
    this.writerOk(w, i, next)
    st.ok = true
    if (revived) this.countAdded(next, false)
    if (detachedCreator) this.addGuestItem(detachedCreator)
    if (follows) this.followers.set(op.id, follows.frame)
    st.applied = { groups, c: cApplied }
    if (denied) st.denied = denied
    this.env.leases.renew(leaseIdOf(cur), this.s.sid, this.env.now)

    // rule 7 triggers
    if (next.type === 'arrow' && (groups.path || groups.bind || (cur.isDeleted && !next.isDeleted)))
      this.resnapArrows.add(next.id)
    if (isBindable(next as never) && RESNAP_TRIGGER_FIELDS.some((f) => !equal(cur[f], next[f])))
      this.movedTargets.add(next.id)
  }

  // ---- W5-05: locked members move with their frame -------------------------------------------------

  /** The frames this push moves, with the move: a `pos` patch on a live, unlocked frame. */
  private planFrameMoves(): void {
    for (const pre of this.push.ops) {
      const op = pre.op
      if (op?.k !== 'p' || !op.g?.pos) continue
      const f = this.get(op.id).before
      if (!f || f.isDeleted || f.type !== 'frame' || f.locked) continue
      const pos = op.g.pos as { x?: unknown; y?: unknown }
      const dx = (typeof pos.x === 'number' ? pos.x : f.x) - f.x
      const dy = (typeof pos.y === 'number' ? pos.y : f.y) - f.y
      if (Number.isFinite(dx) && Number.isFinite(dy) && (dx !== 0 || dy !== 0))
        this.frameMoves.set(op.id, { dx, dy })
    }
  }

  /**
   * Whether this patch of a locked element is only its frame's move (W5-05, the review's server option):
   * the element (or, for a label, its container) is a member of a frame this push moves, and the group
   * that carries its `x`, `y` (`pos`; a label's `layout`; a linear element's `path`) changes `x` and `y`
   * by the frame's delta (within GEOMETRY_TOLERANCE_PX) and nothing else. Returns that group and the frame.
   */
  private followsFrame(
    cur: El,
    container: El | null,
    groups: Record<string, Record<string, unknown>>,
  ): { group: string; frame: string } | null {
    const frame = (cur.frameId ?? container?.frameId ?? null) as string | null
    const move = frame ? this.frameMoves.get(frame) : undefined
    if (!frame || !move) return null
    const group = fieldGroupOf(cur, 'x')
    const fields = group ? groups[group] : undefined
    if (!group || !fields) return null
    for (const [f, v] of Object.entries(fields)) if (f !== 'x' && f !== 'y' && !equal(v, cur[f])) return null
    const nx = 'x' in fields ? fields.x : cur.x
    const ny = 'y' in fields ? fields.y : cur.y
    if (typeof nx !== 'number' || typeof ny !== 'number') return null
    if (Math.abs(nx - cur.x - move.dx) > GEOMETRY_TOLERANCE_PX) return null
    if (Math.abs(ny - cur.y - move.dy) > GEOMETRY_TOLERANCE_PX) return null
    return { group, frame }
  }

  /**
   * A locked member moved only because its frame moved: when the frame's move did not land (refused,
   * reverted, or landed elsewhere), the member's move is taken back too, so a push never saves half a
   * frame move (W5-05). True when something was reverted.
   */
  private settleFollowers(): boolean {
    let reverted = false
    for (const [id, frame] of [...this.followers]) {
      const fw = this.get(frame)
      const move = this.frameMoves.get(frame)
      const el = fw.el
      const landed =
        !!el &&
        !el.isDeleted &&
        !!fw.before &&
        !!move &&
        fw.writers.length > 0 &&
        Math.abs(el.x - fw.before.x - move.dx) <= GEOMETRY_TOLERANCE_PX &&
        Math.abs(el.y - fw.before.y - move.dy) <= GEOMETRY_TOLERANCE_PX
      if (landed) continue
      this.followers.delete(id)
      this.revert(id, 'LOCKED')
      reverted = true
    }
    return reverted
  }

  // ---- rule 6: the server re-fits a container whose lease expired --------------------------------

  /**
   * §2.9.4 rule 6: the holder vanished (its lease expired) and the container's geometry changed after its
   * last fit, so the server re-fits the label and the container with Excalidraw's own layout helper and
   * the metrics table (§2.11): `getStickyNoteLayout` for a sticky note, `redrawTextBoundingBox` for a
   * rectangle, ellipse or diamond (the helpers the holder's client runs, rule 4). A derived write:
   * `gclock.fit` only.
   */
  private serverRelayout(id: string): void {
    const cw = this.get(id)
    const note = cw.el
    if (!note || note.isDeleted || !FIT_CONTAINERS.has(note.type)) return
    const fit = cw.gclock.fit ?? 0
    if ((cw.gclock.pos ?? 0) <= fit && (cw.gclock.shape ?? 0) <= fit) return
    const ref = (note.boundElements ?? []).find((r: { type: string }) => r.type === 'text')
    const lw = ref ? this.get(ref.id) : null
    const lab = lw?.el
    if (!lw || !lab || lab.isDeleted || lab.containerId !== id) return
    const lay =
      note.type === 'stickynote'
        ? layoutStickyNote(note as never, lab as never)
        : layoutBoundText(note as never, lab as never)
    const nextNote = { ...note, ...lay.container } as El
    if (!sameContent(nextNote, note)) {
      cw.el = nextNote
      this.bump(cw)
      cw.gclock.fit = this.clock
      cw.derived = true
      if (RESNAP_TRIGGER_FIELDS.some((f) => !equal(note[f], nextNote[f]))) this.movedTargets.add(id)
    }
    if (lay.text) {
      const nextLabel = { ...lab, ...lay.text } as El
      if (!sameContent(nextLabel, lab)) {
        lw.el = nextLabel
        this.bump(lw)
        lw.gclock.fit = this.clock
        lw.derived = true
      }
    }
  }

  // ---- doc writes (before the ops, so a tag defined in this push can be used by its ops) -----------

  private applyDoc(): void {
    const raw = this.push.doc
    if (raw === undefined) return
    const parsed = DocSet.safeParse(raw)
    const denied: string[] = []
    let code: RejectCode = 'INVALID'
    if (!parsed.success) {
      this.docDenied = { keys: ['*'], code: 'INVALID' }
      return
    }
    let guestLimited = false
    const refuse = (key: string, why: RejectCode) => {
      denied.push(key)
      this.docDeniedCodes.set(key, why)
    }
    for (const [key, value] of Object.entries(parsed.data.set)) {
      const problem = docValueProblem(key, value)
      if (problem) {
        refuse(key, 'INVALID')
        continue
      }
      // CR-3D-5: a name-only guest of a writing role writes the tag list only (doc.ts `guests`); the
      // facilitator's `workshop`, the owner's `startView` and the server's `import` stay refused
      if (this.s.readonly || !canWriteDocKey(key, this.s.role, { guest: this.s.guest })) {
        refuse(key, 'READ_ONLY')
        code = 'READ_ONLY'
        continue
      }
      if (value !== null && key.startsWith(TAG_DEF_KEY_PREFIX) && !this.env.store.docGet(key)?.value) {
        const n =
          this.env.store.docCountPrefix(TAG_DEF_KEY_PREFIX) +
          Object.entries(this.docWrites).filter(([k, v]) => k.startsWith(TAG_DEF_KEY_PREFIX) && v !== null)
            .length
        if (n + 1 > MAX_TAG_DEFS) {
          refuse(key, 'INVALID')
          continue
        }
        // TAGS-1: the list's last MEMBER_TAG_DEF_RESERVE places are the members': guests (every uid together)
        // add a new tag only below that, so guests can never fill the list for the board's own people
        if (this.s.guest && n + 1 > MAX_TAG_DEFS - MEMBER_TAG_DEF_RESERVE) {
          refuse(key, 'GUEST_LIMIT')
          guestLimited = true
          continue
        }
      }
      if (this.s.guest && !this.guestMayWriteTagKey(key)) {
        refuse(key, 'GUEST_LIMIT')
        guestLimited = true
        continue
      }
      this.docWrites[key] = value
    }
    if (denied.length)
      this.docDenied = { keys: denied, code: code === 'INVALID' && guestLimited ? 'GUEST_LIMIT' : code }
  }

  /**
   * GUEST_TAG_DEF_CAP (CR-3D-5): a guest may write `key` when it already wrote it, or while it has written
   * fewer than the cap's keys of the tag list. "Wrote" is read from the writer ledger (the uid of each push's
   * clock, this room open) against every `tagDef:*` row's clock, removed keys included, so a deletion or a
   * rename spends the budget as a creation does. A key someone else rewrote since is no longer the guest's.
   * TAGS-1: the keys come from the board file too (lb_guest_tags, written with each of a guest's tag-list
   * writes), so an eviction or a restart no longer resets the budget; the ledger still covers this room open's
   * writes made before that table existed.
   */
  private guestMayWriteTagKey(key: string): boolean {
    if (!this.guestTagKeys) {
      const mine = this.env.store.guestTagKeys(this.s.uid)
      for (const [k, clock] of Object.entries(this.env.store.docClocks()))
        if (k.startsWith(TAG_DEF_KEY_PREFIX) && this.env.ledger.get(clock) === this.s.uid) mine.add(k)
      this.guestTagKeys = mine
    }
    if (this.guestTagKeys.has(key)) return true
    if (this.guestTagKeys.size + 1 > GUEST_TAG_DEF_CAP) return false
    this.guestTagKeys.add(key)
    return true
  }

  // ---- D: index ----------------------------------------------------------------------------------

  private assignIndexes(): void {
    const index = this.env.index
    const touched = [...this.work.values()].filter((w) => w.el && !equal(w.el, w.before))
    // the cache follows the working state: a deletion's key stays taken (a tombstone's, V3), live elements
    // (re)enter it
    for (const w of touched) if (w.el?.isDeleted) index.setDead(w.id, w.el.index)
    const order = (w: Work) => (isLabel(w.el) ? 1 : 0)
    const live = touched.filter((w) => w.el && !w.el.isDeleted).sort((a, b) => order(a) - order(b))
    for (const w of live) {
      const el = w.el as El
      const wasLive = !!w.before && !w.before.isDeleted
      const moved = !wasLive || el.index !== w.before?.index
      let idx: string | null = el.index
      if (!isValidIndexKey(idx)) idx = keyAbove(index, null, el.id)
      else if (moved && index.usedByOther(idx, el.id)) idx = keyAbove(index, idx, el.id)
      if (idx !== el.index) {
        el.index = idx
        this.bump(w)
      }
      index.set(el.id, idx as string)
    }
    // a label sorts after its container (a moved container can put its label below it)
    const labels = new Set<string>()
    for (const w of live) {
      const el = w.el as El
      if (isLabel(el)) labels.add(el.id)
      else
        for (const r of el.boundElements ?? [])
          if (r.type === 'text') {
            const t = this.live(r.id)
            if (t && t.containerId === el.id) labels.add(r.id)
          }
    }
    for (const id of labels) {
      const lw = this.get(id)
      const label = lw.el
      const cont = this.live(label?.containerId)
      if (!label || label.isDeleted || !cont) continue
      const li = label.index as string
      const ci = cont.index as string
      if (li > ci || (li === ci && label.id > cont.id)) continue
      label.index = keyAbove(index, ci, label.id)
      this.bump(lw)
      index.set(label.id, label.index as string)
    }
  }

  // ---- E, F: the ack and the writes ----------------------------------------------------------------

  private fixOf(st: OpState, w: Work): Record<string, unknown> | undefined {
    const fin = w.el as El
    const fix: Record<string, unknown> = {}
    const consider = (f: string, expected: unknown) => {
      if (!equal(fin[f], expected)) fix[f] = clone(fin[f]) ?? null
    }
    if (st.create) {
      const pushed = st.create
      for (const f of new Set([...Object.keys(pushed), ...Object.keys(fin)])) {
        if (!fieldGroupOf(fin, f) || f === 'boundElements') continue
        consider(f, pushed[f])
      }
      const pl = (pushed.customData?.lobby ?? {}) as Record<string, unknown>
      const fl = (fin.customData?.lobby ?? {}) as Record<string, unknown>
      for (const k of new Set([...Object.keys(pl), ...Object.keys(fl)]))
        if (!equal(pl[k], fl[k])) fix[`c:${k}`] = clone(fl[k]) ?? null
    } else {
      const after = w.opAfter ?? fin
      const pushedFields = new Map<string, unknown>()
      for (const fields of Object.values(st.applied.groups))
        for (const [f, v] of Object.entries(fields)) pushedFields.set(f, v)
      for (const f of new Set([...Object.keys(after), ...Object.keys(fin)])) {
        const g = fieldGroupOf(fin, f)
        if (!g || g === 'bound') continue
        consider(f, pushedFields.has(f) ? pushedFields.get(f) : after[f])
      }
      const fl = (fin.customData?.lobby ?? {}) as Record<string, unknown>
      for (const [k, v] of Object.entries(st.applied.c))
        if (!equal(fl[k] ?? null, v)) fix[`c:${k}`] = clone(fl[k]) ?? null
    }
    // an arrow's or a line's geometry is one unit: a fix of any of it carries the whole unit
    if (
      (fin.type === 'arrow' || fin.type === 'line') &&
      Object.keys(fix).some((f) => fieldGroupOf(fin, f) === 'path')
    )
      Object.assign(fix, pathUnitOf(fin))
    return Object.keys(fix).length ? fix : undefined
  }

  private finish(): PushOutcome {
    const results: AckResult[] = []
    const codes: string[] = []
    this.ops.forEach((st) => {
      const w = this.work.get(st.id)
      if (!st.ok) {
        const code = st.code ?? 'INVALID'
        codes.push(code)
        const stored = w?.before ?? (st.id ? (this.env.store.get(st.id)?.el ?? null) : null)
        // the stored copy the client resets to; a tombstone redacted (W5-02: a viewer probing a deleted id
        // by a refused patch got its text and authors)
        const el = stored ? (stored.isDeleted ? redactTombstone(stored as El) : clone(stored)) : null
        results.push({ id: st.id.slice(0, 200), ok: false, code, el })
        return
      }
      codes.push('ok')
      const fin = w?.el as El
      const fix = w ? this.fixOf(st, w) : undefined
      results.push({
        id: st.id,
        ok: true,
        v: fin.version,
        ...(fix ? { fix } : {}),
        ...(st.fitDropped ? { fitDropped: true as const } : {}),
        ...(st.denied ? { denied: st.denied } : {}),
      })
    })

    const derived: DerivedRow[] = []
    const changed = new Map<string, { before: WireElement | null; after: WireElement }>()
    const now = this.env.now
    for (const w of this.work.values()) {
      const el = w.el
      if (!el || equal(el, w.before)) continue
      changed.set(w.id, { before: w.before, after: el })
      if (w.derived && w.writers.length === 0) {
        const fix: Record<string, unknown> = {}
        for (const f of new Set([...Object.keys(el), ...Object.keys(w.before ?? {})])) {
          const g = fieldGroupOf(el, f)
          if (!g || g === 'bound') continue
          if (!equal(el[f], w.before?.[f])) fix[f] = clone(el[f]) ?? null
        }
        if (
          (el.type === 'arrow' || el.type === 'line') &&
          Object.keys(fix).some((f) => fieldGroupOf(el, f) === 'path')
        )
          Object.assign(fix, pathUnitOf(el))
        derived.push({ id: el.id, v: el.version, fix })
      }
    }
    const wrote = changed.size > 0 || Object.keys(this.docWrites).length > 0
    if (wrote) {
      const store = this.env.store
      for (const [id, { before, after }] of changed) {
        const w = this.work.get(id) as Work
        const wasDeleted = !!before?.isDeleted
        const nowDeleted = !!after.isDeleted
        store.upsert({
          el: after,
          clock: this.clock,
          gclock: w.gclock,
          deletedClock: nowDeleted ? (wasDeleted ? (w.row?.deletedClock ?? this.clock) : this.clock) : null,
          deletedAt: nowDeleted ? (wasDeleted ? (w.row?.deletedAt ?? now) : now) : null,
        })
        if (nowDeleted && !wasDeleted)
          store.insertDeleted({
            batch: this.clock,
            el: after,
            deletedBy: this.s.uid,
            deletedByName: this.s.name,
            deletedAt: now,
            session: this.env.deletedSession,
          })
        // caches: live counts, groups, guest creations
        const wasLive = !!before && !before.isDeleted
        const isLive = !nowDeleted
        const itemOf = (e: El | null) => (e && !isLabel(e) ? 1 : 0)
        if (wasLive) {
          this.env.counts.elements--
          this.env.counts.items -= itemOf(before as El)
          this.env.groups.remove(before?.groupIds)
        }
        if (isLive) {
          this.env.counts.elements++
          this.env.counts.items += itemOf(after as El)
          this.env.groups.add(after.groupIds)
        }
        // D5: a guest's item under a new id counts, live or deleted (V2: tombstones were never counted),
        // and so does a guest's label detached into a free text, against its creator whoever detached it
        // (the rebuild counts it by its createdBy, caches.ts; V2 re-check P-G4)
        const counted =
          !before && !isLabel(after as El) && this.s.guest
            ? this.s.uid
            : before && isLabel(before) && !isLabel(after as El)
              ? this.guestCreator(after as El)
              : null
        if (counted) this.env.guestCreated.set(counted, (this.env.guestCreated.get(counted) ?? 0) + 1)
      }
      for (const [key, value] of Object.entries(this.docWrites)) store.docSet(key, this.clock, value)
      // TAGS-1: a guest's tag-list keys, in the board file (its budget survives an eviction and a restart)
      if (this.s.guest)
        store.putGuestTags(
          this.s.uid,
          Object.keys(this.docWrites).filter((k) => k.startsWith(TAG_DEF_KEY_PREFIX)),
          this.clock,
        )
      this.env.ledger.set(this.clock, this.s.uid)
    }
    return {
      clock: wrote ? this.clock : null,
      results,
      derived,
      ...(this.docDenied ? { docDenied: this.docDenied } : {}),
      changed,
      doc: this.docWrites,
      codes,
    }
  }
}
