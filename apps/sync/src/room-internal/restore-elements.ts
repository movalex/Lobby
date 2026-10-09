// The selective restore (wave L, L7-2; owner W7): a checkpoint's copies of chosen elements written back into
// the LIVE board, for everyone, in one server write (packages/contracts sync-internal.ts, history.ts):
//
//   POST /internal/boards/:bid/restore-elements  RestoreElementsBody → 200 RestoreElementsAnswer
//
// The api reads the checkpoint (a v1 body through its converter), closes the ids over bound texts and
// containers, makes a 'before_restore' checkpoint and calls this route (apps/api features/history
// restore-elements.ts). Everything below runs inside the room's queue (room-internal/board.ts `writeBoard` →
// the room's `serverWrite`, CR 2F-2): one SAVEPOINT in the drain's transaction, the changes broadcast in the
// batch's one `changes` frame after COMMIT, no ack to anyone. The room holds it to the server-write contract
// (room/server-write.ts): the element check, the cross-element invariants, the caps (409 `element-limit`),
// the group clocks, "Recently deleted" rows for what it removes, and rule 7 (every arrow bound to a target this
// write moves, and every arrow whose own path or bindings it writes, is re-snapped in the same clock, labels
// with it). Only lb_* tables are written (never the tldraw tables nor dr_deleted_*: the board store has no
// statement that touches them).
//
// Per asked id, its UNIT is written or skipped whole: an element with its bound text (a note and its words, an
// arrow and its label), named by the container's id or the label's.
//  - a live element gets the checkpoint's copy: every field group (geometry as whole `path` units for arrows
//    and lines, style, text, layout, membership, meta, file), its kept `id`, `version` above both, a fresh
//    nonce. What another person owns stays as it is now: `plusOne:<uid>` keys (each one's own mark), the
//    create-only keys, and `lobbyServer` (its author; `lastEditedBy` becomes the restorer when the words change).
//  - a deleted (or compacted) element is re-created with its kept id and `created: null`, as the checkpoint
//    held it (the "Recently deleted" precedent: its author and marks as they were).
//  - `removeAbsent` ("Undo restore"): an asked id the checkpoint lacks but the board has is removed, its label
//    with it (it came back with the restore being undone). Wave L round 1: it is an undo, not a wholesale
//    restore. `restoreClock` is the clock the undone restore committed at (every server write has a clock of its
//    own). A unit is taken back only when that restore wrote it (an element of it stored at that clock) and
//    nobody wrote it since: an element stored above that clock (a colleague's edit, move or deletion), or one it
//    would bring back that was deleted by anything but that restore, skips the unit CHANGED. A unit the restore
//    did not write has nothing to undo: it is left as it is (listed in `restored` for a restore unit).
//  - what this write removes is "Recently deleted" by the restorer (`actor`), not by Lobby.
//  - a unit whose text is under a lease (anyone's: the api is no session) is skipped, LEASED; one with an
//    element locked now (its head, its label, or a label's container) is INVALID: a restore never overrides a
//    lock, as no push does (room/merge.ts step 5), and "Undo restore" neither; one whose copy fails today's
//    element check, or is inconsistent (a label without its container), is INVALID; an id the checkpoint lacks
//    is MISSING.
// References are made to hold, as server fixes: a frame or a binding target that is neither on the board nor
// restored is dropped (the element stays where it is, out of the frame; the arrow end is free); a container's
// current label that is not the checkpoint's is removed with it; targets list the arrows bound to them; group
// ids that would nest differently from the board's groups now are dropped; z-order keys are re-checked (the
// checkpoint's key when no other element uses it, a label right after its container, else a fresh key).
// Whatever would still break an invariant takes its units out (INVALID), never the whole write.

import type { ServerResponse } from 'node:http'
import { checkElement, type WireElement } from '@draftroom/canvas-schema/elements'
import { indexKeyBetween, isBindable, isValidIndexKey } from '@draftroom/canvas-schema/engine'
import { stripEngineArtifacts } from '@draftroom/canvas-schema/groups'
import { canonicalJson } from '@draftroom/canvas-schema/hash'
import { checkInvariants, groupParents, type Violation } from '@draftroom/canvas-schema/invariants'
import { GROUP_NAMES } from '@draftroom/canvas-schema/protocol'
import {
  RESTORE_ELEMENTS_BODY_LIMIT_BYTES,
  type RestoreElementsAnswer,
  RestoreElementsBody,
} from '@draftroom/contracts'
import type {
  InternalRoute,
  RoomExtensionContext,
  ServerWriteChange,
  ServerWriteTx,
} from '../engine-switch.ts'
import { readJson } from '../http/body.ts'
import { HttpError, sendJson } from '../http/respond.ts'
import type { Gclock } from '../room/schema.ts'
import type { ServerWriteDeletedView, ServerWriteLeaseView } from '../room/server-write.ts'
import type { ElementRow } from '../room/store.ts'
import { boardParam, writeBoard } from './board.ts'
import { type El, isLabel, isObject, parseElement } from './elements.ts'

type SkipCode = RestoreElementsAnswer['skipped'][number]['code']

/** Rounds of "take out what still breaks an invariant" before the rest is written (each takes one unit out at least). */
const MAX_REPAIR_ROUNDS = 32

const nonce = () => Math.floor(Math.random() * 2 ** 31)
const same = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null)
const allGroupsAt = (prev: Gclock | null, clock: number): Gclock => {
  const g: Record<string, number> = { ...(prev ?? {}) }
  for (const name of GROUP_NAMES) g[name] = clock
  return g
}
const isPlusOne = (k: string) => k.startsWith('plusOne:')
/** customData.lobby keys only their writer's create sets (canvas-schema custom-data.ts class 2). */
const CREATE_ONLY = new Set(['kind', 'ai', 'privateFrame'])
const lobbyOf = (el: El | null | undefined): Record<string, unknown> => {
  const lobby = isObject(el?.customData) ? el.customData.lobby : undefined
  return isObject(lobby) ? { ...lobby } : {}
}
const lobbyServerOf = (el: El | null | undefined): Record<string, unknown> | undefined => {
  const s = isObject(el?.customData) ? el.customData.lobbyServer : undefined
  return isObject(s) ? structuredClone(s) : undefined
}
/** The element without the fields every write changes (to tell an unchanged one). */
const content = (el: El): El => {
  const { version: _v, versionNonce: _n, updated: _u, ...rest } = el
  return rest as El
}

/** One asked id's unit: an element with its bound text, written or skipped together. */
interface Unit {
  /** the container, or the element itself; never a label */
  readonly headId: string
  /** the asked ids it answers for */
  readonly asked: string[]
  /** `restore`: the checkpoint's copies; `remove`: removeAbsent of what the checkpoint lacks */
  readonly kind: 'restore' | 'remove'
  /** the checkpoint's copies (restore) */
  readonly head: El | null
  readonly label: El | null
  /** the plan: id → the element after the write (a tombstone for what it removes) */
  planned: Map<string, El>
}

/** Sorted index keys with "the next key above" (the keys other live elements use, then the planned ones). */
class Keys {
  private readonly list: string[]
  constructor(keys: Iterable<string>) {
    this.list = [...new Set(keys)].sort()
  }
  private at(k: string): number {
    let lo = 0
    let hi = this.list.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if ((this.list[mid] as string) < k) lo = mid + 1
      else hi = mid
    }
    return lo
  }
  has(k: string): boolean {
    return this.list[this.at(k)] === k
  }
  add(k: string): void {
    const i = this.at(k)
    if (this.list[i] !== k) this.list.splice(i, 0, k)
  }
  /** A fresh key right above `lo` (at the top when null), below the next key above it. */
  above(lo: string | null): string {
    if (lo === null) return indexKeyBetween(this.list.at(-1) ?? null, null)
    let i = this.at(lo)
    while (i < this.list.length && (this.list[i] as string) <= lo) i++
    return indexKeyBetween(lo, this.list[i] ?? null)
  }
}

/** The checkpoint copy's bound text (its `boundElements` text entry, or a text that names it as container). */
function checkpointLabelOf(head: El, cp: ReadonlyMap<string, El>): { ok: boolean; label: El | null } {
  const refs = (Array.isArray(head.boundElements) ? head.boundElements : []).filter(
    (r: { type?: unknown }) => r?.type === 'text',
  ) as { id: string }[]
  if (refs.length > 1) return { ok: false, label: null }
  const ref = refs[0]
  if (ref) {
    const label = cp.get(ref.id)
    if (label?.type !== 'text' || label.containerId !== head.id) return { ok: false, label: null }
    return { ok: true, label }
  }
  for (const el of cp.values())
    if (isLabel(el) && el.containerId === head.id) return { ok: false, label: null }
  return { ok: true, label: null }
}

function parseBody(raw: unknown): RestoreElementsBody {
  const parsed = RestoreElementsBody.safeParse(raw)
  if (!parsed.success)
    throw new HttpError(
      400,
      'bad-request',
      'Expected { actor, ids, elements } (packages/contracts sync-internal.ts).',
    )
  return parsed.data
}

/** The restore as a server write (runs inside the write's transaction, in the room's drain). */
export function applyRestoreElements(tx: ServerWriteTx, body: RestoreElementsBody) {
  const { store } = tx
  const leaseHolderOf = (tx as Partial<ServerWriteLeaseView>).leaseHolderOf
  const leased = (id: unknown) => typeof id === 'string' && !!leaseHolderOf && leaseHolderOf(id) !== null
  const deletedSession = (tx as Partial<ServerWriteDeletedView>).deletedSession
  const actor = { uid: body.actor.uid, name: body.actor.name, guest: false }

  // the checkpoint's copies (the first of an id), and the board now
  const cp = new Map<string, El>()
  for (const raw of body.elements)
    if (isObject(raw) && typeof raw.id === 'string' && typeof raw.type === 'string' && !cp.has(raw.id))
      cp.set(raw.id, raw as El)
  const live = new Map<string, El>()
  for (const r of store.db.prepare('SELECT data FROM lb_elements WHERE deleted = 0').all() as {
    data: string
  }[]) {
    const el = parseElement(r.data)
    if (el) live.set(el.id, el)
  }
  const rows = new Map<string, ElementRow | null>()
  const row = (id: string): ElementRow | null => {
    if (!rows.has(id)) rows.set(id, store.get(id))
    return rows.get(id) ?? null
  }
  /** the live labels of `id` now (its boundElements' text entries and any text naming it) */
  const liveLabelsOf = (id: string): El[] => {
    const out = new Map<string, El>()
    const head = live.get(id)
    for (const r of (head?.boundElements ?? []) as { id: string; type: string }[]) {
      const l = r.type === 'text' ? live.get(r.id) : undefined
      if (l && isLabel(l) && l.containerId === id) out.set(l.id, l)
    }
    for (const el of live.values()) if (isLabel(el) && el.containerId === id) out.set(el.id, el)
    return [...out.values()]
  }

  // 1. the units, in the order they were asked for
  const skipped = new Map<string, SkipCode>()
  const restoredWithout: string[] = []
  const units: Unit[] = []
  const unitByHead = new Map<string, Unit>()
  const restoreUnit = (headId: string): Unit | SkipCode => {
    const known = unitByHead.get(headId)
    if (known) return known
    const head = cp.get(headId)
    if (!head || isLabel(head)) return 'INVALID'
    const own = checkpointLabelOf(head, cp)
    if (!own.ok) return 'INVALID'
    const u: Unit = { headId, asked: [], kind: 'restore', head, label: own.label, planned: new Map() }
    units.push(u)
    unitByHead.set(headId, u)
    return u
  }
  for (const id of new Set(body.ids)) {
    const el = cp.get(id)
    let u: Unit | SkipCode
    if (el) {
      u = restoreUnit(isLabel(el) ? (el.containerId as string) : id)
      if (typeof u !== 'string' && isLabel(el) && u.label?.id !== id) u = 'INVALID'
    } else if (!body.removeAbsent) u = 'MISSING'
    else {
      const now = live.get(id)
      if (!now) {
        // neither the checkpoint nor the board has it: it is as the checkpoint had it
        restoredWithout.push(id)
        continue
      }
      const headId = isLabel(now) ? (now.containerId as string) : id
      if (cp.has(headId)) u = restoreUnit(headId)
      else {
        u = unitByHead.get(headId) ?? {
          headId,
          asked: [],
          kind: 'remove',
          head: null,
          label: null,
          planned: new Map(),
        }
        if (!unitByHead.has(headId)) {
          units.push(u)
          unitByHead.set(headId, u)
        }
      }
    }
    if (typeof u === 'string') skipped.set(id, u)
    else u.asked.push(id)
  }

  // 2. leases: a unit with a text under anyone's lease is skipped whole (a label's lease is its container's id);
  // locks: a unit with a live element that is locked now (a label follows its container's lock) is skipped
  // whole, INVALID. A restore never overrides a lock, as no push does (room/merge.ts step 5: a locked element
  // takes no change but its unlock): a facilitator's locked template notes or frame stay as they are, and the
  // checkpoint's copy (maybe unlocked) does not unlock them. "Undo restore" alike: a locked element stays.
  const skipUnit = (u: Unit, code: SkipCode) => {
    for (const id of u.asked) skipped.set(id, code)
    u.asked.length = 0
    u.planned.clear()
  }
  const lockedNow = (id: string) => {
    const r = row(id)
    const el = r?.el as El | undefined
    return !!r && !r.deleted && !!el && el.isDeleted !== true && el.locked === true
  }
  for (const u of units) {
    const ids = new Set<string>([u.headId])
    for (const l of [u.label, ...liveLabelsOf(u.headId)]) if (l) ids.add(l.id)
    for (const id of [...ids]) {
      const stored = row(id)?.el as El | undefined
      if (stored?.type === 'text' && typeof stored.containerId === 'string') ids.add(stored.containerId)
    }
    if ([...ids].some(leased)) skipUnit(u, 'LEASED')
    else if ([...ids].some(lockedNow)) skipUnit(u, 'INVALID')
  }

  // 3. each unit's elements as the checkpoint had them (references are resolved in step 4)
  const tombstone = (el: El): El => ({ ...structuredClone(el), isDeleted: true })
  const fromCheckpoint = (copy: El, prev: ElementRow | null): El | null => {
    const prevEl = (prev?.el as El | undefined) ?? null
    if (prevEl && prevEl.type !== copy.type) return null
    const prevLive = !!prev && !prev.deleted && !prevEl?.isDeleted
    const next = stripEngineArtifacts(structuredClone(copy)) as El
    next.isDeleted = false
    next.created = next.type === 'stickynote' || !prevLive ? null : (prevEl?.created ?? null)
    if (next.type === 'image') next.status = 'saved'
    // customData: what others own stays as it is now on a live element
    const lobby = lobbyOf(copy)
    let server = lobbyServerOf(copy)
    if (prevLive && prevEl) {
      const nowLobby = lobbyOf(prevEl)
      for (const k of Object.keys(lobby)) if (isPlusOne(k) || CREATE_ONLY.has(k)) delete lobby[k]
      for (const [k, v] of Object.entries(nowLobby)) if (isPlusOne(k) || CREATE_ONLY.has(k)) lobby[k] = v
      server = lobbyServerOf(prevEl)
      if (next.type === 'text' && next.originalText !== prevEl.originalText)
        server = {
          ...(server ?? { createdBy: actor, createdAt: tx.now }),
          lastEditedBy: actor,
          lastEditedAt: tx.now,
        }
    } else if (!server) {
      server = lobbyServerOf(prevEl) ?? {
        createdBy: actor,
        createdAt: tx.now,
        lastEditedBy: next.type === 'text' ? actor : null,
        lastEditedAt: tx.now,
      }
    }
    const customData: Record<string, unknown> = {}
    if (Object.keys(lobby).length) customData.lobby = lobby
    if (server) customData.lobbyServer = server
    if (Object.keys(customData).length) next.customData = customData
    else delete next.customData
    return next
  }
  for (const u of units) {
    if (!u.asked.length) continue
    if (u.kind === 'remove') {
      const head = live.get(u.headId)
      if (head) u.planned.set(head.id, tombstone(head))
      for (const l of liveLabelsOf(u.headId)) u.planned.set(l.id, tombstone(l))
      continue
    }
    const head = fromCheckpoint(u.head as El, row(u.headId))
    const label = u.label ? fromCheckpoint(u.label, row(u.label.id)) : null
    if (!head || (u.label && !label)) {
      skipUnit(u, 'INVALID')
      continue
    }
    u.planned.set(head.id, head)
    if (label) {
      const prev = live.get(label.id)
      if (prev && prev.containerId !== u.headId) {
        skipUnit(u, 'INVALID')
        continue
      }
      u.planned.set(label.id, label)
    }
    for (const l of liveLabelsOf(u.headId)) if (l.id !== label?.id) u.planned.set(l.id, tombstone(l))
  }
  // 3b. "Undo restore" (round 1): only what the undone restore wrote, and only while nobody wrote it since
  if (body.removeAbsent) {
    const at = body.restoreClock ?? -1
    for (const u of units) {
      if (!u.asked.length) continue
      const ids = new Set<string>([u.headId, ...u.planned.keys()])
      for (const l of liveLabelsOf(u.headId)) ids.add(l.id)
      let wrote = false
      let since = false
      for (const id of ids) {
        const r = row(id)
        if (r && r.clock === at) wrote = true
        if (r && r.clock > at) since = true
        // never bring back what anything but that restore deleted (or what is compacted away)
        const p = u.planned.get(id)
        if (p && !p.isDeleted && (!r || ((r.deleted || (r.el as El).isDeleted === true) && r.clock !== at)))
          since = true
      }
      if (since) skipUnit(u, 'CHANGED')
      else if (!wrote) {
        if (u.kind === 'restore')
          for (const [id, el] of u.planned) if (!el.isDeleted) restoredWithout.push(id)
        u.asked.length = 0
        u.planned.clear()
      }
    }
  }
  // an element is planned by one unit only (a later unit that names it again is inconsistent)
  const plannedBy = new Map<string, Unit>()
  for (const u of units) {
    if (!u.asked.length) continue
    if ([...u.planned.keys()].some((id) => plannedBy.has(id))) {
      skipUnit(u, 'INVALID')
      continue
    }
    for (const id of u.planned.keys()) plannedBy.set(id, u)
  }
  // what is broken on the board already is not this write's to answer for (as the room's own re-check)
  const key = (v: Violation) => `${v.code}:${v.id}:${v.other ?? ''}`
  const was = new Set(checkInvariants([...live.values()] as WireElement[]).map(key))

  // 4. references, the targets' lists, z-order; then the invariants, taking out what still breaks one
  let changed: ServerWriteChange[] = []
  for (let round = 0; ; round++) {
    const active = units.filter((u) => u.asked.length > 0)
    const plan = new Map<string, El>()
    const unitOfId = new Map<string, Unit>()
    for (const u of active)
      for (const [id, el] of u.planned) {
        plan.set(id, structuredClone(el))
        unitOfId.set(id, u)
      }
    const after = (id: unknown): El | null => {
      if (typeof id !== 'string') return null
      const p = plan.get(id)
      if (p) return p.isDeleted ? null : p
      return live.get(id) ?? null
    }
    // 4a. frames, containers, arrow ends of the planned elements
    const order = [...plan.values()].sort((a, b) =>
      (a.index ?? '') < (b.index ?? '') ? -1 : (a.index ?? '') > (b.index ?? '') ? 1 : a.id < b.id ? -1 : 1,
    )
    for (const el of order) {
      if (el.isDeleted || isLabel(el)) continue
      if (el.type === 'frame' || (typeof el.frameId === 'string' && after(el.frameId)?.type !== 'frame'))
        el.frameId = null
      if (el.type === 'arrow')
        for (const end of ['startBinding', 'endBinding'] as const) {
          const b = el[end] as { elementId?: unknown } | null | undefined
          if (!b) continue
          const target = after(b.elementId)
          if (!target || isLabel(target) || !isBindable(target as never)) el[end] = null
        }
    }
    for (const el of order) {
      if (el.isDeleted || !isLabel(el)) continue
      const container = after(el.containerId)
      el.frameId = container?.frameId ?? null
      el.groupIds = [...((container?.groupIds ?? []) as string[])]
    }
    // 4b. live elements around them: what they name must still be there (server fixes)
    const patched = new Map<string, El>()
    const patch = (id: string): El => {
      let p = patched.get(id)
      if (!p) {
        p = structuredClone(live.get(id) as El)
        patched.set(id, p)
      }
      return p
    }
    const gone = new Set([...plan.values()].filter((e) => e.isDeleted).map((e) => e.id))
    for (const el of live.values()) {
      if (plan.has(el.id)) continue
      if (typeof el.frameId === 'string' && gone.has(el.frameId) && !isLabel(el)) patch(el.id).frameId = null
      if (el.type === 'arrow')
        for (const end of ['startBinding', 'endBinding'] as const)
          if (gone.has((el[end] as { elementId?: string } | null)?.elementId ?? '')) patch(el.id)[end] = null
    }
    for (const el of live.values())
      if (isLabel(el) && patched.has(el.containerId as string) && !plan.has(el.id))
        patch(el.id).frameId = patched.get(el.containerId as string)?.frameId ?? null
    // 4c. every bindable's list names exactly the live arrows bound to it and its label
    const arrowsTo = new Map<string, string[]>()
    const each = (fn: (el: El) => void) => {
      for (const el of plan.values()) if (!el.isDeleted) fn(el)
      for (const el of live.values()) if (!plan.has(el.id)) fn(patched.get(el.id) ?? el)
    }
    each((el) => {
      if (el.type !== 'arrow') return
      for (const b of [el.startBinding, el.endBinding] as ({ elementId?: string } | null | undefined)[]) {
        const t = b?.elementId
        if (!t) continue
        const list = arrowsTo.get(t) ?? []
        if (!list.includes(el.id)) list.push(el.id)
        arrowsTo.set(t, list)
      }
    })
    const listFor = (el: El, label: string | null): { id: string; type: string }[] | null => {
      const want = new Map<string, string>()
      if (label) want.set(label, 'text')
      for (const a of arrowsTo.get(el.id) ?? []) want.set(a, 'arrow')
      const out: { id: string; type: string }[] = []
      for (const r of (el.boundElements ?? []) as { id: string; type: string }[])
        if (want.get(r.id) === r.type) {
          out.push({ id: r.id, type: r.type })
          want.delete(r.id)
        }
      for (const [id, type] of [...want].sort((a, b) => (a[0] < b[0] ? -1 : 1))) out.push({ id, type })
      return out.length ? out : null
    }
    const labels = new Map<string, string>()
    each((el) => {
      if (isLabel(el) && !labels.has(el.containerId as string)) labels.set(el.containerId as string, el.id)
    })
    const labelOf = (id: string): string | null => labels.get(id) ?? null
    for (const el of plan.values()) if (!el.isDeleted) el.boundElements = listFor(el, labelOf(el.id))
    // the live elements whose list may change: targets of a planned arrow (now or as planned), lists that
    // name a planned element, and the ones patched above
    const near = new Set(patched.keys())
    for (const id of plan.keys()) {
      for (const t of [live.get(id)?.startBinding, live.get(id)?.endBinding] as ({
        elementId?: string
      } | null)[])
        if (t?.elementId) near.add(t.elementId)
      for (const [t, list] of arrowsTo) if (list.includes(id)) near.add(t)
    }
    for (const el of live.values())
      if (((el.boundElements ?? []) as { id: string }[]).some((r) => plan.has(r.id) || patched.has(r.id)))
        near.add(el.id)
    for (const id of near) {
      const el = live.get(id)
      if (!el || plan.has(id)) continue
      const list = listFor(patched.get(id) ?? el, labelOf(id))
      if (!same(list, el.boundElements ?? null)) patch(id).boundElements = list
    }
    // 4d. group ids: one parent per group across the board (else the planned element's groups are dropped)
    const parents = new Map<string, string | null>()
    const conflicts = (ids: readonly string[]) =>
      groupParents(ids).some(([g, p]) => parents.has(g) && parents.get(g) !== p)
    const learn = (ids: readonly string[]) => {
      for (const [g, p] of groupParents(ids)) if (!parents.has(g)) parents.set(g, p)
    }
    for (const el of live.values()) if (!plan.has(el.id)) learn((el.groupIds ?? []) as string[])
    for (const el of order) {
      if (el.isDeleted || isLabel(el)) continue
      const ids = Array.isArray(el.groupIds) ? (el.groupIds as string[]) : []
      if (conflicts(ids)) el.groupIds = []
      else learn(ids)
    }
    for (const el of order)
      if (!el.isDeleted && isLabel(el))
        el.groupIds = [...((after(el.containerId)?.groupIds ?? []) as string[])]
    // 4e. z-order: the checkpoint's key when free (a label above its container), else the element's key now,
    // else a fresh one
    const keys = new Keys(
      [...live.values()]
        .filter((e) => !plan.has(e.id))
        .map((e) => e.index)
        .filter(isValidIndexKey),
    )
    const liveFirst = [
      ...order.filter((e) => !e.isDeleted && !isLabel(e)),
      ...order.filter((e) => !e.isDeleted && isLabel(e)),
    ]
    for (const el of liveFirst) {
      const floor = isLabel(el) ? ((after(el.containerId)?.index as string | undefined) ?? null) : null
      const candidates = [el.index, live.get(el.id)?.index]
      const free = candidates.find(
        (k): k is string => isValidIndexKey(k) && !keys.has(k) && (floor === null || k > floor),
      )
      el.index = free ?? keys.above(floor)
      keys.add(el.index)
    }
    // 4f. the invariants on the board after it (live elements), only what this write is part of
    const board: El[] = []
    for (const el of live.values()) if (!plan.has(el.id)) board.push(patched.get(el.id) ?? el)
    for (const el of plan.values()) if (!el.isDeleted) board.push(el)
    const touched = (v: Violation) =>
      [v.id, v.other].filter((x): x is string => typeof x === 'string' && (plan.has(x) || patched.has(x)))
    const broken = checkInvariants(board as WireElement[]).filter(
      (v) => touched(v).length > 0 && !was.has(key(v)),
    )
    // the element check of every planned element (texts are laid out as the checkpoint had them)
    const invalid = new Set<Unit>()
    for (const [id, el] of plan) {
      if (el.isDeleted) continue
      if (!checkElement({ ...el, version: 1, versionNonce: 1, updated: tx.now }).ok)
        invalid.add(unitOfId.get(id) as Unit)
    }
    for (const v of broken) {
      const own = touched(v)
        .map((id) => unitOfId.get(id))
        .filter((u): u is Unit => !!u)
      if (own.length) for (const u of own) invalid.add(u)
      else {
        // a violation on a neighbour only: the units whose plan names it are taken out
        const ids = new Set(touched(v))
        for (const u of active)
          for (const el of u.planned.values())
            if (
              ids.has(el.containerId as string) ||
              ids.has(el.frameId as string) ||
              ids.has((el.startBinding as { elementId?: string } | null)?.elementId as string) ||
              ids.has((el.endBinding as { elementId?: string } | null)?.elementId as string)
            )
              invalid.add(u)
      }
    }
    if (invalid.size && round < MAX_REPAIR_ROUNDS) {
      for (const u of invalid) skipUnit(u, 'INVALID')
      continue
    }
    if (invalid.size || broken.length)
      throw new HttpError(409, 'restore-inconsistent', 'The restored elements are not consistent.')

    // 5. write what changes (an element already as planned is left alone), each version above both
    changed = []
    const write = (id: string, next: El) => {
      const prev = row(id)
      const prevEl = (prev?.el as El | undefined) ?? null
      if (prevEl && !prev?.deleted && !next.isDeleted && same(content(prevEl), content(next))) return
      if (prevEl && (prev?.deleted || prevEl.isDeleted) && next.isDeleted) return
      const el = {
        ...next,
        version: Math.max(prevEl?.version ?? 0, Number(next.version) || 0) + 1,
        versionNonce: nonce(),
        updated: tx.now,
      } as El
      const check = checkElement(el)
      if (!check.ok)
        throw new HttpError(409, 'restore-invalid', `A restored element is not valid (${check.code}).`)
      const recreated = !prevEl || !!prev?.deleted || !!prevEl.isDeleted
      store.upsert({
        el: check.element,
        clock: tx.clock,
        // a re-created element is the server's at every group; the room stamps a live one's changed groups
        gclock: recreated && !el.isDeleted ? allGroupsAt(prev?.gclock ?? null, tx.clock) : {},
        deletedClock: null,
        deletedAt: null,
      })
      // round 1: what it removes is the restorer's deletion in "Recently deleted" (the room's own row would name
      // Lobby); a write without a room keeps no such rows
      if (el.isDeleted && !recreated && deletedSession !== undefined)
        store.insertDeleted({
          batch: tx.clock,
          el: check.element,
          deletedBy: actor.uid,
          deletedByName: actor.name,
          deletedAt: tx.now,
          session: deletedSession,
        })
      changed.push({ before: (prevEl as WireElement | null) ?? null, after: check.element })
    }
    for (const [id, el] of plan) write(id, el)
    for (const [id, el] of patched) write(id, el)
    break
  }

  const restored: string[] = []
  for (const u of units)
    if (u.asked.length)
      for (const [id, el] of u.planned) if (!el.isDeleted || u.kind === 'remove') restored.push(id)
  for (const id of restoredWithout) restored.push(id)
  const answer: RestoreElementsAnswer = {
    restored: [...new Set(restored)],
    skipped: [...skipped].map(([id, code]) => ({ id, code })),
    // nothing written: the board's clock before this write (the batch's clock does not move for it)
    clock: changed.length ? tx.clock : tx.clock - 1,
  }
  return { changed, doc: {}, result: answer }
}

async function handle(
  ctx: RoomExtensionContext,
  req: Parameters<InternalRoute['handle']>[0],
  res: ServerResponse,
  raw: string,
) {
  const boardId = boardParam(raw)
  const body = parseBody(await readJson(req, RESTORE_ELEMENTS_BODY_LIMIT_BYTES))
  sendJson(res, 200, await writeBoard(ctx, boardId, (tx) => applyRestoreElements(tx, body)))
}

export function restoreElementsRoutes(ctx: RoomExtensionContext): InternalRoute[] {
  return [
    {
      method: 'POST',
      path: /^\/internal\/boards\/([^/]+)\/restore-elements$/,
      handle: (req, res, [raw = '']) => handle(ctx, req, res, raw),
    },
  ]
}
