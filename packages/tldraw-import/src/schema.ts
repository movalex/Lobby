/**
 * The tldraw era's one server schema (tldraw 5.4.2's defaults plus Lobby's file-card shape with its
 * migration), as every board file written before the cut-over stores it. The converter migrates stored
 * records up to it (./migrate.ts) and the v1 archive reader validates against it (./archive-v1.ts). Until
 * wave 4 part 2 this lived in packages/canvas-schema; it is tldraw code, so it lives here now (D13).
 */
import { FILE_CARD_TYPE } from '@draftroom/canvas-schema'
import {
  createShapePropsMigrationIds,
  createShapePropsMigrationSequence,
  createTLSchema,
  defaultBindingSchemas,
  defaultShapeSchemas,
  type RecordProps,
  type TLShape,
} from '@tldraw/tlschema'
import { T } from '@tldraw/validate'

export { FILE_CARD_TYPE }

const appId = (prefix: string) => {
  const re = new RegExp(`^${prefix}_[0-9A-Za-z]{10,40}$`)
  return T.string.check((v) => {
    if (!re.test(v)) throw new Error(`expected ${prefix}_... id`)
  })
}

/** The file card's props as the tldraw page stored them (canvas-schema's FileCardShapeProps, typed for tldraw). */
export interface FileCardShapeProps {
  w: number
  h: number
  assetId: string // app id (ast_...), never a URL
  versionId: string // immutable version id (ver_...)
  kind: 'image' | 'pdf' | 'video' | 'other'
  name: string
  mimeType: string
  sizeBytes: number
  status: 'queued' | 'processing' | 'ready' | 'failed' // display hint; the API is authoritative
  pageCount: number | null
  durationMs: number | null
  posterDerivativeId: string | null // drv_... (added by migration 1)
}

declare module '@tldraw/tlschema' {
  interface TLGlobalShapePropsMap {
    [FILE_CARD_TYPE]: FileCardShapeProps
  }
}

export type FileCardShape = TLShape<typeof FILE_CARD_TYPE>

export const fileCardShapeProps: RecordProps<FileCardShape> = {
  w: T.nonZeroNumber,
  h: T.nonZeroNumber,
  assetId: appId('ast'),
  versionId: appId('ver'),
  kind: T.literalEnum('image', 'pdf', 'video', 'other'),
  name: T.string,
  mimeType: T.string,
  sizeBytes: T.positiveInteger,
  status: T.literalEnum('queued', 'processing', 'ready', 'failed'),
  pageCount: T.nullable(T.positiveInteger),
  durationMs: T.nullable(T.positiveInteger),
  posterDerivativeId: T.nullable(appId('drv')),
}

export const fileCardVersions = createShapePropsMigrationIds(FILE_CARD_TYPE, {
  AddPosterDerivativeId: 1,
})

// Append-only. Never edit or remove a shipped entry; always give record-scoped `down`.
export const fileCardShapeMigrations = createShapePropsMigrationSequence({
  sequence: [
    {
      id: fileCardVersions.AddPosterDerivativeId,
      up(props: Record<string, unknown>) {
        props.posterDerivativeId = null
      },
      down(props: Record<string, unknown>) {
        delete props.posterDerivativeId
      },
    },
  ],
})

export const customShapeSchemas = {
  [FILE_CARD_TYPE]: { props: fileCardShapeProps, migrations: fileCardShapeMigrations },
}

/** The ONE tldraw-era server schema (the client of that era built the identical schema from its shape utils). */
export const draftroomSchema = createTLSchema({
  shapes: { ...defaultShapeSchemas, ...customShapeSchemas },
  bindings: defaultBindingSchemas,
})
