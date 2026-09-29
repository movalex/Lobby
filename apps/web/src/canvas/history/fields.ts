/**
 * Field classification for Lobby's undo (plan §2.8, groups from §3.2).
 *
 * Since the spike B contracts step C0 the map is `packages/canvas-schema/src/groups.ts` (one map, one
 * coverage test): this module only adapts it to the undo code's names. An arrow's or a line's geometry is
 * the one `path` unit there (revisions 3.4 and 3.5); `apply.ts` compares and restores it as a unit.
 */
import {
  fieldGroupOf,
  LOCAL_ONLY_FIELDS,
  type GroupName as SchemaGroupName,
  SERVER_OWNED_FIELDS,
  unclassifiedKeys,
} from '@draftroom/canvas-schema/groups'

export type GroupName = SchemaGroupName

/** Never recorded, never undone: owned by the server or local-only (§3.2). */
export const SERVER_OWNED: ReadonlySet<string> = new Set(SERVER_OWNED_FIELDS)
export const LOCAL_ONLY: ReadonlySet<string> = new Set(LOCAL_ONLY_FIELDS)

export interface Classifiable {
  readonly type: string
  readonly containerId?: string | null
}

/** The field group of a top-level field of `el`, or null when the field is not undoable. */
export const fieldGroup = (el: Classifiable, field: string): GroupName | null => fieldGroupOf(el, field)

/** Top-level fields the map does not know (an Excalidraw bump added a field): the coverage test fails on these. */
export const unclassifiedFields = (el: Classifiable & Record<string, unknown>) => unclassifiedKeys(el)

/** The derivative suffix of a local `fileId` is local-only (§2.10.3, E9). */
export const normalizeField = (field: string, value: unknown): unknown =>
  field === 'fileId' && typeof value === 'string' ? value.replace(/@(thumb|display)$/, '') : value

export const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false
    return true
  }
  const ka = Object.keys(a as object).filter((k) => (a as Record<string, unknown>)[k] !== undefined)
  const kb = Object.keys(b as object).filter((k) => (b as Record<string, unknown>)[k] !== undefined)
  if (ka.length !== kb.length) return false
  for (const k of ka)
    if (!deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false
  return true
}

export const clone = <T>(v: T): T => (v === undefined ? v : structuredClone(v))
