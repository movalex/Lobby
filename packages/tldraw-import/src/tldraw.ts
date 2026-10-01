/**
 * The tldraw 5.4.2 symbols Lobby's tests and fixtures may use (record builders for conversion tests, the
 * fixtures' schema variants, the e2e load generator's board files). Production code outside this package
 * imports nothing of tldraw (D13; AGENTS.md); tests import these from here instead of `@tldraw/*`, so
 * the only packages that depend on tldraw are this one and nothing else.
 */

export type {
  TLArrowBinding,
  TLArrowShape,
  TLAsset,
  TLBinding,
  TLDefaultSizeStyle,
  TLDocument,
  TLFrameShape,
  TLGeoShape,
  TLNoteShape,
  TLPage,
  TLPageId,
  TLParentId,
  TLRecord,
  TLRichText,
  TLSchema,
  TLShape,
  TLShapeId,
  TLTextShape,
} from '@tldraw/tlschema'
export {
  b64Vecs,
  createBindingId,
  createShapeId,
  createShapePropsMigrationIds,
  createShapePropsMigrationSequence,
  createTLSchema,
  defaultBindingSchemas,
  defaultShapeSchemas,
  toRichText,
} from '@tldraw/tlschema'
export { getIndexAbove, getIndicesAbove, type IndexKey, type JsonObject } from '@tldraw/utils'
