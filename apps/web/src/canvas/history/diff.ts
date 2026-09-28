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
  for (const k of keys) {
    if (SPECIAL.has(k)) continue
    if (fieldGroup(next, k) === null && fieldGroup(prev, k) === null) continue
    const a = normalizeField(k, prev[k])
    const b = normalizeField(k, next[k])
    if (!deepEqual(a, b)) change.fields[k] = { before: clone(a), after: clone(b) }
  }
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
