// Record factories and schema variants for protocol tests. Records are validated against the shared
// schema at creation so a broken fixture fails here, not as a confusing server-side INVALID_RECORD.
import {
  draftroomSchema,
  FILE_CARD_TYPE,
  fileCardShapeMigrations,
  fileCardShapeProps,
} from '@draftroom/canvas-schema'
import {
  createShapeId,
  createShapePropsMigrationIds,
  createShapePropsMigrationSequence,
  createTLSchema,
  defaultBindingSchemas,
  defaultShapeSchemas,
  type TLRichText,
  type TLSchema,
  type TLShapeId,
  toRichText,
} from '@tldraw/tlschema'

export const PAGE_ID = 'page:page'

/**
 * A shape record of any type, with props left open. Tests build and patch records generically (and
 * sometimes against older schemas), which the TLShape union would reject at every spread.
 */
export interface ShapeRecord {
  id: TLShapeId
  typeName: 'shape'
  type: string
  x: number
  y: number
  rotation: number
  index: string
  parentId: string
  isLocked: boolean
  opacity: number
  meta: Record<string, unknown>
  props: Record<string, unknown>
}

function base(id: string, type: string, over: { x?: number; y?: number; index?: string }) {
  return {
    id: id.startsWith('shape:') ? id : createShapeId(id),
    typeName: 'shape',
    type,
    x: over.x ?? 0,
    y: over.y ?? 0,
    rotation: 0,
    index: over.index ?? 'a1',
    parentId: PAGE_ID,
    isLocked: false,
    opacity: 1,
    meta: {},
  }
}

function checked(record: object, schema: TLSchema = draftroomSchema): ShapeRecord {
  schema.types.shape.validate(record)
  return record as ShapeRecord
}

export function geoShape(
  id: string,
  over: { x?: number; y?: number; index?: string; color?: string; w?: number; text?: string } = {},
): ShapeRecord {
  return checked({
    ...base(id, 'geo', over),
    props: {
      geo: 'rectangle',
      dash: 'draw',
      url: '',
      w: over.w ?? 100,
      h: 100,
      growY: 0,
      scale: 1,
      flipX: false,
      flipY: false,
      labelColor: 'black',
      color: over.color ?? 'black',
      fill: 'none',
      size: 'm',
      font: 'draw',
      align: 'middle',
      verticalAlign: 'middle',
      richText: toRichText(over.text ?? ''),
    },
  })
}

export function noteShape(id: string, text: string, over: { x?: number; y?: number } = {}): ShapeRecord {
  return checked({
    ...base(id, 'note', over),
    props: {
      color: 'yellow',
      labelColor: 'black',
      size: 'm',
      font: 'draw',
      fontSizeAdjustment: 1,
      align: 'middle',
      verticalAlign: 'middle',
      growY: 0,
      url: '',
      richText: toRichText(text),
      scale: 1,
      textLastEditedBy: null,
    },
  })
}

/** Plain text of a TipTap doc as produced by toRichText (paragraphs joined with \n). */
export function plainText(richText: unknown): string {
  const doc = richText as TLRichText | undefined
  return (doc?.content ?? [])
    .map((p) => ((p as { content?: { text?: string }[] }).content ?? []).map((t) => t.text ?? '').join(''))
    .join('\n')
}

/**
 * `shape` retyped. `by` stamps a note's attribution the way tldraw's NoteShapeUtil.onBeforeUpdate
 * does on every text change (the writer's id; the sync server refuses new text under anyone else's,
 * apps/sync/src/attribution.ts). Leave it out only for shapes without attribution.
 */
export function withText(shape: ShapeRecord, text: string, by?: string | null): ShapeRecord {
  const props: Record<string, unknown> = { ...shape.props, richText: toRichText(text) }
  if (by !== undefined && 'textLastEditedBy' in shape.props) props.textLastEditedBy = text === '' ? null : by
  return { ...shape, props }
}

export const TEST_ASSET_ID = 'ast_AAAAAAAAAAAAAAAAAAAA'
export const TEST_VERSION_ID = 'ver_BBBBBBBBBBBBBBBBBBBB'
export const TEST_DERIVATIVE_ID = 'drv_CCCCCCCCCCCCCCCCCCCC'

const fileCardV1Props = (over: { posterDerivativeId?: string | null; name?: string }) => ({
  w: 240,
  h: 180,
  assetId: TEST_ASSET_ID,
  versionId: TEST_VERSION_ID,
  kind: 'video',
  name: over.name ?? 'clip.mp4',
  mimeType: 'video/mp4',
  sizeBytes: 1234,
  status: 'ready',
  pageCount: null,
  durationMs: 5000,
  posterDerivativeId: over.posterDerivativeId ?? null,
})

/** A dr-file-card at the CURRENT schema (migration 1: has posterDerivativeId). */
export function fileCard(
  id: string,
  over: { posterDerivativeId?: string | null; name?: string; x?: number } = {},
): ShapeRecord {
  return checked({ ...base(id, FILE_CARD_TYPE, over), props: fileCardV1Props(over) })
}

// ---- schema variants for negotiation tests -------------------------------------------------------

const { posterDerivativeId: _addedInV1, ...fileCardV0PropValidators } = fileCardShapeProps

/** What a client built before dr-file-card migration 1 shipped would send: version 0, no poster prop. */
export const fileCardV0Schema: TLSchema = createTLSchema({
  shapes: {
    ...defaultShapeSchemas,
    [FILE_CARD_TYPE]: {
      props: fileCardV0PropValidators,
      migrations: createShapePropsMigrationSequence({ sequence: [] }),
    },
  },
  bindings: defaultBindingSchemas,
})

/** A dr-file-card at schema version 0 (no posterDerivativeId), valid only under fileCardV0Schema. */
export function fileCardV0(id: string, over: { name?: string; x?: number } = {}): ShapeRecord {
  const { posterDerivativeId: _notInV0, ...props } = fileCardV1Props(over)
  return checked({ ...base(id, FILE_CARD_TYPE, over), props }, fileCardV0Schema)
}

const futureVersions = createShapePropsMigrationIds(FILE_CARD_TYPE, { FromTheFuture: 2 })

/** A client one dr-file-card migration ahead of the server (e.g. a web deploy before the sync deploy). */
export const fileCardFutureSchema: TLSchema = createTLSchema({
  shapes: {
    ...defaultShapeSchemas,
    [FILE_CARD_TYPE]: {
      props: fileCardShapeProps,
      migrations: createShapePropsMigrationSequence({
        sequence: [
          ...fileCardShapeMigrations.sequence,
          { id: futureVersions.FromTheFuture, up: () => {}, down: () => {} },
        ],
      }),
    },
  },
  bindings: defaultBindingSchemas,
})

export const FILE_CARD_SEQUENCE = `com.tldraw.shape.${FILE_CARD_TYPE}`
