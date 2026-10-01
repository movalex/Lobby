// Lobby's file card as the tldraw era stored it: its shape type, read wherever a tldraw-era record is
// still read (the converter, the api's v1 readers, the sync's asset-ref scan over `lb_source`). The
// tldraw schema of the shape (props validators, migrations) is packages/tldraw-import/src/schema.ts.
export const FILE_CARD_TYPE = 'dr-file-card' as const

/** The tldraw-era file card's props, as stored (the converter maps them to an image element's facts). */
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
