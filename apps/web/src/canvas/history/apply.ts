/**
 * Applying an undo or a redo: a 3-way compare-and-set against the current scene (plan §2.8).
 *
 * | Case | Rule | Skip reason |
 * | field or `customData.lobby` key | set back only if the current value still equals the side being left; the recorded fields of `pos`, `shape` and `layout` go back together or not at all | `changed` |
 * | `groupIds` | remove the ids this entry added if present; re-add the ids it removed if that group still exists | `group-gone` |
 * | `boundElements` | the same, id by id (bookkeeping: the server keeps them symmetric, so skips are silent) | — |
 * | element deleted by someone else since | not touched, never revived | `deleted` |
 * | undo of my own create | delete, unless someone else has since put children in it or bound to it | `has-foreign-children` |
 * | undo of my own delete | revive, unless the id was purged or it would point at a missing parent or target | `orphan` / `gone` |
 * | a label leased by someone else | its `text` and `layout` (and its and its container's `life`) are not touched | `locked` |
 *
 * A field whose current value already equals the target is a no-op, not a skip (nothing was kept
 * from anyone), and it is not carried to the opposite stack.
 */
import type { BoundRef, ElementChange, FieldChange, HistEl, Scene, Side } from './diff.ts'
import { clone, deepEqual, fieldGroup, type GroupName } from './fields.ts'

export type Direction = 'undo' | 'redo'

export type SkipReason =
  | 'changed'
  | 'deleted'
  | 'has-foreign-children'
  | 'orphan'
  | 'gone'
  | 'locked'
  | 'group-gone'

export interface Skip {
  id: string
  /** a field name, `c:<key>`, `groupIds:<gid>`, `bound:<id>`, or `element` */
  what: string
  reason: SkipReason
  /** bookkeeping only (e.g. `boundElements`): never counted in "N changes kept" */
  silent: boolean
}

export interface ApplyContext {
  /** true when another session holds the text lease on `leaseId` (a container, or a free text) */
  isLeasedByOther?: (leaseId: string) => boolean
  /**
   * Recompute geometry that depends on what changed (bound arrow endpoints, label layout) with
   * `@excalidraw/element` helpers, only for the touched ids. Returns extra patches; they are pushed
   * as ordinary edits and never recorded. Patches to a label leased by someone else are dropped.
   */
  recompute?: (
    touched: readonly string[],
    next: ReadonlyMap<string, HistEl>,
  ) => ReadonlyMap<string, Record<string, unknown>>
}

export interface ApplyResult {
  /** field → value to write, per element (customData as a whole object) */
  patches: Map<string, Record<string, unknown>>
  /** the current element with its patch applied */
  elements: Map<string, HistEl>
  /** the part of each change that was actually applied (same orientation as the input) */
  applied: ElementChange[]
  skips: Skip[]
  /** elements with at least one non-silent skip: the "N changes kept" toast */
  kept: number
}

const other = (s: Side): Side => (s === 'before' ? 'after' : 'before')

const lobbyOf = (el: HistEl | undefined): Record<string, unknown> =>
  ((el?.customData as { lobby?: Record<string, unknown> } | undefined)?.lobby ?? {}) as Record<
    string,
    unknown
  >

const leaseIdOf = (el: HistEl) => (el.type === 'text' && el.containerId ? el.containerId : el.id)

const isBookkeepingOnly = (c: ElementChange) =>
  Object.keys(c.fields).length === 0 && Object.keys(c.lobby).length === 0 && !c.groupIds && !!c.bound

/** groups whose recorded fields are compared and restored as one unit */
const COUPLED = new Set<GroupName>(['pos', 'shape', 'layout'])

const REF_FIELDS = ['containerId', 'frameId'] as const

const refsOf = (el: Record<string, unknown>): string[] => {
  const out: string[] = []
  for (const f of REF_FIELDS) {
    const v = el[f]
    if (typeof v === 'string' && v) out.push(v)
  }
  for (const f of ['startBinding', 'endBinding']) {
    const v = el[f] as { elementId?: unknown } | null | undefined
    if (v && typeof v.elementId === 'string') out.push(v.elementId)
  }
  return out
}

export const applyChanges = (
  changes: readonly ElementChange[],
  dir: Direction,
  scene: Scene,
  ctx: ApplyContext = {},
): ApplyResult => {
  const want: Side = dir === 'undo' ? 'before' : 'after'
  const have = other(want)
  const skips: Skip[] = []
  const skip = (id: string, what: string, reason: SkipReason, silent = false) =>
    skips.push({ id, what, reason, silent })
  const leased = (el: HistEl) => ctx.isLeasedByOther?.(leaseIdOf(el)) ?? false
  const labelOf = (container: HistEl): HistEl | undefined => {
    const b = (container.boundElements as BoundRef[] | null | undefined)?.find((r) => r.type === 'text')
    return b ? scene.get(b.id) : undefined
  }
  const lifeLeased = (el: HistEl) => {
    if (leased(el)) return true
    const label = labelOf(el)
    return !!label && leased(label)
  }

  // ---- phase 1: life (deletes and revives) and the elements that are out of reach
  const active = new Map<string, ElementChange>()
  const liveAfter = new Map<string, boolean>()
  for (const [id, el] of scene) liveAfter.set(id, !el.isDeleted)
  const lifeTarget = new Map<string, boolean>() // id -> isDeleted to write
  for (const c of changes) {
    const cur = scene.get(c.id)
    const life = c.fields.isDeleted
    if (!cur) {
      skip(c.id, 'element', life && life[want] === false ? 'orphan' : 'gone', isBookkeepingOnly(c))
      continue
    }
    if (cur.isDeleted) {
      const revives = !!life && life[have] === true && life[want] === false
      if (!revives) {
        skip(c.id, 'element', 'deleted', isBookkeepingOnly(c))
        continue
      }
      if (lifeLeased(cur)) {
        skip(c.id, 'isDeleted', 'locked')
        continue
      }
      lifeTarget.set(c.id, false)
      liveAfter.set(c.id, true)
    } else if (life && life[want] === true) {
      if (life[have] !== false) {
        skip(c.id, 'isDeleted', 'changed')
      } else if (lifeLeased(cur)) {
        skip(c.id, 'isDeleted', 'locked')
      } else {
        lifeTarget.set(c.id, true)
        liveAfter.set(c.id, false)
      }
    }
    active.set(c.id, c)
  }

  // the value a field will have after this apply (for reference checks)
  const valueAfter = (id: string, f: string): unknown => {
    const c = active.get(id)
    const cur = scene.get(id)
    const fc = c?.fields[f]
    if (fc && cur && deepEqual(cur[f], fc[have])) return fc[want]
    return cur?.[f]
  }

  // ---- phase 2: reference checks, iterated to a fixed point
  // who references whom after this apply (an arrow whose binding this entry also reverts no longer counts)
  const refsAfter = (id: string, el: HistEl) =>
    active.has(id)
      ? refsOf({
          containerId: valueAfter(id, 'containerId'),
          frameId: valueAfter(id, 'frameId'),
          startBinding: valueAfter(id, 'startBinding'),
          endBinding: valueAfter(id, 'endBinding'),
        })
      : refsOf(el as Record<string, unknown>)
  const referrers = new Map<string, string[]>()
  for (const [oid, oel] of scene) {
    for (const r of refsAfter(oid, oel)) {
      const list = referrers.get(r)
      if (list) list.push(oid)
      else referrers.set(r, [oid])
    }
  }
  for (let changed = true; changed; ) {
    changed = false
    for (const [id, del] of lifeTarget) {
      if (del === false) {
        // revive: every parent / target must be live afterwards
        const refs = refsOf({
          containerId: valueAfter(id, 'containerId'),
          frameId: valueAfter(id, 'frameId'),
          startBinding: valueAfter(id, 'startBinding'),
          endBinding: valueAfter(id, 'endBinding'),
        })
        if (refs.some((r) => !liveAfter.get(r))) {
          lifeTarget.delete(id)
          liveAfter.set(id, false)
          active.delete(id)
          skip(id, 'element', 'orphan')
          changed = true
        }
      } else {
        // delete: nobody outside this apply may still reference it
        const foreign = (referrers.get(id) ?? []).some((oid) => oid !== id && liveAfter.get(oid))
        if (foreign) {
          lifeTarget.delete(id)
          liveAfter.set(id, true)
          skip(id, 'isDeleted', 'has-foreign-children')
          changed = true
        }
      }
    }
  }

  // group ids re-added by this apply, per group (a group restored on 2+ elements exists again)
  const readdCount = new Map<string, number>()
  for (const c of active.values()) {
    if (!c.groupIds) continue
    const add = want === 'before' ? c.groupIds.removed : c.groupIds.added
    for (const g of add) readdCount.set(g, (readdCount.get(g) ?? 0) + 1)
  }
  const groupExistsElsewhere = (g: string, self: string) => {
    for (const [oid, oel] of scene) {
      if (oid === self || !liveAfter.get(oid)) continue
      if ((oel.groupIds as string[] | undefined)?.includes(g)) return true
    }
    return (readdCount.get(g) ?? 0) >= 2
  }

  // ---- phase 3: fields, customData keys, groupIds, boundElements
  const patches = new Map<string, Record<string, unknown>>()
  const applied: ElementChange[] = []
  for (const c of active.values()) {
    const cur = scene.get(c.id) as HistEl
    const patch: Record<string, unknown> = {}
    const done: ElementChange = { id: c.id, created: c.created, fields: {}, lobby: {} }
    const labelLocked = cur.type === 'text' && leased(cur)
    const target = lifeTarget.get(c.id)
    if (target !== undefined) {
      patch.isDeleted = target
      done.fields.isDeleted = c.fields.isDeleted as FieldChange
    }
    // Coupled geometry (x with y, width with height and points, a label's layout) is one unit: the
    // fields of such a group that this entry recorded go back together or not at all. Other groups are
    // compared field by field (a fill and a stroke colour are independent).
    const units = new Map<string, string[]>()
    for (const f of Object.keys(c.fields)) {
      if (f === 'isDeleted') continue
      const group = fieldGroup(cur, f)
      const key = group && COUPLED.has(group) ? `group:${group}` : `field:${f}`
      units.set(key, [...(units.get(key) ?? []), f])
    }
    for (const fields of units.values()) {
      const group = fieldGroup(cur, fields[0] as string)
      if (labelLocked && (group === 'text' || group === 'layout')) {
        for (const f of fields) skip(c.id, f, 'locked')
        continue
      }
      const atHave = fields.every((f) => deepEqual(cur[f], (c.fields[f] as FieldChange)[have]))
      const atWant = fields.every((f) => deepEqual(cur[f], (c.fields[f] as FieldChange)[want]))
      if (atHave) {
        for (const f of fields) {
          patch[f] = clone((c.fields[f] as FieldChange)[want])
          done.fields[f] = c.fields[f] as FieldChange
        }
      } else if (!atWant) {
        for (const f of fields) skip(c.id, f, 'changed')
      }
    }
    const lobbyNow = lobbyOf(cur)
    let lobbyNext: Record<string, unknown> | null = null
    for (const [k, fc] of Object.entries(c.lobby)) {
      const now = lobbyNow[k]
      if (deepEqual(now, fc[have])) {
        lobbyNext ??= { ...lobbyNow }
        if (fc[want] === undefined) delete lobbyNext[k]
        else lobbyNext[k] = clone(fc[want])
        done.lobby[k] = fc
      } else if (!deepEqual(now, fc[want])) {
        skip(c.id, `c:${k}`, 'changed')
      }
    }
    if (lobbyNext) patch.customData = { ...((cur.customData as object | undefined) ?? {}), lobby: lobbyNext }
    if (c.groupIds) {
      const remove = want === 'before' ? c.groupIds.added : c.groupIds.removed
      const add = want === 'before' ? c.groupIds.removed : c.groupIds.added
      const order = want === 'before' ? c.groupIds.before : c.groupIds.after
      const curIds = [...((cur.groupIds as string[] | undefined) ?? [])]
      const removed = remove.filter((g) => curIds.includes(g))
      let result = curIds.filter((g) => !removed.includes(g))
      const added: string[] = []
      for (const g of order) {
        if (!add.includes(g) || result.includes(g)) continue
        if (!groupExistsElsewhere(g, c.id)) {
          skip(c.id, `groupIds:${g}`, 'group-gone')
          continue
        }
        const pos = order.slice(0, order.indexOf(g)).filter((x) => result.includes(x)).length
        result = [...result.slice(0, pos), g, ...result.slice(pos)]
        added.push(g)
      }
      if (removed.length || added.length) {
        patch.groupIds = result
        done.groupIds =
          want === 'before'
            ? { added: removed, removed: added, before: c.groupIds.before, after: c.groupIds.after }
            : { added, removed, before: c.groupIds.before, after: c.groupIds.after }
      }
    }
    if (c.bound) {
      const remove = want === 'before' ? c.bound.added : c.bound.removed
      const add = want === 'before' ? c.bound.removed : c.bound.added
      const curRefs = [...((cur.boundElements as BoundRef[] | null | undefined) ?? [])]
      const removed = remove.filter((r) => curRefs.some((x) => x.id === r.id))
      let result = curRefs.filter((x) => !removed.some((r) => r.id === x.id))
      const added: BoundRef[] = []
      for (const r of add) {
        if (result.some((x) => x.id === r.id)) continue
        if (!liveAfter.get(r.id)) {
          skip(c.id, `bound:${r.id}`, 'gone', true)
          continue
        }
        result = [...result, { id: r.id, type: r.type }]
        added.push(r)
      }
      if (removed.length || added.length) {
        patch.boundElements = result.length ? result : null
        done.bound = want === 'before' ? { added: removed, removed: added } : { added, removed }
      }
    }
    if (Object.keys(patch).length) {
      patches.set(c.id, patch)
      applied.push(done)
    }
  }

  // ---- side effects: dependent geometry for the touched elements only, never on a leased label
  const elements = new Map<string, HistEl>()
  for (const [id, patch] of patches) elements.set(id, { ...(scene.get(id) as HistEl), ...patch })
  if (ctx.recompute && patches.size) {
    const view = new Map(scene)
    for (const [id, el] of elements) view.set(id, el)
    for (const [id, extra] of ctx.recompute([...patches.keys()], view)) {
      const base = view.get(id)
      if (!base) continue
      const allowed: Record<string, unknown> = {}
      const locked = base.type === 'text' && leased(base)
      for (const [f, v] of Object.entries(extra)) {
        const g = fieldGroup(base, f)
        if (locked && (g === 'text' || g === 'layout')) continue
        allowed[f] = v
      }
      if (!Object.keys(allowed).length) continue
      patches.set(id, { ...(patches.get(id) ?? {}), ...allowed })
      elements.set(id, { ...base, ...allowed })
    }
  }
  const kept = new Set(skips.filter((s) => !s.silent).map((s) => s.id)).size
  return { patches, elements, applied, skips, kept }
}
