/**
 * Lobby's field-level undo stack (plan §2.8, decision D6). Pure: element maps in, patches out.
 * Excalidraw's own history and deltas are never used: they treat `customData` and `groupIds` as whole
 * values and revert other people's +1s and groups (probe2).
 *
 * Recording: `record(scene)` at a step boundary diffs the scene against `lastLocal` — this module's
 * own snapshot of the scene at the previous boundary, including local changes the server has not
 * acknowledged — never against `confirmed`. Two quick edits are two entries even inside one round trip.
 *
 * What never creates a step: selection and viewport (they are not elements), server `fix` values
 * (folded into the entry that carried the op, and into `lastLocal`), the client's own index re-key of
 * unacknowledged elements, and server repairs or remote changes (`absorb`).
 *
 * The selection is never a change, but an entry remembers the one its step was made with (F11, 3i: tldraw
 * restored it, and a keyboard or screen-reader user keeps their place after Ctrl+Z): `selection.before`,
 * what was selected when the step began, comes back with an undo, `selection.after` with a redo
 * (`StepResult.selection`; the caller re-selects what is still there).
 */

import { copyElement } from '../sync/core/fields.ts'
import { type ApplyContext, type ApplyResult, applyChanges, type Direction } from './apply.ts'
import {
  diffElement,
  type ElementChange,
  type FieldChange,
  type HistEl,
  isEmptyChange,
  type Scene,
  type Side,
} from './diff.ts'
import { clone, deepEqual, fieldGroup, type GroupName } from './fields.ts'

export interface TrackedChange extends ElementChange {
  /** pushes that carried this change, with the side whose values they carried */
  pending: { seq: number; side: Side }[]
  /** the side waiting to be sent (set when recorded, undone or redone; cleared by `markPushed`) */
  unsent: Side | null
}

/** The selection a step was made with (F11): never a change, never compared, only re-selected. */
export interface StepSelection {
  /** selected when the step began: an undo selects it again */
  readonly before: readonly string[]
  /** selected when the step ended: a redo selects it again */
  readonly after: readonly string[]
}

export interface Entry {
  id: number
  label?: string
  changes: Map<string, TrackedChange>
  selection?: StepSelection
}

/** `undo()` / `redo()`: the apply, and the selection to restore (null when the entry recorded none). */
export interface StepResult extends ApplyResult {
  readonly selection: readonly string[] | null
}

/** `LobbyHistory.mark()`: the stack before a write that should join the previous step (`mergeTop`). */
export interface HistoryMark {
  readonly size: number
  readonly top: Entry | null
  readonly redo: number
  /**
   * The entry below `top` when `top` only typed into labels that entry made empty
   * (`creationFilledByTop`): `joinAction` folds the two into one step. Null otherwise.
   */
  readonly creation?: Entry | null
}

function mergeFields(into: Record<string, FieldChange>, from: Record<string, FieldChange>): void {
  for (const [k, fc] of Object.entries(from)) {
    const had = into[k]
    if (had) had.after = fc.after
    else into[k] = { before: fc.before, after: fc.after }
    const now = into[k] as FieldChange
    if (deepEqual(now.before, now.after)) delete into[k]
  }
}

/** `c` (recorded later) folded into `p` (see `LobbyHistory.mergeTop`). */
function mergeChange(p: TrackedChange, c: TrackedChange): void {
  p.created = p.created || c.created
  mergeFields(p.fields, c.fields)
  mergeFields(p.lobby, c.lobby)
  if (c.groupIds) {
    const before = p.groupIds?.before ?? c.groupIds.before
    const after = c.groupIds.after
    const added = after.filter((g) => !before.includes(g))
    const removed = before.filter((g) => !after.includes(g))
    p.groupIds =
      added.length || removed.length ? { added, removed, before: [...before], after: [...after] } : undefined
  }
  if (c.bound) {
    const added = [...(p.bound?.added ?? [])]
    const removed = [...(p.bound?.removed ?? [])]
    for (const r of c.bound.added) {
      const i = removed.findIndex((x) => x.id === r.id)
      if (i >= 0) removed.splice(i, 1)
      else if (!added.some((x) => x.id === r.id)) added.push(r)
    }
    for (const r of c.bound.removed) {
      const i = added.findIndex((x) => x.id === r.id)
      if (i >= 0) added.splice(i, 1)
      else if (!removed.some((x) => x.id === r.id)) removed.push(r)
    }
    p.bound = added.length || removed.length ? { added, removed } : undefined
  }
  p.pending.push(...c.pending)
  p.unsent = c.unsent ?? p.unsent
  p.lifeAt = undefined
}

export type AckResult =
  | {
      id: string
      ok: true
      v?: number
      fix?: Record<string, unknown>
      denied?: { groups: string[]; code: string }
    }
  | { id: string; ok: false; code: string }

export interface Ack {
  seq: number
  r: AckResult[]
  /**
   * Elements the server re-snapped because of this push although it did not write them (bound arrows and
   * their labels, §2.4.2): folded like a fix, never a step (§2.8, spike B).
   */
  derived?: readonly { id: string; v?: number; fix: Record<string, unknown> }[]
}

export interface HistoryOptions {
  maxEntries?: number
}

const track = (c: ElementChange, unsent: Side): TrackedChange => ({ ...c, pending: [], unsent })

/**
 * A copy of a whole element for `lastLocal` (wave N.1, follow-up 2): canvas-schema's typed copy (sync/core/fields.ts
 * `copyElement`, equal to `structuredClone` for every element of the schema at a fraction of its cost). The scene's own
 * objects are mutated in place by the engine, so the stack keeps its own; a welcome's reset and a cached paint copy
 * every element of the board (twice per 10k open, structuredClone was the larger part of both long tasks).
 */
const copyOf = (el: HistEl): HistEl => copyElement(el)

/** A change of an existing element's `index` and nothing else. */
const isIndexOnly = (c: ElementChange): boolean =>
  !c.created &&
  !!c.fields.index &&
  Object.keys(c.fields).length === 1 &&
  Object.keys(c.lobby).length === 0 &&
  !c.groupIds &&
  !c.bound

/** Paint order: by `index`, then by id (the engine's `compareIndexThenId`). */
const paintCmp = (ia: unknown, a: string, ib: unknown, b: string): number => {
  const x = typeof ia === 'string' ? ia : ''
  const y = typeof ib === 'string' ? ib : ''
  if (x !== y) return x < y ? -1 : 1
  return a < b ? -1 : a > b ? 1 : 0
}

/** An `index` as a sort key: a key that is not a string sorts first, as in `paintCmp`. */
const keyOf = (v: unknown): string => (typeof v === 'string' ? v : '')

/**
 * Which of `candidates` (elements whose only change is a new `index`; the value is the key each had at the
 * previous boundary) the new keys leave where they were among the live elements: every other live element is
 * painted on the same side of it with the keys of the previous boundary (`prevIndex` for the elements that
 * changed since, the scene's for the rest) as with the keys now. A deleted element paints nowhere, so a
 * deleted candidate always qualifies, and one the scene lacks never does.
 *
 * One pass for all of them (it was one scan of the scene per candidate, so a mass re-key that kept the order
 * after a paste or an engine re-key cost O(n^2): 5,000 elements 686 ms, 20,000 elements 15.5 s on the main
 * thread). The live elements are put in their paint order of the previous boundary and in their order now
 * (two sorts, O(n log n); the scene is nearly sorted both ways in practice). A candidate has the same place
 * relative to every other element in both orders exactly when no pair that includes it is inverted between
 * them, i.e. when its rank now is above the ranks now of everything before it in the old order and below
 * those of everything after it: one prefix maximum and one suffix minimum over the old order.
 */
export function rekeysKeepingPaintOrder(
  candidates: ReadonlyMap<string, unknown>,
  scene: Scene,
  prevIndex: ReadonlyMap<string, unknown>,
): Set<string> {
  const kept = new Set<string>()
  const ids: string[] = []
  const was: string[] = []
  const now: string[] = []
  let live = 0
  for (const [id, el] of scene) {
    if (el.isDeleted) {
      if (candidates.has(id)) kept.add(id)
      continue
    }
    if (candidates.has(id)) live++
    ids.push(id)
    now.push(keyOf(el.index))
    was.push(
      keyOf(candidates.has(id) ? candidates.get(id) : prevIndex.has(id) ? prevIndex.get(id) : el.index),
    )
  }
  if (live === 0) return kept
  const n = ids.length
  const byWas = Array.from({ length: n }, (_, i) => i).sort((a, b) =>
    paintCmp(was[a], ids[a] as string, was[b], ids[b] as string),
  )
  const byNow = Array.from({ length: n }, (_, i) => i).sort((a, b) =>
    paintCmp(now[a], ids[a] as string, now[b], ids[b] as string),
  )
  const rankNow = new Int32Array(n)
  for (let r = 0; r < n; r++) rankNow[byNow[r] as number] = r
  // suffixMin[p]: the lowest rank now among the elements at old positions p and after
  const suffixMin = new Int32Array(n + 1)
  suffixMin[n] = n
  for (let p = n - 1; p >= 0; p--)
    suffixMin[p] = Math.min(suffixMin[p + 1] as number, rankNow[byWas[p] as number] as number)
  let prefixMax = -1
  for (let p = 0; p < n; p++) {
    const i = byWas[p] as number
    const r = rankNow[i] as number
    if (candidates.has(ids[i] as string) && prefixMax < r && r < (suffixMin[p + 1] as number))
      kept.add(ids[i] as string)
    if (r > prefixMax) prefixMax = r
  }
  return kept
}

/** Reject codes the engine retries (protocol.ts REJECT_CODE_INFO `retryable`): the change is sent again. */
const RETRYABLE: ReadonlySet<string> = new Set(['RATE', 'UNAVAILABLE'])

/** a fix key is a top-level field, or `c:<key>` for `customData.lobby.<key>` */
const readFix = (key: string): { lobby: boolean; name: string } =>
  key.startsWith('c:') ? { lobby: true, name: key.slice(2) } : { lobby: false, name: key }

export class LobbyHistory {
  private lastLocal = new Map<string, HistEl>()
  /** flips of `isDeleted` by others (absorbed), per element: the life version of §2.8's check */
  private readonly lifeFlips = new Map<string, number>()
  private undos: Entry[] = []
  private redos: Entry[] = []
  private nextId = 1
  private readonly maxEntries: number

  constructor(opts: HistoryOptions = {}) {
    this.maxEntries = opts.maxEntries ?? 200
  }

  get undoSize() {
    return this.undos.length
  }

  get redoSize() {
    return this.redos.length
  }

  /** read-only views for tests and the debug panel */
  get undoEntries(): readonly Entry[] {
    return this.undos
  }

  get redoEntries(): readonly Entry[] {
    return this.redos
  }

  lastLocalOf(id: string): HistEl | undefined {
    return this.lastLocal.get(id)
  }

  /**
   * Start from a scene (welcome, reset): no steps, `lastLocal` = the scene.
   *
   * Wave N.1: `reuse(el)` says the scene entry is the scene's own element (not a stand-in the caller built); such an
   * element whose `lastLocal` copy has its version and versionNonce keeps that copy (the version fast path of `record`:
   * the same version and nonce are the same element), instead of a new copy of every element of the board at each
   * welcome. The copies a cached paint or a snapshot's chunks absorbed are those copies.
   */
  reset(scene: Scene, reuse?: (el: HistEl) => boolean) {
    const next = new Map<string, HistEl>()
    for (const [id, el] of scene) {
      const had = reuse ? this.lastLocal.get(id) : undefined
      if (
        had &&
        had.version !== undefined &&
        had.version === el.version &&
        had.versionNonce === el.versionNonce &&
        had.type === el.type &&
        reuse?.(el)
      )
        next.set(id, had)
      else next.set(id, copyOf(el))
    }
    this.lastLocal = next
    this.undos = []
    this.redos = []
  }

  /**
   * Wave N.1: elements that came into the scene outside any step, given as objects the caller owns outright (nobody
   * else holds or writes them; the scene got its own copies of them): the stack's copy of each is the object itself.
   */
  adopt(elements: Iterable<HistEl>) {
    for (const el of elements) this.lastLocal.set(el.id, el)
  }

  /**
   * A step boundary (end of a gesture, a text-editor close, one keyboard action, one `transact`).
   * Returns the new entry, or null when nothing but server-owned or local-only fields changed.
   * `selection`: the one the step was made with (kept on the entry, never a change).
   */
  record(scene: Scene, label?: string, selection?: StepSelection): Entry | null {
    const changes = new Map<string, TrackedChange>()
    // the `index` each changed element had at the previous boundary (the paint order then)
    const prevIndex = new Map<string, unknown>()
    for (const [id, el] of scene) {
      const prev = this.lastLocal.get(id)
      if (
        prev &&
        prev.version === el.version &&
        prev.versionNonce === el.versionNonce &&
        prev.version !== undefined
      )
        continue
      const c = diffElement(prev, el)
      if (prev) prevIndex.set(id, prev.index)
      if (!isEmptyChange(c)) changes.set(id, track(c, 'after'))
      this.lastLocal.set(id, copyOf(el))
    }
    // ids that vanished from the scene without `isDeleted` (§2.5.2) are not steps
    for (const id of [...this.lastLocal.keys()]) if (!scene.has(id)) this.lastLocal.delete(id)
    // A new `index` that leaves the paint order as it was is the engine's re-key, never a step (CR-3D-4):
    // Excalidraw's `updateScene` re-keys every element whose key is out of place in the array (a key two
    // concurrent creates share, an order the server's keys changed), with a version bump, after a remote
    // apply as much as after a local write. Recorded, it was an invisible step of its own (an arrow's
    // `index` on bob's stack after both added a branch at once, mindmap-keyboard.spec.ts): its Ctrl+Z
    // changed nothing to see. A reorder (bring to front, send backward) moves the element among the others
    // and stays a step. The new key folds into the entries that hold the element's `index`, so their undo
    // and redo still compare equal.
    // All of them are judged in one sorted pass (`rekeysKeepingPaintOrder`): a mass re-key after a paste
    // or an engine re-key is one such change per element.
    const candidates = new Map<string, unknown>()
    for (const [id, c] of changes) if (isIndexOnly(c)) candidates.set(id, c.fields.index?.before)
    if (candidates.size > 0) {
      const folds = new Map<string, { before: unknown; after: unknown }>()
      for (const id of rekeysKeepingPaintOrder(candidates, scene, prevIndex)) {
        const fc = changes.get(id)?.fields.index
        if (!fc) continue
        folds.set(id, { before: fc.before, after: fc.after })
        changes.delete(id)
      }
      this.foldRekeys(folds)
    }
    if (changes.size === 0) return null
    const entry: Entry = { id: this.nextId++, label, changes }
    if (selection) entry.selection = { before: [...selection.before], after: [...selection.after] }
    this.undos.push(entry)
    if (this.undos.length > this.maxEntries) this.undos.shift()
    this.redos = []
    return entry
  }

  /** The engine sent a push carrying (at least) these element ids. */
  markPushed(seq: number, ids: Iterable<string>) {
    const want = new Set(ids)
    for (const entry of [...this.undos, ...this.redos]) {
      for (const c of entry.changes.values()) {
        if (!want.has(c.id) || c.unsent === null) continue
        c.pending.push({ seq, side: c.unsent })
        c.unsent = null
      }
    }
  }

  /** A retried push goes out under a new seq. */
  retrySeq(oldSeq: number, newSeq: number) {
    for (const entry of [...this.undos, ...this.redos])
      for (const c of entry.changes.values()) for (const p of c.pending) if (p.seq === oldSeq) p.seq = newSeq
  }

  /**
   * The server's answer to a push: rejected ops leave their entries, denied groups leave them too,
   * and `fix` values are folded into the entries that carried them and into `lastLocal`.
   * `scene` is the scene after the engine applied the ack (fixes installed), if available.
   */
  onAck(ack: Ack, scene?: Scene) {
    for (const r of ack.r) {
      const carrying = this.carrying(ack.seq, r.id)
      if (!r.ok && RETRYABLE.has(r.code)) {
        // RATE, UNAVAILABLE: the engine sends the change again under a new seq; it stays in its entry and
        // waits for that push (`markPushed` picks the side up again). Before, it left its entry here, the
        // retry landed, and the next Ctrl+Z undid the step before (V1 N9, N9b)
        for (const { change, side } of carrying) change.unsent ??= side
      } else if (!r.ok) {
        for (const { entry, change } of carrying) entry.changes.delete(change.id)
      } else {
        if (r.denied) for (const { change } of carrying) this.dropGroups(change, r.denied.groups)
        if (r.fix) this.foldFix(r.id, r.fix, carrying, scene)
      }
      for (const { change } of carrying) change.pending = change.pending.filter((p) => p.seq !== ack.seq)
    }
    // re-snaps this push caused on elements it did not write: folded, never a step
    for (const d of ack.derived ?? []) this.foldDerived(d.id, d.fix, scene)
    this.prune()
  }

  /** A `derived` ack row: like a local fix for entries that recorded the element, and `lastLocal` always. */
  private foldDerived(id: string, fix: Record<string, unknown>, scene?: Scene) {
    const carrying: { entry: Entry; change: TrackedChange; side: Side }[] = []
    for (const entry of [...this.undos, ...this.redos]) {
      const change = entry.changes.get(id)
      if (!change) continue
      const side = change.unsent ?? change.pending[change.pending.length - 1]?.side ?? 'after'
      carrying.push({ entry, change, side })
    }
    this.foldFix(id, fix, carrying, scene)
  }

  /**
   * The client's own re-key of an unacknowledged element (index pre-pass, E2), or any other value the
   * engine rewrote on the user's behalf: folded like a server `fix`, never a step.
   */
  foldLocalFix(id: string, fix: Record<string, unknown>, scene?: Scene) {
    const carrying: { entry: Entry; change: TrackedChange; side: Side }[] = []
    for (const entry of [...this.undos, ...this.redos]) {
      const change = entry.changes.get(id)
      if (!change) continue
      const side = change.unsent ?? change.pending[change.pending.length - 1]?.side
      if (side) carrying.push({ entry, change, side })
    }
    this.foldFix(id, fix, carrying, scene)
    this.prune()
  }

  /**
   * A change that came from the server (a remote edit, a repair such as a label cascade or
   * `boundElements` symmetry, a reset from `confirmed` after a reject), applied with
   * `CaptureUpdateAction.NEVER`. `before` is the element as the scene held it before the apply. Only
   * the fields the apply changed move into `lastLocal`, so a local change not recorded yet stays a
   * change. Never a step.
   */
  absorb(before: HistEl | undefined, after: HistEl | undefined) {
    if (before && after && !!before.isDeleted !== !!after.isDeleted)
      this.lifeFlips.set(after.id, (this.lifeFlips.get(after.id) ?? 0) + 1)
    if (!after) {
      if (before) this.lastLocal.delete(before.id)
      return
    }
    const last = this.lastLocal.get(after.id)
    // an element the scene held before this apply but no step recorded yet is a local create waiting for
    // its boundary (a label the text editor made, re-keyed by the index pre-pass or answered by the server
    // before the editor closed): it stays unrecorded, so the boundary records it as created. Taking it into
    // `lastLocal` here made its creation part of no step: after typing into a note created empty, undo
    // left an empty label and never removed it (wave 2E, V1 P6)
    if (!last && before) return
    if (!last || !before) {
      this.lastLocal.set(after.id, copyOf(after))
      return
    }
    // (the change's values are diffElement's own copies, used here only: taken as they are)
    const c = diffElement(before, after)
    const next: Record<string, unknown> = { ...last }
    for (const [f, fc] of Object.entries(c.fields)) next[f] = fc.after
    if (Object.keys(c.lobby).length) {
      const cd = (last.customData as Record<string, unknown> | undefined) ?? {}
      const lobby = { ...((cd.lobby as Record<string, unknown> | undefined) ?? {}) }
      for (const [k, fc] of Object.entries(c.lobby)) {
        if (fc.after === undefined) delete lobby[k]
        else lobby[k] = fc.after
      }
      next.customData = { ...cd, lobby }
    }
    if (c.groupIds) next.groupIds = [...c.groupIds.after]
    if (c.bound) next.boundElements = clone(after.boundElements)
    // when nothing local is left unrecorded, take the version too (keeps `record`'s fast path)
    const rest = diffElement(next as HistEl, after)
    if (isEmptyChange(rest)) {
      next.version = after.version
      next.versionNonce = after.versionNonce
    }
    this.lastLocal.set(after.id, next as HistEl)
  }

  /**
   * The selection the latest step ended with, when it was read before the engine applied a select made in the
   * same breath as the step (`UndoController.boundary`, `SELECTION_SETTLE_MS`): a step that recorded an empty
   * one takes `after`. A step with a selection already, one with none recorded, and the latest step while a
   * redo is possible (it is not the user's last change) are left alone. Returns whether it took it.
   */
  settleSelection(after: readonly string[]): boolean {
    const top = this.undos[this.undos.length - 1]
    const sel = top?.selection
    if (!top || !sel || sel.after.length > 0 || after.length === 0 || this.redos.length > 0) return false
    top.selection = { before: sel.before, after: [...after] }
    return true
  }

  /** The stack as it is now, for `mergeTop(since)`: taken before a write that should join the previous step. */
  mark(): HistoryMark {
    return {
      size: this.undos.length,
      top: this.undos[this.undos.length - 1] ?? null,
      redo: this.redos.length,
      creation: this.creationFilledByTop(),
    }
  }

  /**
   * The entry below the top one when the top one is typing into what that entry made: every change of the
   * top entry is to a label (a text element) the entry below created, which held no words before (its
   * `text` or `originalText` goes from '' to words; the editor's other changes of it come along), or a
   * position or size of such a label's container (the editor's fit), with nothing deleted or brought back.
   * A mind-map topic made by Tab or Enter carries an empty label for its editor (CR-3D-4): tldraw kept the
   * topic and the words typed into it one step. A note's label made by the editor is created by the typing
   * step itself, so a note and the words typed into it stay two steps. Null otherwise, and while
   * something can be redone.
   */
  private creationFilledByTop(): Entry | null {
    const n = this.undos.length
    if (n < 2 || this.redos.length > 0) return null
    const top = this.undos[n - 1] as Entry
    const below = this.undos[n - 2] as Entry
    const labels = new Set<string>()
    let filled = false
    for (const c of top.changes.values()) {
      const el = this.lastLocal.get(c.id)
      if (el?.type !== 'text' || !below.changes.get(c.id)?.created) continue
      if (c.fields.isDeleted || Object.keys(c.lobby).length || c.groupIds || c.bound) return null
      const words = c.fields.originalText ?? c.fields.text
      if (words && words.before === '' && typeof words.after === 'string' && words.after !== '') filled = true
      labels.add(c.id)
    }
    if (!filled) return null
    const containers = new Set<string>()
    for (const id of labels) {
      const cid = this.lastLocal.get(id)?.containerId
      if (cid) containers.add(cid)
    }
    for (const c of top.changes.values()) {
      if (labels.has(c.id)) continue
      const el = this.lastLocal.get(c.id)
      if (!el || !containers.has(c.id)) return null
      if (Object.keys(c.lobby).length || c.groupIds || c.bound) return null
      for (const f of Object.keys(c.fields)) {
        const g = fieldGroup(el, f)
        if (g !== 'pos' && g !== 'shape') return null
      }
    }
    return below
  }

  /**
   * `transact(…, {joinPrevious})`'s merge: `mergeTop(since)`, then, when the mark's top step was typing
   * into labels the step below it made (`since.creation`) and both are still the top two, that step too:
   * the topic, the words typed into it and the layout after them are one undo step. Returns whether the
   * write joined.
   */
  joinAction(since: HistoryMark): boolean {
    const joined = this.mergeTop(since)
    const n = this.undos.length
    if (
      since.creation &&
      this.redos.length === 0 &&
      this.undos[n - 1] === since.top &&
      this.undos[n - 2] === since.creation
    )
      this.mergeTop()
    return joined
  }

  /**
   * Merges the top entry into the entry below it, so one undo undoes both and one redo redoes both
   * (2C's `transact(label, fn, {joinPrevious: true})`: a derived write, the mind map's re-layout after a
   * text change, joins the user's own step; plan §10 item 4, CONTRACTS §10). With `since` (a `mark()`
   * taken before the write) it merges only when exactly one entry was recorded on top of that mark's top
   * since, and the redo stack was empty at the mark (after an undo or a redo the previous step is not the
   * user's last change); without it, whenever the stack holds two entries and nothing can be redone.
   * Returns whether it merged.
   *
   *  - A field changed in both keeps the earlier `before` and the later `after` (a field whose two sides
   *    end up equal is no change any more); a field only the later entry changed is added as it is (its
   *    `before` is the state after the earlier step, which the merged step undoes to).
   *  - `groupIds` and `boundElements` are re-derived from the earlier `before` and the later `after`.
   *  - Pushes pending for either stay pending (acks keep folding their `fix` rows into the merged change),
   *    and a side still to be sent stays to be sent. Remote changes absorbed between the two writes never
   *    touched either entry.
   *  - The selection (F11) is the earlier step's `before` and the later one's `after`.
   */
  mergeTop(since?: HistoryMark): boolean {
    const n = this.undos.length
    if (since) {
      if (!since.top || since.redo > 0) return false
      if (n !== since.size + 1 || this.undos[since.size - 1] !== since.top) return false
    } else if (n < 2 || this.redos.length > 0) return false
    const top = this.undos[n - 1] as Entry
    const into = this.undos[n - 2] as Entry
    for (const c of top.changes.values()) {
      const p = into.changes.get(c.id)
      if (p) mergeChange(p, c)
      else into.changes.set(c.id, c)
    }
    if (into.selection || top.selection)
      into.selection = {
        before: into.selection?.before ?? top.selection?.before ?? [],
        after: top.selection?.after ?? into.selection?.after ?? [],
      }
    this.undos.pop()
    for (const [id, c] of into.changes) if (isEmptyChange(c)) into.changes.delete(id)
    if (into.changes.size === 0) this.undos.pop()
    return true
  }

  /** Ctrl+Z: the top entry, compare-and-set against `scene`; `selection` is its step's `before`. */
  undo(scene: Scene, ctx?: ApplyContext): StepResult | null {
    return this.step('undo', scene, ctx)
  }

  /** Ctrl+Y / Ctrl+Shift+Z: the mirror image; `selection` is the step's `after`. */
  redo(scene: Scene, ctx?: ApplyContext): StepResult | null {
    return this.step('redo', scene, ctx)
  }

  private step(dir: Direction, scene: Scene, ctx?: ApplyContext): StepResult | null {
    const from = dir === 'undo' ? this.undos : this.redos
    const to = dir === 'undo' ? this.redos : this.undos
    const entry = from.pop()
    if (!entry) return null
    const lifeVersion = (id: string) => this.lifeFlips.get(id) ?? 0
    const res = applyChanges([...entry.changes.values()], dir, scene, { ...ctx, lifeVersion })
    // what this apply wrote is the local state now: never recorded as a new step
    for (const [id, el] of res.elements) this.lastLocal.set(id, copyOf(el))
    if (res.applied.length) {
      const side: Side = dir === 'undo' ? 'before' : 'after'
      const mirror: Entry = {
        id: entry.id,
        label: entry.label,
        changes: new Map(
          res.applied.map((c) => {
            const t = track(c, side)
            // the life version as it stands after this apply: the mirror step checks it (U11)
            if (c.fields.isDeleted) t.lifeAt = lifeVersion(c.id)
            return [c.id, t]
          }),
        ),
      }
      // the same step, the other way: its selection keeps its orientation (an undo of it selects `before`)
      if (entry.selection) mirror.selection = entry.selection
      to.push(mirror)
    }
    const sel = entry.selection
    return Object.assign(res, { selection: sel ? (dir === 'undo' ? sel.before : sel.after) : null })
  }

  /**
   * The engine's re-keys (`index` from `before` to `after` per element, the paint order unchanged): an
   * entry that holds an element's `index` at the side the scene is on now (an undo entry's `after`, a redo
   * entry's `before`) takes the new key. One walk over the stacks for all of them (a mass re-key is one
   * per element; a walk per element made it quadratic), each entry walked from its smaller side.
   */
  private foldRekeys(rekeys: ReadonlyMap<string, { before: unknown; after: unknown }>) {
    if (rekeys.size === 0) return
    for (const [stack, side] of [
      [this.undos, 'after'],
      [this.redos, 'before'],
    ] as const)
      for (const entry of stack) {
        const take = (id: string) => {
          const rk = rekeys.get(id)
          const fc = rk && entry.changes.get(id)?.fields.index
          if (rk && fc && deepEqual(fc[side], rk.before)) fc[side] = clone(rk.after)
        }
        if (entry.changes.size <= rekeys.size) for (const id of entry.changes.keys()) take(id)
        else for (const id of rekeys.keys()) take(id)
      }
    this.prune()
  }

  private carrying(seq: number, id: string) {
    const out: { entry: Entry; change: TrackedChange; side: Side }[] = []
    for (const entry of [...this.undos, ...this.redos]) {
      const change = entry.changes.get(id)
      const p = change?.pending.find((x) => x.seq === seq)
      if (change && p) out.push({ entry, change, side: p.side })
    }
    return out
  }

  private dropGroups(change: TrackedChange, groups: readonly string[]) {
    const set = new Set<string>(groups)
    // the group of a field depends on the element kind (a bound label's x/y are layout, §3.2)
    const kind = this.lastLocal.get(change.id) ?? { type: 'rectangle' }
    for (const f of Object.keys(change.fields)) {
      const g: GroupName | null = fieldGroup(kind, f)
      if (g && set.has(g)) delete change.fields[f]
    }
    for (const k of Object.keys(change.lobby)) if (set.has(`c:${k}`)) delete change.lobby[k]
    if (set.has('membership')) delete change.groupIds
    if (set.has('bound')) delete change.bound
  }

  private foldFix(
    id: string,
    fix: Record<string, unknown>,
    carrying: { entry: Entry; change: TrackedChange; side: Side }[],
    scene?: Scene,
  ) {
    // where each carrying entry sits in the undo stack: -1 for a redo entry (an undo's or a redo's push)
    const at = new Map(carrying.map(({ entry }) => [entry, this.undos.indexOf(entry)]))
    for (const [key, value] of Object.entries(fix)) {
      const { lobby, name } = readFix(key)
      for (const { entry, change, side } of carrying) {
        const bag = lobby ? change.lobby : change.fields
        const fc = bag[name]
        if (!fc) continue
        const old = fc[side]
        fc[side] = clone(value)
        // later entries recorded this field against the unfixed value. Only an undo entry has later ones:
        // nothing is recorded while a redo entry exists (a record clears the redo stack). Before
        // (LEAD-foldFix-indexOf), a redo entry's indexOf -1 took EVERY undo entry as later, and an older
        // step whose `before` happened to equal the unfixed value was rewritten (a later Ctrl+Z restored
        // the fixed value instead of its own)
        const i = at.get(entry) ?? -1
        if (i < 0) continue
        for (const e of this.undos.slice(i + 1)) {
          const lc = e.changes.get(id)
          const lf = lc && (lobby ? lc.lobby : lc.fields)[name]
          if (lf && deepEqual(lf.before, old)) lf.before = clone(value)
        }
      }
      const last = this.lastLocal.get(id)
      if (!last) continue
      const inScene = scene?.get(id)
      const sceneValue = inScene
        ? lobby
          ? (inScene.customData as { lobby?: Record<string, unknown> } | undefined)?.lobby?.[name]
          : inScene[name]
        : value
      if (!deepEqual(sceneValue, value)) continue
      const next: Record<string, unknown> = { ...last }
      if (lobby) {
        const cd = (last.customData as Record<string, unknown> | undefined) ?? {}
        next.customData = {
          ...cd,
          lobby: { ...((cd.lobby as object | undefined) ?? {}), [name]: clone(value) },
        }
      } else next[name] = clone(value)
      if (inScene && isEmptyChange(diffElement(next as HistEl, inScene))) {
        next.version = inScene.version
        next.versionNonce = inScene.versionNonce
      }
      this.lastLocal.set(id, next as HistEl)
    }
    // a field whose two sides became equal is no change any more; but an arrow's or a line's `path` unit
    // stays whole while any of it still changes (diff.ts records it whole: its compare and its restore
    // never mix this step's points with another moment's `x`, `y` or `angle`; V1 U-a: a fold dropped them,
    // and the undo of a free end after a re-snap was skipped as "changed")
    for (const { change } of carrying) {
      const kind = this.lastLocal.get(change.id) ?? scene?.get(change.id)
      const isPath = (f: string) => !!kind && fieldGroup(kind, f) === 'path'
      const pathChanges = Object.entries(change.fields).some(
        ([f, fc]) => isPath(f) && !deepEqual(fc.before, fc.after),
      )
      for (const [f, fc] of Object.entries(change.fields))
        if (deepEqual(fc.before, fc.after) && !(pathChanges && isPath(f))) delete change.fields[f]
      for (const [k, fc] of Object.entries(change.lobby))
        if (deepEqual(fc.before, fc.after)) delete change.lobby[k]
    }
  }

  private prune() {
    for (const stack of [this.undos, this.redos]) {
      for (const entry of stack)
        for (const [id, c] of entry.changes) if (isEmptyChange(c)) entry.changes.delete(id)
      for (let i = stack.length - 1; i >= 0; i--) if (stack[i]?.changes.size === 0) stack.splice(i, 1)
    }
  }
}
