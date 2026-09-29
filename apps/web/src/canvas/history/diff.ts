/**
 * One element's change between two snapshots, at Lobby's undo granularity (plan §2.8 table):
 * top-level fields as `[before, after]`, `customData.lobby.<key>` per key, `groupIds` and
 * `boundElements` as ids added and removed, `isDeleted` as a field.
 */
import { clone, deepEqual, fieldGroup, normalizeField } from './fields.ts'

export type HistEl = Readonly<Record<string, unknown>> & {
  readonly id: string
  readonly type: string
  readonly isDeleted: boolean
  readonly version?: number
  readonly versionNonce?: number
  readonly containerId?: string | null
}

export type Scene = ReadonlyMap<string, HistEl>

export type Side = 'before' | 'after'

export interface FieldChange {
  before: unknown
  after: unknown
}

export interface BoundRef {
  id: string
  type: string
}

export interface ElementChange {
  id: string
  /** the element did not exist in the previous snapshot (created in this step) */
  created: boolean
  /** top-level fields, including `isDeleted` (a create is `isDeleted: true → false`) */
  fields: Record<string, FieldChange>
  /** `customData.lobby.<key>`; `undefined` = absent */
  lobby: Record<string, FieldChange>
  /** ids added and removed (undo works id by id); the full arrays keep the nesting order */
  groupIds?: { added: string[]; removed: string[]; before: string[]; after: string[] }
  /** refs added and removed, by id */
  bound?: { added: BoundRef[]; removed: BoundRef[] }
  /**
   * The life version of the element (LobbyHistory: flips of `isDeleted` by others it absorbed) when this
   * change was last applied by an undo or a redo: the next apply changes `isDeleted` only if it is unchanged
   * (the life-version check of §2.8, U11). Undefined for a change as recorded.
   */
  lifeAt?: number
}

const lobbyOf = (el: HistEl | undefined): Record<string, unknown> => {
  const cd = el?.customData as { lobby?: Record<string, unknown> } | undefined
  return cd?.lobby ?? {}
}

const SPECIAL = new Set(['groupIds', 'boundElements', 'customData'])

export const isEmptyChange = (c: ElementChange) =>
  Object.keys(c.fields).length === 0 && Object.keys(c.lobby).length === 0 && !c.groupIds && !c.bound

const refs = (v: unknown): BoundRef[] =>
  ((v as BoundRef[] | null | undefined) ?? []).map((r) => ({ id: r.id, type: r.type }))

/**
 * Diff `prev` → `next`. `prev` undefined = created in this step. Server-owned and local-only fields
 * are ignored, and a `fileId` derivative suffix is stripped (E9).
 */
export const diffElement = (prev: HistEl | undefined, next: HistEl): ElementChange => {
  const change: ElementChange = { id: next.id, created: prev === undefined, fields: {}, lobby: {} }
  if (!prev) {
    change.fields.isDeleted = { before: true, after: next.isDeleted }
    return change
  }
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)])
  let path = false
  for (const k of keys) {
    if (SPECIAL.has(k)) continue
    if (fieldGroup(next, k) === null && fieldGroup(prev, k) === null) continue
    const a = normalizeField(k, prev[k])
    const b = normalizeField(k, next[k])
    if (!deepEqual(a, b)) {
      change.fields[k] = { before: clone(a), after: clone(b) }
      if (fieldGroup(next, k) === 'path') path = true
    }
  }
  // An arrow's or a line's geometry is one unit (§2.8, spike B): when any of it changed, the whole unit is
  // recorded on both sides, so its compare (user-set geometry in scene coordinates) and its restore never
  // mix this step's points with another moment's `x`, `y` or `angle`.
  if (path)
    for (const k of keys)
      if (fieldGroup(next, k) === 'path' && !change.fields[k])
        change.fields[k] = { before: clone(prev[k]), after: clone(next[k]) }
  const la = lobbyOf(prev)
  const lb = lobbyOf(next)
  for (const k of new Set([...Object.keys(la), ...Object.keys(lb)])) {
    if (!deepEqual(la[k], lb[k])) change.lobby[k] = { before: clone(la[k]), after: clone(lb[k]) }
  }
  const ga = (prev.groupIds as string[] | undefined) ?? []
  const gb = (next.groupIds as string[] | undefined) ?? []
  const gAdded = gb.filter((g) => !ga.includes(g))
  const gRemoved = ga.filter((g) => !gb.includes(g))
  if (gAdded.length > 0 || gRemoved.length > 0)
    change.groupIds = { added: gAdded, removed: gRemoved, before: [...ga], after: [...gb] }
  const ba = refs(prev.boundElements)
  const bb = refs(next.boundElements)
  const bAdded = bb.filter((r) => !ba.some((x) => x.id === r.id))
  const bRemoved = ba.filter((r) => !bb.some((x) => x.id === r.id))
  if (bAdded.length > 0 || bRemoved.length > 0) change.bound = { added: bAdded, removed: bRemoved }
  return change
}
