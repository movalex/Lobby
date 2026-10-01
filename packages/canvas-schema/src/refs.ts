/**
 * Object refs between the canvas and the api (docs/EXCALIDRAW-MIGRATION.md §3.6, D12). Element ids are
 * kept through conversion; api contracts keep `shape:<elementId>` as their object-ref format
 * (`CommentShapeRef`, `AI_SHAPE_ID_PATTERN`, `DeletedShapeId`), so comment anchors, AI ids and vote
 * targets stay valid with no Postgres migration. This is the one helper that maps between the two.
 * Frozen at the spike B contracts step C0.
 *
 * Pure: no imports but limits.ts.
 */
import { ELEMENT_ID_PATTERN } from './limits.ts'

export const SHAPE_REF_PREFIX = 'shape:'

/** `abc` → `shape:abc`. Throws on a string that is not an element id. */
export function toShapeRef(elementId: string): string {
  if (!ELEMENT_ID_PATTERN.test(elementId)) throw new Error('not an element id')
  return `${SHAPE_REF_PREFIX}${elementId}`
}

/** `shape:abc` → `abc`; null for anything that is not a `shape:` ref of a valid element id. */
export function fromShapeRef(ref: string): string | null {
  if (!ref.startsWith(SHAPE_REF_PREFIX)) return null
  const id = ref.slice(SHAPE_REF_PREFIX.length)
  return ELEMENT_ID_PATTERN.test(id) ? id : null
}
