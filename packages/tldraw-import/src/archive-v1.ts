import {
  type ArchiveAssetRef,
  ArchiveError,
  type ArchiveLimits,
  FORBIDDEN_KEYS,
  isPlainObject,
  own,
  readAssetRef,
  resolveLimits,
  sanitizeJson,
  shortId,
} from '@draftroom/board-ops/archive-common'
import { FILE_CARD_TYPE } from '@draftroom/canvas-schema'
import {
  defaultAssetSchemas,
  defaultBindingSchemas,
  defaultShapeSchemas,
  type TLArrowBinding,
  type TLPageId,
  type TLRecord,
  type TLSchema,
} from '@tldraw/tlschema'
import { structuredClone } from '@tldraw/utils'
import { remapIds } from './archive-remap.ts'
import { customShapeSchemas, draftroomSchema } from './schema.ts'

export {
  ARCHIVE_LIMITS,
  type ArchiveAssetRef,
  ArchiveError,
  type ArchiveErrorCode,
  type ArchiveLimits,
} from '@draftroom/board-ops/archive-common'
export { type RemapOptions, type RemapResult, remapIds } from './archive-remap.ts'

/** `@tldraw/store`'s `SerializedSchema` (V1 | V2), derived so board-ops needs no direct store dependency. */
export type SerializedSchema = Parameters<TLSchema['migratePersistedRecord']>[1]

export const ARCHIVE_FORMAT = 'draftroom-board'
export const ARCHIVE_VERSION = 1

export interface BoardArchiveV1 {
  format: 'draftroom-board'
  version: 1
  exportedAt: string
  schema: SerializedSchema
  records: TLRecord[]
  assets: ArchiveAssetRef[]
}

// ---------------------------------------------------------------------------------------------

const EXPORTED_TYPE_ORDER = ['page', 'asset', 'shape', 'binding'] as const
const KNOWN_SHAPE_TYPES = new Set(Object.keys({ ...defaultShapeSchemas, ...customShapeSchemas }))
const KNOWN_BINDING_TYPES = new Set(Object.keys(defaultBindingSchemas))
const KNOWN_ASSET_TYPES = new Set(Object.keys(defaultAssetSchemas))
/** Document-scope records that an import silently leaves out (board settings, user identities). */
const DROPPED_DOCUMENT_TYPES = new Set(['document', 'user'])
const ENVELOPE_KEYS = ['format', 'version', 'exportedAt', 'schema', 'records', 'assets'] as const

/** The only durable file reference allowed in image/video asset `src` (`stableFileRef` in M0-CONTRACTS §5). */
const STABLE_FILE_REF = /^\/files\/(ast_[0-9A-Za-z]{10,40})\/(ver_[0-9A-Za-z]{10,40})\/original$/
const HTTP_URL = /^https?:\/\/[^\s]+$/i
const SEQUENCE_ID = /^[A-Za-z0-9._-]{1,200}$/
const MAX_SEQUENCES = 1000

function copySchema(schema: SerializedSchema): SerializedSchema {
  return structuredClone(schema)
}

/**
 * Portable board export: the page, asset, shape and binding records (never `document`, `user`,
 * `instance*`, `camera`, `pointer` or presence records), in that type order, deep-copied; the schema
 * those records conform to; and the file manifest (bytes are not included yet). Note
 * `textLastEditedBy` (a collaborator's user id) is cleared in the copy. Throws `ArchiveError`
 * (`invalid-asset-ref`) for a malformed manifest entry. Note that `importBoardArchive` accepts at most
 * `ARCHIVE_LIMITS.maxRecords` records.
 */
export function exportBoardArchive(
  records: Iterable<TLRecord>,
  schema: SerializedSchema,
  assets: ArchiveAssetRef[],
): BoardArchiveV1 {
  const buckets = new Map<string, TLRecord[]>(EXPORTED_TYPE_ORDER.map((type) => [type, []]))
  for (const record of records) {
    if (typeof record !== 'object' || record === null) continue
    const bucket = buckets.get(record.typeName)
    if (!bucket) continue
    const copy = structuredClone(record)
    // Collaborator user ids stay out of portable files (the importer clears them anyway).
    if (copy.typeName === 'shape' && copy.type === 'note') copy.props.textLastEditedBy = null
    bucket.push(copy)
  }
  return {
    format: ARCHIVE_FORMAT,
    version: ARCHIVE_VERSION,
    exportedAt: new Date().toISOString(),
    schema: copySchema(schema),
    records: EXPORTED_TYPE_ORDER.flatMap((type) => buckets.get(type) ?? []),
    assets: assets.map((asset, i) => readAssetRef(asset, `assets[${i}]`)),
  }
}

// ---------------------------------------------------------------------------------------------

type SchemaV2 = { schemaVersion: 2; sequences: Record<string, number> }

function readSchema(value: unknown, warnings: string[]): SchemaV2 {
  if (!isPlainObject(value))
    throw new ArchiveError('invalid-schema', 'schema must be an object', { path: 'schema' })
  for (const key of Object.keys(value)) {
    if (key !== 'schemaVersion' && key !== 'sequences') {
      throw new ArchiveError('invalid-schema', `unexpected schema key ${shortId(key)}`, { path: 'schema' })
    }
  }
  if (own(value, 'schemaVersion') !== 2) {
    throw new ArchiveError('invalid-schema', 'only schemaVersion 2 schemas are supported', { path: 'schema' })
  }
  const sequences = own(value, 'sequences')
  if (!isPlainObject(sequences)) {
    throw new ArchiveError('invalid-schema', 'schema.sequences must be an object', {
      path: 'schema.sequences',
    })
  }
  const keys = Object.keys(sequences)
  if (keys.length > MAX_SEQUENCES) {
    throw new ArchiveError('invalid-schema', 'too many migration sequences', { path: 'schema.sequences' })
  }
  const current = draftroomSchema.serialize().sequences
  const out: Record<string, number> = {}
  const unknown: string[] = []
  for (const key of keys) {
    const version = own(sequences, key)
    if (
      !SEQUENCE_ID.test(key) ||
      typeof version !== 'number' ||
      !Number.isSafeInteger(version) ||
      version < 0
    ) {
      throw new ArchiveError('invalid-schema', `invalid migration sequence ${shortId(key)}`, {
        path: 'schema.sequences',
      })
    }
    if (!Object.hasOwn(current, key)) {
      // Unknown sequences cannot be migrated; their records (if any) fail the type checks below.
      unknown.push(key)
      continue
    }
    if (version > (current[key] as number)) {
      throw new ArchiveError(
        'incompatible-schema',
        `the archive was written by a newer version (${key} ${version} > ${current[key]})`,
        { path: 'schema.sequences' },
      )
    }
    out[key] = version
  }
  if (unknown.length > 0) {
    warnings.push(
      `Ignored ${unknown.length} unknown migration sequence(s): ${unknown.slice(0, 5).join(', ')}`,
    )
  }
  return { schemaVersion: 2, sequences: out }
}

function validateRecord(record: unknown, where: string): TLRecord {
  const typeName = (record as { typeName: string }).typeName
  const type = Object.hasOwn(draftroomSchema.types, typeName)
    ? (draftroomSchema.types as Record<string, { validate(r: unknown): unknown }>)[typeName]
    : undefined
  if (!type)
    throw new ArchiveError('unknown-record-type', `unknown record type ${shortId(typeName)}`, { path: where })
  try {
    return type.validate(record) as TLRecord
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'invalid'
    throw new ArchiveError(
      'invalid-record',
      `record ${shortId((record as { id?: unknown }).id)} is invalid: ${detail.length > 300 ? `${detail.slice(0, 300)}…` : detail}`,
      { path: where, cause: error },
    )
  }
}

function migrate(
  records: Record<string, unknown>[],
  schema: SchemaV2,
  whereOf: (record: Record<string, unknown>) => string,
): Record<string, unknown>[] {
  const migrations = draftroomSchema.getMigrationsSince(schema)
  if (!migrations.ok) {
    throw new ArchiveError('incompatible-schema', 'the archive schema cannot be migrated to this version', {
      path: 'schema',
    })
  }
  if (migrations.value.length === 0) return records
  if (migrations.value.every((migration) => migration.scope === 'record')) {
    return records.map((record) => {
      const result = draftroomSchema.migratePersistedRecord(record as unknown as TLRecord, schema, 'up')
      if (result.type !== 'success') {
        throw new ArchiveError('migration-failed', `record ${shortId(record.id)} could not be migrated`, {
          path: whereOf(record),
        })
      }
      return result.value as unknown as Record<string, unknown>
    })
  }
  // Store/storage-scoped migrations (older store versions) need the whole snapshot.
  const store: Record<string, TLRecord> = {}
  for (const record of records) store[record.id as string] = record as unknown as TLRecord
  const result = draftroomSchema.migrateStoreSnapshot({ store, schema } as Parameters<
    TLSchema['migrateStoreSnapshot']
  >[0])
  if (result.type !== 'success') {
    throw new ArchiveError('migration-failed', 'the archive could not be migrated to this version', {
      path: 'records',
    })
  }
  return Object.values(result.value) as unknown as Record<string, unknown>[]
}

export interface ImportBoardArchiveOptions {
  targetPageId: TLPageId
  /** Override individual caps (defaults: `ARCHIVE_LIMITS`); values that are not finite numbers >= 0 are ignored. */
  limits?: Partial<ArchiveLimits>
}

/**
 * Arrow bindings tldraw can actually hold: from an arrow shape (ArrowBindingUtil treats `fromId` as an
 * arrow), to an existing non-arrow shape (ArrowShapeUtil.canBind), and one binding per arrow terminal
 * (tldraw reads only the first). Dangling bindings are dropped here too so they are counted.
 */
function usableArrowBindings(records: TLRecord[]): { records: TLRecord[]; dropped: number } {
  const shapeTypes = new Map<string, string>()
  for (const record of records) if (record.typeName === 'shape') shapeTypes.set(record.id, record.type)
  const boundTerminals = new Set<string>()
  let dropped = 0
  const kept = records.filter((record) => {
    if (record.typeName !== 'binding' || record.type !== 'arrow') return true
    const binding = record as TLArrowBinding
    const terminal = `${binding.fromId}/${binding.props.terminal}`
    const usable =
      shapeTypes.get(binding.fromId) === 'arrow' &&
      shapeTypes.has(binding.toId) &&
      shapeTypes.get(binding.toId) !== 'arrow' &&
      !boundTerminals.has(terminal)
    if (!usable) {
      dropped++
      return false
    }
    boundTerminals.add(terminal)
    return true
  })
  return { records: kept, dropped }
}

/**
 * Imports an untrusted archive (already JSON-parsed) onto `targetPageId`:
 * 1. strict envelope (exactly `format`, `version`, `exportedAt`, `schema`, `records`, `assets`;
 *    `format: 'draftroom-board'`, `version: 1`), record/asset count caps, then a deep copy that enforces
 *    string/depth/value caps and rejects `__proto__` / `constructor` / `prototype` keys, accessors and
 *    non-JSON values;
 * 2. only `shape`, `binding`, `asset` records are imported; `page`, `document` and `user` records are
 *    dropped (with a warning); session/presence types are rejected; unknown shape, binding and asset
 *    types are rejected; ids must be unique;
 * 3. records are migrated from the archive's schema with `draftroomSchema` (older `dr-file-card`
 *    versions included) and every record is validated;
 * 4. policy: image/video asset `src` must be a stable `/files/ast_…/ver_…/original` reference (anything
 *    else, e.g. `data:` or hosted URLs, is cleared), bookmark asset URLs and embed shape URLs must be
 *    http(s) (tldraw only checks embed URLs are strings and uses them as the iframe src), note
 *    `textLastEditedBy` is cleared (authorship is not importable), shape references to assets missing
 *    from the archive are cleared, and arrow bindings tldraw cannot hold are dropped (source not an
 *    arrow, target missing or an arrow, or a second binding for the same arrow terminal);
 * 5. `remapIds` with fresh ids; shapes from every archive page, and orphans, land on `targetPageId`.
 * Throws only `ArchiveError` for bad input (and `TypeError` for an invalid `targetPageId`).
 */
export function importBoardArchive(
  input: unknown,
  opts: ImportBoardArchiveOptions,
): { records: TLRecord[]; assets: ArchiveAssetRef[]; warnings: string[] } {
  const { targetPageId } = opts
  if (typeof targetPageId !== 'string' || !targetPageId.startsWith('page:')) {
    throw new TypeError('importBoardArchive: targetPageId must be a page id')
  }
  const limits = resolveLimits(opts.limits)
  try {
    return importUnchecked(input, targetPageId, limits)
  } catch (error) {
    if (error instanceof ArchiveError) throw error
    throw new ArchiveError('invalid-input', 'the archive could not be read', { cause: error })
  }
}

function importUnchecked(
  input: unknown,
  targetPageId: TLPageId,
  limits: ArchiveLimits,
): { records: TLRecord[]; assets: ArchiveAssetRef[]; warnings: string[] } {
  const warnings: string[] = []

  // 1. Envelope (cheap checks on the raw input before copying anything).
  if (!isPlainObject(input)) throw new ArchiveError('invalid-envelope', 'the archive must be a JSON object')
  if (own(input, 'format') !== ARCHIVE_FORMAT) {
    throw new ArchiveError('wrong-format', 'not a Lobby board archive', { path: 'format' })
  }
  if (own(input, 'version') !== ARCHIVE_VERSION) {
    throw new ArchiveError('unsupported-version', 'unsupported archive version', { path: 'version' })
  }
  for (const key of Object.keys(input)) {
    if (!(ENVELOPE_KEYS as readonly string[]).includes(key)) {
      throw new ArchiveError(
        FORBIDDEN_KEYS.has(key) ? 'forbidden-key' : 'invalid-envelope',
        `unexpected top-level key ${shortId(key)}`,
        { path: key },
      )
    }
  }
  const rawRecords = own(input, 'records')
  const rawAssets = own(input, 'assets')
  const exportedAt = own(input, 'exportedAt')
  if (!Array.isArray(rawRecords))
    throw new ArchiveError('invalid-envelope', 'records must be an array', { path: 'records' })
  if (!Array.isArray(rawAssets))
    throw new ArchiveError('invalid-envelope', 'assets must be an array', { path: 'assets' })
  if (typeof exportedAt !== 'string' || exportedAt.length > 64 || Number.isNaN(Date.parse(exportedAt))) {
    throw new ArchiveError('invalid-envelope', 'exportedAt must be an ISO date string', {
      path: 'exportedAt',
    })
  }
  if (rawRecords.length > limits.maxRecords) {
    throw new ArchiveError('too-large', `the archive has more than ${limits.maxRecords} records`, {
      path: 'records',
    })
  }
  if (rawAssets.length > limits.maxAssets) {
    throw new ArchiveError('too-large', `the archive lists more than ${limits.maxAssets} files`, {
      path: 'assets',
    })
  }

  const copy = sanitizeJson(input, limits) as Record<string, unknown>
  const schema = readSchema(copy.schema, warnings)

  // Manifest.
  const manifest: ArchiveAssetRef[] = []
  const manifestKeys = new Set<string>()
  ;(copy.assets as unknown[]).forEach((value, i) => {
    const ref = readAssetRef(value, `assets[${i}]`)
    const key = `${ref.assetId}/${ref.versionId}`
    if (manifestKeys.has(key)) return
    manifestKeys.add(key)
    manifest.push(ref)
  })
  if (manifest.length < (copy.assets as unknown[]).length)
    warnings.push('Duplicate file references were merged.')

  // 2. Record types and ids.
  const kept: Record<string, unknown>[] = []
  const sourceIndex = new Map<string, number>()
  const whereOf = (record: Record<string, unknown>) => {
    const index = typeof record.id === 'string' ? sourceIndex.get(record.id) : undefined
    return index === undefined ? 'records' : `records[${index}]`
  }
  const ids = new Set<string>()
  let droppedDocumentRecords = 0
  ;(copy.records as unknown[]).forEach((value, i) => {
    const where = `records[${i}]`
    if (!isPlainObject(value))
      throw new ArchiveError('invalid-record', 'record must be an object', { path: where })
    const { typeName, id } = value
    if (typeof typeName !== 'string' || typeof id !== 'string' || !id.startsWith(`${typeName}:`)) {
      throw new ArchiveError('invalid-record', `record ${shortId(id)} needs a typeName and a matching id`, {
        path: where,
      })
    }
    if (ids.has(id))
      throw new ArchiveError('duplicate-id', `duplicate record id ${shortId(id)}`, { path: where })
    ids.add(id)
    const recordType = Object.hasOwn(draftroomSchema.types, typeName)
      ? (draftroomSchema.types as Record<string, { scope: string }>)[typeName]
      : undefined
    if (!recordType) {
      throw new ArchiveError('unknown-record-type', `unknown record type ${shortId(typeName)}`, {
        path: where,
      })
    }
    if (recordType.scope !== 'document') {
      throw new ArchiveError('forbidden-record-type', `${shortId(typeName)} records cannot be imported`, {
        path: where,
      })
    }
    // Pages are not emitted: their shapes are re-parented to targetPageId by remapIds.
    if (typeName === 'page') return
    if (DROPPED_DOCUMENT_TYPES.has(typeName)) {
      droppedDocumentRecords++
      return
    }
    const subtype = value.type
    if (typeName === 'shape' && (typeof subtype !== 'string' || !KNOWN_SHAPE_TYPES.has(subtype))) {
      throw new ArchiveError('unknown-shape-type', `unknown shape type ${shortId(subtype)}`, { path: where })
    }
    if (typeName === 'binding' && (typeof subtype !== 'string' || !KNOWN_BINDING_TYPES.has(subtype))) {
      throw new ArchiveError('unknown-record-type', `unknown binding type ${shortId(subtype)}`, {
        path: where,
      })
    }
    if (typeName === 'asset' && (typeof subtype !== 'string' || !KNOWN_ASSET_TYPES.has(subtype))) {
      throw new ArchiveError('unknown-record-type', `unknown asset type ${shortId(subtype)}`, { path: where })
    }
    kept.push(value)
    sourceIndex.set(id, i)
  })
  if (droppedDocumentRecords > 0) {
    warnings.push(`Left out ${droppedDocumentRecords} board-settings/user record(s).`)
  }

  // 3. Migrate, then validate every record.
  const migrated = migrate(kept, schema, whereOf)
  const valid = migrated.map((record) => validateRecord(record, whereOf(record)))

  // 4. Policy.
  const assetIds = new Set<string>()
  for (const record of valid) if (record.typeName === 'asset') assetIds.add(record.id)
  const shapeIds = new Set<string>()
  for (const record of valid) if (record.typeName === 'shape') shapeIds.add(record.id)
  let clearedSources = 0
  let clearedAssetRefs = 0
  let clearedEmbeds = 0
  let orphans = 0
  const unlistedFiles = new Set<string>()
  const noteFile = (ast: string, ver: string) => {
    if (!manifestKeys.has(`${ast}/${ver}`)) unlistedFiles.add(`${ast}/${ver}`)
  }
  const pagesSeen = new Set<string>() // pages that actually hold content
  const bindable = usableArrowBindings(valid)
  if (bindable.dropped > 0) {
    warnings.push(
      `Dropped ${bindable.dropped} arrow binding(s) that tldraw cannot use (missing or non-arrow source, missing or arrow target, or a terminal bound twice).`,
    )
  }
  const policed = bindable.records.map((record) => {
    const draft = structuredClone(record) as unknown as Record<string, unknown> & {
      props: Record<string, unknown>
    }
    if (record.typeName === 'asset') {
      const props = draft.props
      if (record.type === 'image' || record.type === 'video') {
        const src = props.src
        const match = typeof src === 'string' ? STABLE_FILE_REF.exec(src) : null
        if (match) noteFile(match[1] as string, match[2] as string)
        else if (src !== null && src !== '') {
          props.src = null
          clearedSources++
        }
      } else if (record.type === 'bookmark') {
        for (const key of ['src', 'image', 'favicon'] as const) {
          const value = props[key]
          if (typeof value === 'string' && value !== '' && !HTTP_URL.test(value)) {
            props[key] = key === 'src' ? null : ''
            clearedSources++
          }
        }
      }
    } else if (record.typeName === 'shape') {
      const props = draft.props
      if (record.type === 'note') props.textLastEditedBy = null
      // tldraw validates embed `url` only as a string, and renders unknown ones as the iframe src.
      if (
        record.type === 'embed' &&
        typeof props.url === 'string' &&
        props.url !== '' &&
        !HTTP_URL.test(props.url)
      ) {
        props.url = ''
        clearedEmbeds++
      }
      if (
        typeof props.assetId === 'string' &&
        props.assetId.startsWith('asset:') &&
        !assetIds.has(props.assetId)
      ) {
        props.assetId = null
        clearedAssetRefs++
      }
      if (record.type === FILE_CARD_TYPE) noteFile(String(props.assetId), String(props.versionId))
      const parent = record.parentId
      if (parent.startsWith('page:')) pagesSeen.add(parent)
      else if (!shapeIds.has(parent)) orphans++
    }
    return draft as unknown as TLRecord
  })
  if (clearedSources > 0)
    warnings.push(`Cleared ${clearedSources} file source(s) that were not stable Lobby file references.`)
  if (clearedAssetRefs > 0)
    warnings.push(`Cleared ${clearedAssetRefs} reference(s) to files missing from the archive.`)
  if (clearedEmbeds > 0) warnings.push(`Cleared ${clearedEmbeds} embed URL(s) that were not http(s).`)
  if (unlistedFiles.size > 0)
    warnings.push(`${unlistedFiles.size} referenced file(s) are not listed in the archive manifest.`)
  if (orphans > 0) warnings.push(`${orphans} shape(s) had a missing parent and were placed on the page.`)
  if (pagesSeen.size > 1)
    warnings.push(`The archive has ${pagesSeen.size} pages; all of their content was placed on one page.`)

  // 5. Fresh ids on the target page; re-validate what we produced.
  const { records } = remapIds(policed, { targetPageId })
  return {
    records: records.map((record, i) => validateRecord(record, `output[${i}]`)),
    assets: manifest,
    warnings,
  }
}

// the v1 archive read as elements of the new canvas (through the injected converter)
export * from './archive-v1-elements.ts'
