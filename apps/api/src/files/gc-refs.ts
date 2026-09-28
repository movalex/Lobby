// Which uploaded file versions a set of canvas records references, for the asset collector (gc.ts).
// The same rule as sync's GET /internal/boards/:bid/asset-refs (apps/sync/src/http/asset-refs.ts):
// a dr-file-card shape names its version itself; an image or video shows a tldraw asset record whose
// src is `/files/<ast>/<ver>/original`, and that record counts only while a shape of the same set uses
// it. tldraw 5.4.2 never deletes an asset record when its shape is deleted, so counting every asset
// record would keep every image and video ever placed, forever.

import { isId } from '@draftroom/dev-assets'

export interface VersionRef {
  assetId: string
  versionId: string
}

const FILE_REF_RE = /^\/files\/(ast_[0-9A-Za-z]{10,40})\/(ver_[0-9A-Za-z]{10,40})\/original$/
const FILE_CARD_TYPE = 'dr-file-card'

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

/** Distinct versions `records` reference, by the rule above (order: first seen). */
export function versionsInRecords(records: Iterable<unknown>): VersionRef[] {
  const out = new Map<string, VersionRef>()
  const assetRecords = new Map<string, VersionRef>()
  const used = new Set<string>()
  for (const r of records) {
    if (!isObject(r) || !isObject(r.props)) continue
    const props = r.props
    if (r.typeName === 'asset') {
      const m = typeof props.src === 'string' ? FILE_REF_RE.exec(props.src) : null
      if (m?.[1] && m[2] && typeof r.id === 'string')
        assetRecords.set(r.id, { assetId: m[1], versionId: m[2] })
    } else if (r.typeName === 'shape') {
      if (r.type === FILE_CARD_TYPE) {
        if (isId('ast', props.assetId) && isId('ver', props.versionId))
          out.set(props.versionId, { assetId: props.assetId, versionId: props.versionId })
      } else if (typeof props.assetId === 'string' && props.assetId.startsWith('asset:'))
        used.add(props.assetId)
    }
  }
  for (const [id, ref] of assetRecords) if (used.has(id)) out.set(ref.versionId, ref)
  return [...out.values()]
}

/** A checkpoint body (history's `draftroom-checkpoint` JSON): the versions its records reference. */
export function versionsInCheckpoint(raw: string): VersionRef[] {
  const body = JSON.parse(raw) as { documents?: unknown }
  const docs = Array.isArray(body?.documents) ? body.documents : []
  return versionsInRecords(docs.map((d) => (isObject(d) ? d.state : null)))
}

export interface BoardRefs {
  canvas: VersionRef[]
  deleted: VersionRef[]
}

const isRef = (v: unknown): v is VersionRef =>
  isObject(v) && isId('ast', v.assetId) && isId('ver', v.versionId)

/**
 * Sync's answer for `boardId`, or null when it is not one we can trust: the collector then counts the
 * board as unread and marks nothing new in that pass (it never guesses "no references").
 */
export function parseBoardRefs(value: unknown, boardId: string): BoardRefs | null {
  if (!isObject(value) || value.boardId !== boardId || typeof value.exists !== 'boolean') return null
  const { canvas, deleted } = value
  if (!Array.isArray(canvas) || !Array.isArray(deleted)) return null
  if (!canvas.every(isRef) || !deleted.every(isRef)) return null
  return { canvas, deleted }
}
