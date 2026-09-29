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
import { checkElement, type WireElement } from '@draftroom/canvas-schema/elements'
import { isBindable } from '@draftroom/canvas-schema/engine'
import {
  fieldGroupOf,
  kindOf,
  overlayPatch,
  pathUnitOf,
  RESNAP_TRIGGER_FIELDS,
  stripEngineArtifacts,
} from '@draftroom/canvas-schema/groups'
import {
  GUEST_ITEM_CAP,
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
  type CreateOp,
  type DerivedRow,
  GROUP_NAMES,
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
  readonly guestCreated: Map<string, number>
  readonly now: number
  readonly epoch: string
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
const FIT_CONTAINERS = new Set(['rectangle', 'ellipse', 'diamond', 'stickynote'])
/** The lease id that protects an element's `text`, `layout` and `life`: a label's container, else itself. */
export const leaseIdOf = (el: El): string => (isLabel(el) ? (el.containerId as string) : el.id)

/** Server-owned and bookkeeping fields: never compared as "the user's change". */
const NOT_CONTENT = new Set(['version', 'versionNonce', 'updated'])
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
  /** arrows whose own geometry or bindings this push wrote (rule 7 trigger 2) */
  readonly resnapArrows = new Set<string>()
  /** bindable elements whose x, y, width, height or angle changed (rule 7 trigger 1) */
  readonly movedTargets = new Set<string>()

  private readonly env: MergeEnv
  private readonly s: SessionIdentity
  private readonly push: PreparedPush
  /** this push's clock (used only if it writes anything) */
  readonly clock: number

  constructor(env: MergeEnv, s: SessionIdentity, push: PreparedPush, clock: number) {
    this.env = env
    this.s = s
    this.push = push
    this.clock = clock
    this.writer = { uid: s.uid, name: s.name, guest: s.guest, role: s.role }
    this.ctx = {
      writer: this.writer,
      voteOpen: env.voteOpen,
      tagExists: (key) => this.tagExists(key),
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
    this.applyDoc()
    this.push.ops.forEach((pre, i) => {
      this.ops[i] = { id: pre.id, kind: pre.op?.k ?? 'p', ok: false, applied: { groups: {}, c: {} } }
      if (pre.reject) this.reject(i, pre.reject)
      else if (this.s.readonly) this.reject(i, 'READ_ONLY')
      else if (pre.op.k === 'c') this.applyCreate(i, pre.op)
      else this.applyPatch(i, pre.op)
    })
    enforceInvariants(this) // B
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

  private applyCreate(i: number, op: CreateOp) {
    const st = this.ops[i] as OpState
    const pushed = op.el as El
    st.create = pushed
    const w = this.get(pushed.id)
    const prev = w.el
    if (prev && prev.type !== pushed.type) return this.reject(i, 'TYPE_CHANGE')
    if (prev && !prev.isDeleted) return this.reject(i, 'INVALID')
    if (prev && this.leasedByOther(leaseIdOf(prev))) return this.reject(i, 'LEASED')
    if (!pushed.isDeleted) {
      const label = isLabel(pushed)
      if (this.env.counts.elements + 1 > MAX_LIVE_ELEMENTS) return this.reject(i, 'ELEMENT_LIMIT')
      if (!label && this.env.counts.items + 1 > MAX_ITEMS) return this.reject(i, 'ELEMENT_LIMIT')
      if (this.s.guest && !label && (this.env.guestCreated.get(this.s.sid) ?? 0) + 1 > GUEST_ITEM_CAP)
        return this.reject(i, 'GUEST_LIMIT')
    }
    const lobby = checkCreateLobby(
      pushed.customData?.lobby as Record<string, unknown> | undefined,
      this.ctx,
      (prev?.customData?.lobby as Record<string, unknown> | undefined) ?? null,
    )
    if (!lobby.ok) return this.reject(i, lobby.code)
    const fileCode = this.fileProblem(pushed)
    if (fileCode) return this.reject(i, fileCode)

    let next = stripEngineArtifacts({ ...clone(pushed) }) as El
    const text = next.type === 'text' && typeof next.originalText === 'string' && next.originalText.length > 0
    const lobbyServer = prev?.customData?.lobbyServer ?? freshLobbyServer(this.writer, this.env.now, text)
    const canon = canonicalizeFile(next.type, next.fileId as string | undefined, lobby.value)
    if (!canon.ok) return this.reject(i, canon.code)
    next.customData = {
      ...(Object.keys(canon.value).length ? { lobby: canon.value } : {}),
      lobbyServer,
    }
    next.version = Math.max(prev?.version ?? 0, pushed.version) + 1
    next.versionNonce = this.env.nonce()
    next.updated = this.env.now
    next.created = next.type === 'stickynote' ? null : (prev?.created ?? this.env.now)
    if (next.type === 'image') next.status = 'saved'
    next = roundGeometry(next as never) as El
    if (next.link && !isAllowedLink(next.link, { guest: this.s.guest })) return this.reject(i, 'INVALID')
    const check = checkElement(next)
    if (!check.ok) return this.reject(i, check.code)

    if (prev) for (const g of GROUP_NAMES) w.gclock[g] = this.clock
    this.writerOk(w, i, next)
    st.ok = true
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

    // every field in the group its element kind puts it in (a label's x is layout, a free text's x is pos)
    const bindG = op.g?.bind as Record<string, unknown> | undefined
    const containerId =
      bindG && 'containerId' in bindG ? (bindG.containerId as string | null) : (cur.containerId ?? null)
    const kindEl = { type: cur.type, containerId }
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
    if (locked && !unlocking) {
      const kept: Record<string, Record<string, unknown>> = {}
      const names: string[] = []
      for (const [g, fields] of Object.entries(groups)) {
        if (g === 'z' || (g === 'meta' && Object.keys(fields).every((k) => k === 'locked'))) kept[g] = fields
        else names.push(g)
      }
      for (const g of Object.keys(groups)) delete groups[g]
      Object.assign(groups, kept)
      if (c) names.push(...Object.keys(c).map((k) => `c:${k}`))
      c = undefined
      deny(names, 'LOCKED')
      if (fit) {
        fit = undefined
        st.fitDropped = true
      }
    }

    // 6. lease: text, layout and life of an element (or a label of a container) leased by another session
    const leaseIds = new Set([leaseIdOf(cur)])
    if (containerId && containerId !== cur.containerId) leaseIds.add(containerId)
    if ([...leaseIds].some((id) => this.leasedByOther(id))) {
      const names = ['text', 'layout', 'life'].filter((g) => g in groups)
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

    // 9. merge: the groups (path whole), boundElements by id, customData.lobby per key
    let next = overlayPatch(cur, {
      g: groups,
      ...(Object.keys(cApplied).length ? { c: cApplied } : {}),
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
    st.applied = { groups, c: cApplied }
    if (denied) st.denied = denied
    this.env.leases.renew(leaseIdOf(cur), this.s.sid, this.env.now)

    // rule 7 triggers
    if (next.type === 'arrow' && (groups.path || groups.bind || (cur.isDeleted && !next.isDeleted)))
      this.resnapArrows.add(next.id)
    if (isBindable(next as never) && RESNAP_TRIGGER_FIELDS.some((f) => !equal(cur[f], next[f])))
      this.movedTargets.add(next.id)
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
    for (const [key, value] of Object.entries(parsed.data.set)) {
      const problem = docValueProblem(key, value)
      if (problem) {
        denied.push(key)
        continue
      }
      if (this.s.readonly || this.s.guest || !canWriteDocKey(key, this.s.role)) {
        denied.push(key)
        code = 'READ_ONLY'
        continue
      }
      if (value !== null && key.startsWith(TAG_DEF_KEY_PREFIX) && !this.env.store.docGet(key)?.value) {
        const n =
          this.env.store.docCountPrefix(TAG_DEF_KEY_PREFIX) +
          Object.entries(this.docWrites).filter(([k, v]) => k.startsWith(TAG_DEF_KEY_PREFIX) && v !== null)
            .length
        if (n + 1 > MAX_TAG_DEFS) {
          denied.push(key)
          continue
        }
      }
      this.docWrites[key] = value
    }
    if (denied.length) this.docDenied = { keys: denied, code }
  }

  // ---- D: index ----------------------------------------------------------------------------------

  private assignIndexes(): void {
    const index = this.env.index
    const touched = [...this.work.values()].filter((w) => w.el && !equal(w.el, w.before))
    // the cache follows the working state: deletions leave it, live elements (re)enter it
    for (const w of touched) if (w.el?.isDeleted) index.remove(w.id)
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
        results.push({ id: st.id.slice(0, 200), ok: false, code, el: stored ? clone(stored) : null })
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
        if (this.s.guest && !before && isLive && !isLabel(after as El))
          this.env.guestCreated.set(this.s.sid, (this.env.guestCreated.get(this.s.sid) ?? 0) + 1)
      }
      for (const [key, value] of Object.entries(this.docWrites)) store.docSet(key, this.clock, value)
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
