// Server-authored writes into an open room (CR 2F-2, engine-switch.ts `serverWrite`): the "Recently
// deleted" restore and the private brainstorm's place-notes reveal (room-internal/** on engine/excalidraw),
// and any later route that must change an open board. docs/EXCALIDRAW-MIGRATION.md §2.4.3, §2.4.6.
//
// A server write is a room queue entry like a session's push: the drain runs it in the batch's
// transaction, in its own SAVEPOINT, at the batch's next clock, and its changes leave in the batch's one
// `changes` frame after COMMIT, for every session. Nobody gets an ack: the caller's promise settles after
// the COMMIT (resolved with the write's result) or with its failure (the SAVEPOINT rolled back).
//
// `apply` owns what it writes (it reads the board through `tx.store`, upserts its rows at `tx.clock` and
// reports them, with the element check and the invariants its own business, as room-internal/** does).
// The room then holds it to the contract and stamps it as the server's, so the rest of the protocol
// treats it like any other write:
//
//  - CHECKED (a violation rolls the write back and rejects it; the route answers 500): every reported
//    element is stored at `tx.clock` exactly as reported, passes the element check, and has a `version`
//    above the stored one; no row is stored at `tx.clock` that is not reported; every reported doc key
//    is stored at `tx.clock` with a value its key allows (canvas-schema doc.ts), and no other; a live element has a valid index no other live element uses,
//    and a label sorts after its container. The board caps (§3.5): a write that adds elements beyond
//    them is refused 409 `element-limit`. The write leaves no NEW invariant violation (§2.4.4) among what it
//    wrote and what is around it (wave 5, V2's re-check: a violation reported on an unchanged neighbour,
//    or on a group id, was let through); a violation that was there before the write is not its fault.
//  - RE-KEYED: a tombstone whose z-order key the write gives a live element moves right above it (wave
//    5, V3: a live element never shares a tombstone's key; the routes pick keys among the live elements).
//    The write's own elements stay exactly as reported; the tombstone's new key reaches everyone redacted.
//  - STAMPED: `before` is the stored row as the write found it (read by `tx.store.upsert` before it
//    writes, so a wrong `before` in the report cannot mislead the patch ops). Group clocks never go
//    back (the stored ones are kept) and every group whose fields changed is at `tx.clock`, so a stale
//    offline replay (§2.4.3 step 8) and the conditional fit (§2.9.4 rule 3) see the server's write. The
//    writer ledger names the server for `tx.clock` (a session's STALE check treats it as someone else's
//    write). A deletion gets its tombstone clock and time and its `lb_deleted` row (deleted by "Lobby"),
//    unless `apply` wrote that row itself.
//  - DERIVED (§2.9.4 rule 7): arrows bound to a target whose x, y, width, height or angle changed, and
//    arrows whose own path or bindings changed or that came back, are re-snapped in the same clock,
//    exactly as for a push (merge.ts PushApplier with the server's identity and no ops).
//  - CACHED: the room's index, group and live-count caches follow the write; the snapshot cache is
//    dropped (CR 2F-2).

import { docValueProblem } from '@draftroom/canvas-schema/doc'
import { checkElement, type WireElement } from '@draftroom/canvas-schema/elements'
import { isBindable } from '@draftroom/canvas-schema/engine'
import { fieldGroupOf, pathUnitOf, RESNAP_TRIGGER_FIELDS } from '@draftroom/canvas-schema/groups'
import { canonicalJson } from '@draftroom/canvas-schema/hash'
import { checkInvariantsOf } from '@draftroom/canvas-schema/invariants'
import { MAX_ITEMS, MAX_LIVE_ELEMENTS } from '@draftroom/canvas-schema/limits'
import type { ServerWriteApply, ServerWriteTx } from '../engine-switch.ts'
import { HttpError } from '../http/respond.ts'
import type { GroupMap, LiveCounts, WriterLedger } from './caches.ts'
import { type IndexCache, isValidIndexKey, keyAbove } from './index-keys.ts'
import { type El, type MergeEnv, PushApplier } from './merge.ts'
import type { BoardStore, DeletedRowWrite, ElementRow, RowWrite } from './store.ts'
import type { SessionIdentity } from './types.ts'

/** A server write waiting in the room queue. */
export interface ServerWriteEntry {
  readonly kind: 'server'
  readonly apply: ServerWriteApply<unknown>
  readonly resolve: (value: unknown) => void
  readonly reject: (error: unknown) => void
}

/** A server write that broke the contract above (a bug in the route that made it): answered 500. */
export class ServerWriteContractError extends Error {
  constructor(what: string) {
    super(`server write refused: ${what}`)
    this.name = 'ServerWriteContractError'
  }
}

/** What the drain gives a server write. */
export interface ServerWriteContext {
  readonly store: BoardStore
  /** the batch's next clock: the write's */
  readonly clock: number
  readonly now: number
  readonly identity: SessionIdentity
  /** the room session named by `lb_deleted` rows */
  readonly deletedSession: string
  readonly index: IndexCache
  readonly groups: GroupMap
  readonly counts: LiveCounts
  readonly ledger: WriterLedger
  /** the merge env of this batch (for the rule-7 pass) */
  readonly env: () => MergeEnv
}

/** A server write that passed: its changes for the batch's frame, and its answer. */
export interface ServerWriteDone {
  /** false: it wrote nothing (the batch's clock does not move) */
  readonly wrote: boolean
  readonly changed: ReadonlyMap<string, { before: WireElement | null; after: WireElement }>
  readonly doc: Readonly<Record<string, unknown>>
  /** live elements it deleted (the lb_deleted trim counter) */
  readonly deletions: number
  readonly result: unknown
}

const equal = (a: unknown, b: unknown): boolean => canonicalJson(a ?? null) === canonicalJson(b ?? null)
const isLabel = (el: El | null | undefined): boolean => !!el && el.type === 'text' && !!el.containerId
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
/** Fields no group carries (bookkeeping) or that have their own slot (boundElements, customData). */
const NOT_GROUPED = new Set([
  'id',
  'type',
  'version',
  'versionNonce',
  'updated',
  'boundElements',
  'customData',
])

/** The group-clock slots of the fields that differ between `before` and `after` (§2.4.3 step 9's names). */
function changedSlots(before: El, after: El): Set<string> {
  const out = new Set<string>()
  for (const f of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (NOT_GROUPED.has(f) || equal(before[f], after[f])) continue
    const g = fieldGroupOf(after, f) ?? fieldGroupOf(before, f)
    if (g) out.add(g)
  }
  if (!equal(before.boundElements, after.boundElements)) out.add('bound')
  const lb = (before.customData?.lobby ?? {}) as Record<string, unknown>
  const la = (after.customData?.lobby ?? {}) as Record<string, unknown>
  for (const k of new Set([...Object.keys(lb), ...Object.keys(la)]))
    if (!equal(lb[k], la[k])) out.add(`c:${k}`)
  return out
}

/** `tx.store` for `apply`: the board file, with the rows its upserts replace remembered. */
function watchedStore(
  store: BoardStore,
  priors: Map<string, ElementRow | null>,
  ownDeletedRows: Set<string>,
): BoardStore {
  return new Proxy(store, {
    get(target, prop) {
      if (prop === 'upsert')
        return (w: RowWrite) => {
          if (!priors.has(w.el.id)) priors.set(w.el.id, target.get(w.el.id))
          target.upsert(w)
        }
      if (prop === 'insertDeleted')
        return (w: DeletedRowWrite) => {
          ownDeletedRows.add(w.el.id)
          target.insertDeleted(w)
        }
      const v = Reflect.get(target, prop, target)
      return typeof v === 'function' ? v.bind(target) : v
    },
  })
}

interface Change {
  before: El | null
  after: El
  prior: ElementRow | null | undefined
  row: ElementRow
}

/**
 * Runs one server write inside the drain's SAVEPOINT (the caller owns it: on a throw it rolls back and,
 * when `touched.caches` is set, rebuilds the room's caches from the file).
 */
export function runServerWrite(
  ctx: ServerWriteContext,
  apply: ServerWriteApply<unknown>,
  touched: { caches: boolean },
): ServerWriteDone {
  const { store, clock, now } = ctx
  const priors = new Map<string, ElementRow | null>()
  const ownDeletedRows = new Set<string>()
  const tx: ServerWriteTx = Object.freeze({ store: watchedStore(store, priors, ownDeletedRows), clock, now })
  const out = apply(tx) as unknown
  if (!isObject(out) || !Array.isArray(out.changed) || !isObject(out.doc))
    throw new ServerWriteContractError(
      'the outcome is not { changed, doc, result } (apply must be synchronous)',
    )

  // 1. the report against the file
  const changes = new Map<string, Change>()
  for (const ch of out.changed as unknown[]) {
    const after = isObject(ch) ? (ch.after as El | undefined) : undefined
    if (!isObject(after) || typeof after.id !== 'string')
      throw new ServerWriteContractError('a change has no element')
    if (changes.has(after.id)) throw new ServerWriteContractError('an element is reported twice')
    const row = store.get(after.id)
    if (!row || row.clock !== clock)
      throw new ServerWriteContractError("a reported element is not stored at the write's clock")
    if (canonicalJson(row.el) !== canonicalJson(after))
      throw new ServerWriteContractError('a reported element is not stored as reported')
    const check = checkElement(row.el)
    if (!check.ok) throw new ServerWriteContractError(`a written element is not valid (${check.code})`)
    const prior = priors.get(after.id)
    const before =
      prior !== undefined
        ? ((prior?.el as El | undefined) ?? null)
        : (((ch as { before?: unknown }).before as El | null | undefined) ?? null)
    if (before && !(row.el.version > before.version))
      throw new ServerWriteContractError("a written element's version is not above the stored one")
    changes.set(after.id, { before, after: row.el as El, prior, row })
  }
  if (store.countSince(clock - 1) !== changes.size)
    throw new ServerWriteContractError("rows are stored at the write's clock that it did not report")
  const doc = out.doc as Record<string, unknown>
  for (const [key, value] of Object.entries(doc)) {
    const d = store.docGet(key)
    if (!d || d.clock !== clock || !equal(d.value, value))
      throw new ServerWriteContractError("a reported doc key is not stored at the write's clock")
    const problem = docValueProblem(key, value ?? null)
    if (problem) throw new ServerWriteContractError('a doc value its key does not allow')
  }
  if (store.docCountAt(clock) !== Object.keys(doc).length)
    throw new ServerWriteContractError("doc keys are stored at the write's clock that it did not report")

  // 1b. the text lease and the cross-element invariants hold for server writes too (V2: the contract left
  // them to the route, and a route that forgot could store a label of a missing container, a frameId on a
  // rectangle, or overwrite text someone is typing, whose next push was then STALE). A write that changes a
  // text's `text`, `layout`, `life` or `bind`, or a container's `life`, while anyone holds the lease is
  // refused 409 `leased`; one that leaves an invariant broken around what it wrote is a contract error.
  const leases = ctx.env().leases
  for (const { before, after } of changes.values()) {
    if (!before) continue
    const slots = changedSlots(before, after)
    const guarded = before.type === 'text' ? ['text', 'layout', 'life', 'bind'] : ['life']
    if (!guarded.some((g) => slots.has(g))) continue
    const ids = new Set([isLabel(before) ? (before.containerId as string) : before.id])
    if (isLabel(after)) ids.add(after.containerId as string)
    if ([...ids].some((id) => leases.holderOf(id, now) !== null))
      throw new HttpError(409, 'leased', 'Someone is typing in this text. Try again in a moment.')
  }
  // The neighbourhood of the write, before and after it: every written element (its old and its new
  // state), what either state names (container, frame, binding targets, bound elements), and what those
  // list in turn. Both sides see the same ids, so a rule that reads past the neighbourhood reports the same
  // on both, and only what the write CHANGED counts: a new violation anywhere in it, whichever element
  // or group id it is reported on, refuses the write (V2's re-check: four writes stored a violation on an
  // unchanged neighbour or on a group, because only violations on written ids were kept).
  const aroundIds = new Set<string>()
  const refsOf = (el: El | null | undefined): string[] => {
    if (!el) return []
    const out = [el.containerId, el.frameId, el.startBinding?.elementId, el.endBinding?.elementId]
    for (const r of (el.boundElements ?? []) as { id: string }[]) out.push(r.id)
    return out.filter((x): x is string => typeof x === 'string' && x.length > 0)
  }
  const afterOf = (id: string): El | null => {
    const c = changes.get(id)
    return c ? c.after : ((store.get(id)?.el as El | undefined) ?? null)
  }
  const beforeOf = (id: string): El | null => {
    const c = changes.get(id)
    return c ? c.before : ((store.get(id)?.el as El | undefined) ?? null)
  }
  for (const [id, c] of changes) {
    aroundIds.add(id)
    for (const r of [...refsOf(c.before), ...refsOf(c.after)]) aroundIds.add(r)
  }
  for (const id of [...aroundIds])
    for (const r of [...refsOf(beforeOf(id)), ...refsOf(afterOf(id))]) aroundIds.add(r)
  const side = (of: (id: string) => El | null) =>
    [...aroundIds].map(of).filter((e): e is El => e !== null) as never
  const key = (v: { code: string; id: string }) => `${v.code}:${v.id}`
  const was = new Set(checkInvariantsOf(side(beforeOf)).map(key))
  const broken = checkInvariantsOf(side(afterOf)).filter(
    (v) => v.code !== 'GROUP_NESTING' && v.code !== 'INDEX_DUPLICATE' && !was.has(key(v)),
  )
  // group nesting is board-wide (the room's group map), and index sharing is checked below on the cache
  const groupsRemoved: string[][] = []
  const groupsAdded: string[][] = []
  for (const { before, after } of changes.values()) {
    if (before && !before.isDeleted) groupsRemoved.push((before.groupIds ?? []) as string[])
    if (!after.isDeleted) groupsAdded.push((after.groupIds ?? []) as string[])
  }
  const touchedGroups = [...groupsRemoved, ...groupsAdded]
  const nestedBefore = ctx.groups.conflicts(touchedGroups, touchedGroups)
  for (const g of ctx.groups.conflicts(groupsRemoved, groupsAdded))
    if (!nestedBefore.has(g)) broken.push({ code: 'GROUP_NESTING', id: g })
  if (broken.length)
    throw new ServerWriteContractError(
      `the write breaks an invariant (${[...new Set(broken.map((v) => v.code))].join(', ')})`,
    )

  // 2. stamped as the server's: group clocks, tombstones, "Recently deleted"
  let deletions = 0
  for (const [id, c] of changes) {
    const { before, after, prior, row } = c
    const gclock: Record<string, number> = { ...(prior?.gclock ?? {}) }
    for (const [k, v] of Object.entries(row.gclock)) gclock[k] = Math.max(gclock[k] ?? 0, v)
    if (before)
      for (const slot of changedSlots(before, after)) gclock[slot] = Math.max(gclock[slot] ?? 0, clock)
    const nowDeleted = !!after.isDeleted
    const wasDeleted = !before || !!before.isDeleted
    const deletedClock = nowDeleted ? (wasDeleted ? (prior?.deletedClock ?? clock) : clock) : null
    const deletedAt = nowDeleted ? (wasDeleted ? (prior?.deletedAt ?? now) : now) : null
    if (!equal(gclock, row.gclock) || deletedClock !== row.deletedClock || deletedAt !== row.deletedAt)
      store.upsert({ el: after, clock, gclock, deletedClock, deletedAt })
    if (nowDeleted && !wasDeleted) {
      deletions++
      if (!ownDeletedRows.has(id))
        store.insertDeleted({
          batch: clock,
          el: after,
          deletedBy: ctx.identity.uid,
          deletedByName: ctx.identity.name,
          deletedAt: now,
          session: ctx.deletedSession,
        })
    }
  }

  // 3. the caches follow; then the order and the caps are checked on them
  touched.caches = true
  const itemOf = (e: El) => (isLabel(e) ? 0 : 1)
  let addedElements = 0
  let addedItems = 0
  for (const [id, { before, after }] of changes) {
    const wasLive = !!before && !before.isDeleted
    const isLive = !after.isDeleted
    if (wasLive) {
      ctx.counts.elements--
      ctx.counts.items -= itemOf(before as El)
      ctx.groups.remove((before as El).groupIds)
      addedElements--
      addedItems -= itemOf(before as El)
    }
    // a tombstone's key stays taken (V3)
    if (!isLive) ctx.index.setDead(id, after.index)
    if (isLive) {
      ctx.counts.elements++
      ctx.counts.items += itemOf(after)
      ctx.groups.add(after.groupIds)
      addedElements++
      addedItems += itemOf(after)
      if (!isValidIndexKey(after.index))
        throw new ServerWriteContractError('a live element has no valid index')
      ctx.index.set(id, after.index as string)
    }
  }
  // a tombstone at a key the write gave a live element moves right above it (V3), a stamped server repair
  const rekeyed = new Map<string, { before: WireElement; after: WireElement }>()
  const liveIdx = new Map<string, string>()
  for (const [id, { after }] of changes) if (!after.isDeleted) liveIdx.set(after.index as string, id)
  for (const r of store.tombstoneIndexRows()) {
    const owner = liveIdx.get(r.idx)
    if (!owner || owner === r.id || changes.has(r.id)) continue
    const row = store.get(r.id)
    if (!row?.deleted) continue
    const next = keyAbove(ctx.index, r.idx, r.id)
    const el = {
      ...row.el,
      index: next,
      version: row.el.version + 1,
      versionNonce: ctx.env().nonce(),
      updated: now,
    } as WireElement
    store.upsert({
      el,
      clock,
      gclock: { ...row.gclock, z: clock },
      deletedClock: row.deletedClock,
      deletedAt: row.deletedAt,
    })
    ctx.index.setDead(r.id, next)
    rekeyed.set(r.id, { before: row.el, after: el })
  }
  for (const [id, { after }] of changes) {
    if (after.isDeleted) continue
    if (ctx.index.usedByOther(after.index as string, id))
      throw new ServerWriteContractError("a written element's index is used by another element")
    const label = isLabel(after) ? after : null
    const container = label
      ? (changes.get(label.containerId)?.after ?? (store.get(label.containerId)?.el as El))
      : null
    const pairs: [El, El][] = []
    if (label && container && !container.isDeleted) pairs.push([label, container])
    if (!label)
      for (const r of (after.boundElements ?? []) as { id: string; type: string }[]) {
        if (r.type !== 'text' || changes.has(r.id)) continue
        const l = store.get(r.id)?.el as El | undefined
        if (l && !l.isDeleted && l.containerId === id) pairs.push([l, after])
      }
    for (const [l, c] of pairs)
      if (!((l.index as string) > (c.index as string) || (l.index === c.index && l.id > c.id)))
        throw new ServerWriteContractError('a label does not sort after its container')
  }
  if (
    (addedElements > 0 && ctx.counts.elements > MAX_LIVE_ELEMENTS) ||
    (addedItems > 0 && ctx.counts.items > MAX_ITEMS)
  )
    throw new HttpError(409, 'element-limit', 'This board is full.')

  // 4. rule 7: the arrows the write moves (as a push's writes would)
  const moved: string[] = []
  const arrows: string[] = []
  for (const [id, { before, after }] of changes) {
    if (after.isDeleted) continue
    const came = !before || !!before.isDeleted
    if (
      isBindable(after as never) &&
      (came || RESNAP_TRIGGER_FIELDS.some((f) => !equal(before?.[f], after[f])))
    )
      moved.push(id)
    if (
      after.type === 'arrow' &&
      (came ||
        !equal(pathUnitOf(before as El), pathUnitOf(after)) ||
        !equal(before?.startBinding, after.startBinding) ||
        !equal(before?.endBinding, after.endBinding))
    )
      arrows.push(id)
  }
  const changed = new Map<string, { before: WireElement | null; after: WireElement }>()
  for (const [id, c] of changes) changed.set(id, { before: c.before, after: c.after })
  for (const [id, c] of rekeyed) changed.set(id, c)
  if (moved.length || arrows.length) {
    const derived = new PushApplier(
      ctx.env(),
      ctx.identity,
      { seq: 0, base: clock, ops: [], files: new Map(), receivedAt: now },
      clock,
    )
    for (const id of moved) derived.movedTargets.add(id)
    for (const id of arrows) derived.resnapArrows.add(id)
    const res = derived.run()
    for (const [id, ch] of res.changed) {
      const cur = changed.get(id)
      changed.set(id, { before: cur ? cur.before : ch.before, after: ch.after })
    }
  }

  const wrote = changed.size > 0 || Object.keys(doc).length > 0
  if (wrote) ctx.ledger.set(clock, ctx.identity.uid)
  return { wrote, changed, doc, deletions, result: out.result }
}
