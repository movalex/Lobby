/**
 * Field classification for Lobby's undo (plan §2.8, groups from §3.2).
 *
 * NOTE: the canonical field-group map is `packages/canvas-schema/src/groups.ts` (plan §3.2), which is
 * not written yet. This is the spike's copy, element-kind aware like the plan's table; when `groups.ts`
 * lands this file must import from it instead (one map, one coverage test).
 */

export type GroupName =
  | 'pos'
  | 'shape'
  | 'text'
  | 'layout'
  | 'textStyle'
  | 'style'
  | 'bind'
  | 'bound'
  | 'z'
  | 'membership'
  | 'meta'
  | 'file'
  | 'life'

/** Never recorded, never undone: owned by the server or local-only (§3.2). */
export const SERVER_OWNED = new Set(['id', 'type', 'version', 'versionNonce', 'updated', 'created'])
export const LOCAL_ONLY = new Set(['status'])

const FIXED: Record<string, GroupName> = {
  x: 'pos',
  y: 'pos',
  width: 'shape',
  height: 'shape',
  angle: 'shape',
  points: 'shape',
  pressures: 'shape',
  simulatePressure: 'shape',
  polygon: 'shape',
  scale: 'shape',
  crop: 'shape',
  roundness: 'shape',
  seed: 'shape',
  elbowed: 'shape',
  fixedSegments: 'shape',
  startIsSpecial: 'shape',
  endIsSpecial: 'shape',
  baseHeight: 'shape',
  originalText: 'text',
  text: 'layout',
  fontSize: 'textStyle',
  baseFontSize: 'textStyle',
  fontFamily: 'textStyle',
  lineHeight: 'textStyle',
  textAlign: 'textStyle',
  verticalAlign: 'textStyle',
  autoResize: 'textStyle',
  strokeColor: 'style',
  backgroundColor: 'style',
  fillStyle: 'style',
  strokeWidth: 'style',
  strokeStyle: 'style',
  strokeOptions: 'style',
  roughness: 'style',
  opacity: 'style',
  startArrowhead: 'style',
  endArrowhead: 'style',
  startBinding: 'bind',
  endBinding: 'bind',
  containerId: 'bind',
  labelPosition: 'bind',
  boundElements: 'bound',
  index: 'z',
  groupIds: 'membership',
  frameId: 'membership',
  link: 'meta',
  locked: 'meta',
  name: 'meta',
  fileId: 'file',
  isDeleted: 'life',
}

export interface Classifiable {
  readonly type: string
  readonly containerId?: string | null
}

const isBoundLabel = (el: Classifiable) => el.type === 'text' && !!el.containerId
const isFreeText = (el: Classifiable) => el.type === 'text' && !el.containerId

/** The field group of a top-level field of `el`, or null when the field is not undoable. */
export const fieldGroup = (el: Classifiable, field: string): GroupName | null => {
  if (SERVER_OWNED.has(field) || LOCAL_ONLY.has(field) || field === 'customData') return null
  if (
    isBoundLabel(el) &&
    (field === 'x' || field === 'y' || field === 'width' || field === 'height' || field === 'fontSize')
  )
    return 'layout'
  if (isFreeText(el) && (field === 'width' || field === 'height')) return 'layout'
  return FIXED[field] ?? null
}

/** Top-level fields the map does not know (an Excalidraw bump added a field): the coverage test fails on these. */
export const unclassifiedFields = (el: Classifiable & Record<string, unknown>) =>
  Object.keys(el).filter(
    (k) => fieldGroup(el, k) === null && !SERVER_OWNED.has(k) && !LOCAL_ONLY.has(k) && k !== 'customData',
  )

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
