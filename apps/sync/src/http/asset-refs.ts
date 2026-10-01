// GET /internal/boards/:bid/asset-refs (the api's asset collector, apps/api/src/files/gc.ts): which
// uploaded file versions a board still references, on its canvas and in its "Recently deleted" capture.
// The route is room-internal/asset-refs.ts (the Excalidraw engine's); this module keeps the scan over
// tldraw-era records, which that route runs over a converted board's `lb_source` and `dr_deleted_*`.
//
// Two record kinds point at files (the same ones backup/asset-refs.ts records in the backup manifest):
// dr-file-card shapes (props.assetId + props.versionId) and tldraw image/video asset records whose
// props.src is the stable reference `/files/<ast>/<ver>/original`. The manifest keeps EVERY such asset
// record, because a restored backup must find every file it could show. The collector needs a
// narrower answer: tldraw 5.4.2 never deletes an asset record when its image or video shape is
// deleted, so an asset record counts here only while a shape uses it (props.assetId): a shape on the
// canvas ("canvas") or a shape the "Recently deleted" capture can still put back ("deleted"). Asset
// records no shape uses are listed apart ("unusedAssetRecords"), for the report, and keep nothing.

import { FILE_CARD_TYPE } from '@draftroom/canvas-schema'
import type { AssetRef } from '../backup/asset-refs.ts'

export type { AssetRef }

export interface BoardAssetRefs {
  boardId: string
  /** false: the board has no canvas storage (never opened), so it references nothing. */
  exists: boolean
  /** Versions a record on the canvas shows: file cards, and asset records a shape on the canvas uses. */
  canvas: AssetRef[]
  /** Versions a shape in "Recently deleted" would show again if it were restored. */
  deleted: AssetRef[]
  /** Versions only an asset record no shape uses points at (tldraw leaves these behind). */
  unusedAssetRecords: AssetRef[]
  /**
   * Bridge release R0: the board file also holds the new canvas's lb_* tables (converted at the cut-over),
   * which this build does not read, so `canvas` and `deleted` may miss files only the new canvas shows.
   * The api's collector then counts the board as not fully read (apps/api/src/files/gc.ts). Absent otherwise.
   */
  newCanvasTables?: true
}

const AST_RE = /^ast_[0-9A-Za-z]{10,40}$/
const VER_RE = /^ver_[0-9A-Za-z]{10,40}$/
const FILE_REF_RE = /^\/files\/(ast_[0-9A-Za-z]{10,40})\/(ver_[0-9A-Za-z]{10,40})\/original$/
/** tldraw asset record ids (TLAssetId): 'asset:' and a non-empty key. */
const ASSET_RECORD_ID_RE = /^asset:[\x21-\x7e]{1,200}$/

type Props = Record<string, unknown>
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
const keyOf = (r: AssetRef) => `${r.assetId}/${r.versionId}`

function sorted(refs: Map<string, AssetRef>): AssetRef[] {
  return [...refs.values()].sort((a, b) =>
    a.assetId === b.assetId ? a.versionId.localeCompare(b.versionId) : a.assetId.localeCompare(b.assetId),
  )
}

/** Collects one board's references from its canvas records and its captured deleted shapes. */
export class AssetRefScan {
  /** Asset record id -> the version its src names (canvas records only: the capture holds shapes). */
  private readonly assetRecords = new Map<string, AssetRef>()
  private readonly canvasCards = new Map<string, AssetRef>()
  private readonly deletedCards = new Map<string, AssetRef>()
  private readonly usedOnCanvas = new Set<string>()
  private readonly usedByDeleted = new Set<string>()

  /** A record on the board right now. */
  addCanvas(record: unknown): void {
    if (!isObject(record) || !isObject(record.props)) return
    if (record.typeName === 'asset') {
      const src = (record.props as Props).src
      const m = typeof src === 'string' ? FILE_REF_RE.exec(src) : null
      if (m?.[1] && m[2] && typeof record.id === 'string')
        this.assetRecords.set(record.id, { assetId: m[1], versionId: m[2] })
      return
    }
    if (record.typeName === 'shape') this.addShape(record, this.canvasCards, this.usedOnCanvas)
  }

  /** The stored JSON of a shape "Recently deleted" holds (not parsed unless it can name a file). */
  addDeleted(state: string): void {
    if (!state.includes('"assetId"')) return
    let record: unknown
    try {
      record = JSON.parse(state)
    } catch {
      return // a row we cannot read cannot be restored either
    }
    if (isObject(record) && record.typeName === 'shape' && isObject(record.props))
      this.addShape(record, this.deletedCards, this.usedByDeleted)
  }

  private addShape(record: Record<string, unknown>, cards: Map<string, AssetRef>, used: Set<string>) {
    const { assetId, versionId } = record.props as Props
    if (record.type === FILE_CARD_TYPE) {
      const ok =
        typeof assetId === 'string' &&
        typeof versionId === 'string' &&
        AST_RE.test(assetId) &&
        VER_RE.test(versionId)
      if (ok) cards.set(`${assetId}/${versionId}`, { assetId, versionId })
      return
    }
    // image, video (and any other shape that shows a tldraw asset record)
    if (typeof assetId === 'string' && ASSET_RECORD_ID_RE.test(assetId)) used.add(assetId)
  }

  result(boardId: string, exists: boolean): BoardAssetRefs {
    const canvas = new Map(this.canvasCards)
    const deleted = new Map(this.deletedCards)
    const unused = new Map<string, AssetRef>()
    for (const [recordId, ref] of this.assetRecords) {
      if (this.usedOnCanvas.has(recordId)) canvas.set(keyOf(ref), ref)
      if (this.usedByDeleted.has(recordId)) deleted.set(keyOf(ref), ref)
      if (!this.usedOnCanvas.has(recordId) && !this.usedByDeleted.has(recordId)) unused.set(keyOf(ref), ref)
    }
    // Two asset records can name one version: if any shape uses one of them, the version is not unused.
    for (const k of [...canvas.keys(), ...deleted.keys()]) unused.delete(k)
    return {
      boardId,
      exists,
      canvas: sorted(canvas),
      deleted: sorted(deleted),
      unusedAssetRecords: sorted(unused),
    }
  }
}
