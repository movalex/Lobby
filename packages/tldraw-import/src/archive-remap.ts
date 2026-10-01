import {
  AssetRecordType,
  createBindingId,
  createShapeId,
  type TLAsset,
  type TLBinding,
  type TLPageId,
  type TLParentId,
  type TLRecord,
  type TLShape,
} from '@tldraw/tlschema'
import { getIndicesAbove, type IndexKey, structuredClone } from '@tldraw/utils'
import { finiteOr, isRecordObject, isValidIndexKey } from './board-index.ts'

export interface RemapResult {
  records: TLRecord[]
  /** old id -> new id for every remapped shape, binding and (unless `keepAssets`) asset. */
  idMap: Map<string, string>
}

export interface RemapOptions {
  targetPageId: TLPageId
  /** Added to the position of every shape that ends up directly on `targetPageId` (children move with their parent). */
  offset?: { x: number; y: number }
  /** Keep asset records and `props.assetId` references unchanged (duplicating within the same board). */
  keepAssets?: boolean
  /** Top-level shapes get index keys above this one (pass the target page's current top index to paste on top). */
  indexAbove?: IndexKey
}

function byIndexThenInput(a: { index: string; order: number }, b: { index: string; order: number }): number {
  if (a.index < b.index) return -1
  if (a.index > b.index) return 1
  return a.order - b.order
}

/**
 * Copies records with fresh ids (duplicate, paste, import):
 * - every shape and binding gets a new id, and every asset too unless `keepAssets`;
 * - `parentId` is rewritten to the new parent id; shapes whose parent is not in `records` (page parents,
 *   missing parents, parent cycles) are re-parented to `targetPageId` and keep their x/y, which are
 *   then read as page coordinates;
 * - `offset` is applied to shapes placed directly on `targetPageId` only;
 * - image/video/bookmark `props.assetId` (`asset:` ids) follow the asset map (the `ast_` app ids of
 *   `dr-file-card` are file references, not record ids, and are never changed);
 * - bindings whose `fromId` or `toId` is not among the shapes are dropped; the rest point at the new ids;
 * - every sibling group gets fresh fractional index keys in the original order;
 * - records other than shapes, bindings and assets (pages, document, instance, camera, presence, users)
 *   are not emitted, records whose id does not start with `<typeName>:` are ignored, and repeated
 *   ids keep their first record.
 * Input records are never mutated. Applying `remapIds` to its own output again yields another
 * collision-free copy with the same structure.
 */
export function remapIds(records: TLRecord[], opts: RemapOptions): RemapResult {
  const { targetPageId } = opts
  if (typeof targetPageId !== 'string' || !targetPageId.startsWith('page:')) {
    throw new TypeError('remapIds: targetPageId must be a page id')
  }
  if (opts.indexAbove !== undefined && !isValidIndexKey(opts.indexAbove)) {
    throw new TypeError('remapIds: indexAbove is not a valid index key')
  }
  const dx = finiteOr(opts.offset?.x, 0)
  const dy = finiteOr(opts.offset?.y, 0)
  const keepAssets = opts.keepAssets === true

  const shapes = new Map<string, TLShape>()
  const bindings = new Map<string, TLBinding>()
  const assets = new Map<string, TLAsset>()
  for (const record of records) {
    if (!isRecordObject(record) || typeof record.id !== 'string') continue
    // The id's `<typeName>:` prefix must match: otherwise a (pasted, untrusted) shape wearing an
    // `asset:`/`binding:` id would share an idMap slot with that record and come out mistyped.
    if (typeof record.typeName !== 'string' || !record.id.startsWith(`${record.typeName}:`)) continue
    if (record.typeName === 'shape' && !shapes.has(record.id)) shapes.set(record.id, record as TLShape)
    else if (record.typeName === 'binding' && !bindings.has(record.id))
      bindings.set(record.id, record as TLBinding)
    else if (record.typeName === 'asset' && !assets.has(record.id)) assets.set(record.id, record as TLAsset)
  }

  const idMap = new Map<string, string>()
  for (const id of shapes.keys()) idMap.set(id, createShapeId())
  for (const id of bindings.keys()) idMap.set(id, createBindingId())
  if (!keepAssets) for (const id of assets.keys()) idMap.set(id, AssetRecordType.createId())

  // A parent is kept only when it is in the set and not part of a parent cycle.
  const keepsParent = new Map<string, boolean>()
  const resolveKeepsParent = (start: string): boolean => {
    const path: string[] = []
    const onPath = new Set<string>()
    let current = start
    while (!keepsParent.has(current)) {
      const parent: unknown = (shapes.get(current) as TLShape).parentId
      if (typeof parent !== 'string' || !shapes.has(parent)) {
        keepsParent.set(current, false) // top of the copied subtree (or an orphan): goes to the target page
        break
      }
      path.push(current)
      onPath.add(current)
      if (onPath.has(parent)) {
        keepsParent.set(parent, false) // parent cycle: break it here, that shape goes to the target page
        break
      }
      current = parent
    }
    for (const member of path) if (!keepsParent.has(member)) keepsParent.set(member, true)
    return keepsParent.get(start) as boolean
  }

  const out: TLRecord[] = []
  const siblings = new Map<string, { shape: Record<string, unknown>; index: string; order: number }[]>()
  let order = 0
  for (const [oldId, shape] of shapes) {
    const copy = structuredClone(shape) as unknown as Record<string, unknown>
    copy.id = idMap.get(oldId)
    const keep = resolveKeepsParent(oldId)
    const newParent = keep ? (idMap.get(shape.parentId) as TLParentId) : targetPageId
    copy.parentId = newParent
    if (!keep) {
      copy.x = finiteOr(shape.x, 0) + dx
      copy.y = finiteOr(shape.y, 0) + dy
    }
    const props = copy.props
    if (
      !keepAssets &&
      isRecordObject(props) &&
      typeof props.assetId === 'string' &&
      props.assetId.startsWith('asset:')
    ) {
      const mapped = idMap.get(props.assetId)
      if (mapped) props.assetId = mapped
    }
    const list = siblings.get(newParent)
    const entry = { shape: copy, index: typeof shape.index === 'string' ? shape.index : '', order: order++ }
    if (list) list.push(entry)
    else siblings.set(newParent, [entry])
    out.push(copy as unknown as TLRecord)
  }
  for (const [parent, list] of siblings) {
    list.sort(byIndexThenInput)
    const keys = getIndicesAbove(parent === targetPageId ? (opts.indexAbove ?? null) : null, list.length)
    list.forEach((entry, i) => {
      entry.shape.index = keys[i]
    })
  }

  for (const [oldId, binding] of bindings) {
    const from = idMap.get(binding.fromId)
    const to = idMap.get(binding.toId)
    if (!from || !to || !shapes.has(binding.fromId) || !shapes.has(binding.toId)) {
      idMap.delete(oldId)
      continue
    }
    const copy = structuredClone(binding) as unknown as Record<string, unknown>
    copy.id = idMap.get(oldId)
    copy.fromId = from
    copy.toId = to
    out.push(copy as unknown as TLRecord)
  }

  for (const [oldId, asset] of assets) {
    const copy = structuredClone(asset) as unknown as Record<string, unknown>
    if (!keepAssets) copy.id = idMap.get(oldId)
    out.push(copy as unknown as TLRecord)
  }

  return { records: out, idMap }
}
