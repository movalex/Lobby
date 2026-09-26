// React-free: imported by BOTH apps/sync (server schema) and apps/web (ShapeUtil).
import {
  createShapePropsMigrationIds,
  createShapePropsMigrationSequence,
  type RecordProps,
  type TLShape,
} from '@tldraw/tlschema'
import { T } from '@tldraw/validate'

export const FILE_CARD_TYPE = 'dr-file-card' as const

const appId = (prefix: string) => {
  const re = new RegExp(`^${prefix}_[0-9A-Za-z]{10,40}$`)
  return T.string.check((v) => {
    if (!re.test(v)) throw new Error(`expected ${prefix}_... id`)
  })
}

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
