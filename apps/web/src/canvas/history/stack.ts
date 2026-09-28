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
 */
import { type ApplyContext, type ApplyResult, applyChanges, type Direction } from './apply.ts'
import { diffElement, type ElementChange, type HistEl, isEmptyChange, type Scene, type Side } from './diff.ts'
import { clone, deepEqual, fieldGroup, type GroupName } from './fields.ts'

export interface TrackedChange extends ElementChange {
  /** pushes that carried this change, with the side whose values they carried */
  pending: { seq: number; side: Side }[]
  /** the side waiting to be sent (set when recorded, undone or redone; cleared by `markPushed`) */
  unsent: Side | null
}

export interface Entry {
  id: number
  label?: string
  changes: Map<string, TrackedChange>
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
}

export interface HistoryOptions {
  maxEntries?: number
}

const track = (c: ElementChange, unsent: Side): TrackedChange => ({ ...c, pending: [], unsent })

/** a fix key is a top-level field, or `c:<key>` for `customData.lobby.<key>` */
const readFix = (key: string): { lobby: boolean; name: string } =>
  key.startsWith('c:') ? { lobby: true, name: key.slice(2) } : { lobby: false, name: key }

export class LobbyHistory {
  private lastLocal = new Map<string, HistEl>()
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

  /** Start from a scene (welcome, reset): no steps, `lastLocal` = the scene. */
  reset(scene: Scene) {
    this.lastLocal = new Map([...scene].map(([id, el]) => [id, clone(el)]))
    this.undos = []
    this.redos = []
  }

  /**
   * A step boundary (end of a gesture, a text-editor close, one keyboard action, one `transact`).
   * Returns the new entry, or null when nothing but server-owned or local-only fields changed.
   */
  record(scene: Scene, label?: string): Entry | null {
    const changes = new Map<string, TrackedChange>()
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
      if (!isEmptyChange(c)) changes.set(id, track(c, 'after'))
      this.lastLocal.set(id, clone(el))
    }
    // ids that vanished from the scene without `isDeleted` (§2.5.2) are not steps
    for (const id of [...this.lastLocal.keys()]) if (!scene.has(id)) this.lastLocal.delete(id)
    if (changes.size === 0) return null
    const entry: Entry = { id: this.nextId++, label, changes }
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
      if (!r.ok) {
        for (const { entry, change } of carrying) entry.changes.delete(change.id)
      } else {
        if (r.denied) for (const { change } of carrying) this.dropGroups(change, r.denied.groups)
        if (r.fix) this.foldFix(r.id, r.fix, carrying, scene)
      }
      for (const { change } of carrying) change.pending = change.pending.filter((p) => p.seq !== ack.seq)
    }
    this.prune()
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
    if (!after) {
      if (before) this.lastLocal.delete(before.id)
      return
    }
    const last = this.lastLocal.get(after.id)
    if (!last || !before) {
      this.lastLocal.set(after.id, clone(after))
      return
    }
    const c = diffElement(before, after)
    const next: Record<string, unknown> = { ...last }
    for (const [f, fc] of Object.entries(c.fields)) next[f] = clone(fc.after)
    if (Object.keys(c.lobby).length) {
      const cd = (last.customData as Record<string, unknown> | undefined) ?? {}
      const lobby = { ...((cd.lobby as Record<string, unknown> | undefined) ?? {}) }
      for (const [k, fc] of Object.entries(c.lobby)) {
        if (fc.after === undefined) delete lobby[k]
        else lobby[k] = clone(fc.after)
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

  /** Ctrl+Z: the top entry, compare-and-set against `scene`. */
  undo(scene: Scene, ctx?: ApplyContext): ApplyResult | null {
    return this.step('undo', scene, ctx)
  }

  /** Ctrl+Y / Ctrl+Shift+Z: the mirror image. */
  redo(scene: Scene, ctx?: ApplyContext): ApplyResult | null {
    return this.step('redo', scene, ctx)
  }

  private step(dir: Direction, scene: Scene, ctx?: ApplyContext): ApplyResult | null {
    const from = dir === 'undo' ? this.undos : this.redos
    const to = dir === 'undo' ? this.redos : this.undos
    const entry = from.pop()
    if (!entry) return null
    const res = applyChanges([...entry.changes.values()], dir, scene, ctx)
    // what this apply wrote is the local state now: never recorded as a new step
    for (const [id, el] of res.elements) this.lastLocal.set(id, clone(el))
    if (res.applied.length) {
      const side: Side = dir === 'undo' ? 'before' : 'after'
      to.push({
        id: entry.id,
        label: entry.label,
        changes: new Map(res.applied.map((c) => [c.id, track(c, side)])),
      })
    }
    return res
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
    for (const [key, value] of Object.entries(fix)) {
      const { lobby, name } = readFix(key)
      for (const { entry, change, side } of carrying) {
        const bag = lobby ? change.lobby : change.fields
        const fc = bag[name]
        if (!fc) continue
        const old = fc[side]
        fc[side] = clone(value)
        // later entries recorded this field against the unfixed value
        const later = this.undos.slice(this.undos.indexOf(entry) + 1)
        for (const e of later) {
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
    // a field whose two sides became equal is no change any more
    for (const { change } of carrying) {
      for (const [f, fc] of Object.entries(change.fields))
        if (deepEqual(fc.before, fc.after)) delete change.fields[f]
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
