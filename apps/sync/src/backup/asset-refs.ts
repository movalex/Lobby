// The uploaded files a board references, recorded with every backup (build plan §7: "keep Postgres
// backups and canvas backups coordinated enough to resolve board IDs and asset references"). The bytes
// live in the blob store under assets/<ast>/<ver>/..., and their rows in Postgres: a board restored
// from a backup needs exactly these versions to still exist.
//
// Two record kinds point at files: file-card shapes (props.assetId + props.versionId) and tldraw
// image/video asset records whose props.src is the stable reference `/files/<ast>/<ver>/original`
// (PDF page images keep their PDF version's reference there too).

import { FILE_CARD_TYPE } from '@draftroom/canvas-schema'

export interface AssetRef {
  assetId: string
  versionId: string
}

const AST_RE = /^ast_[0-9A-Za-z]{10,40}$/
const VER_RE = /^ver_[0-9A-Za-z]{10,40}$/
const FILE_REF_RE = /^\/files\/(ast_[0-9A-Za-z]{10,40})\/(ver_[0-9A-Za-z]{10,40})\/original$/
// Every record that references a file contains this; the rest are skipped without parsing.
const MARKER = Buffer.from('ast_')

function refOf(record: unknown): AssetRef | null {
  if (!record || typeof record !== 'object') return null
  const r = record as { typeName?: unknown; type?: unknown; props?: Record<string, unknown> }
  const props = r.props
  if (!props || typeof props !== 'object') return null
  if (r.typeName === 'shape' && r.type === FILE_CARD_TYPE) {
    const { assetId, versionId } = props
    const ok =
      typeof assetId === 'string' &&
      typeof versionId === 'string' &&
      AST_RE.test(assetId) &&
      VER_RE.test(versionId)
    return ok ? { assetId, versionId } : null
  }
  if (r.typeName === 'asset' && typeof props.src === 'string') {
    const m = FILE_REF_RE.exec(props.src)
    if (m?.[1] && m[2]) return { assetId: m[1], versionId: m[2] }
  }
  return null
}

/** Collects the distinct asset versions referenced by stored records (the raw `state` bytes). */
export class AssetRefCollector {
  private readonly refs = new Map<string, AssetRef>()

  add(state: Uint8Array): void {
    const bytes = Buffer.from(state.buffer, state.byteOffset, state.byteLength)
    if (bytes.indexOf(MARKER) === -1) return
    let record: unknown
    try {
      record = JSON.parse(bytes.toString('utf8'))
    } catch {
      return // not ours to judge here: the integrity check and the drill look at the records
    }
    const ref = refOf(record)
    if (ref) this.refs.set(`${ref.assetId}/${ref.versionId}`, ref)
  }

  /** Sorted by asset id, then version id. */
  list(): AssetRef[] {
    return [...this.refs.values()].sort((a, b) =>
      a.assetId === b.assetId ? a.versionId.localeCompare(b.versionId) : a.assetId.localeCompare(b.assetId),
    )
  }
}

/** Keeps only well-formed refs (for manifests read back from disk or the store). */
export function cleanAssetRefs(value: unknown): AssetRef[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter(
    (r): r is AssetRef =>
      !!r &&
      typeof r === 'object' &&
      typeof (r as AssetRef).assetId === 'string' &&
      typeof (r as AssetRef).versionId === 'string' &&
      AST_RE.test((r as AssetRef).assetId) &&
      VER_RE.test((r as AssetRef).versionId),
  )
}
