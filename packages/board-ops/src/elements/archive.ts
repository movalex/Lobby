/**
 * Board archive v2 (`.lobby.json`, docs/EXCALIDRAW-MIGRATION.md §3.7): a board on the new canvas as a
 * portable file, and its import, which also reads v1 (`draftroom-board`, tldraw records) through an
 * injected converter (packages/tldraw-import `convertBoard`, which board-ops does not depend on: the caller
 * that imports archives passes it in, §5.7).
 *
 *   { format: 'lobby-board', version: 2, engine: 'excalidraw', engineVersion: '0.18.0-1118751', schema,
 *     exportedAt, elements, doc, assets: ArchiveAssetRef[] }
 *
 * Export keeps live elements in paint order and leaves identities out of the file: `customData.lobbyServer`
 * (server-owned: authors, attribution, private-note authors), the registry's `strip` keys (`plusOne:*`,
 * `ai`, `privateFrame`) and the local-only `status`. The doc keeps what a client may write (`startView`,
 * `workshop`, `tagDef:*`), never the server's `import` record.
 *
 * Import treats the file as untrusted: a strict envelope, the v1 archive's JSON caps and prototype-key
 * checks (`../archive-common.ts`), every element through the server's own `checkElement` (the strict
 * per-type schema, byte limits, customData registry), the doc through the doc key registry, tags that must
 * be defined in the doc, then `remapElements` (fresh ids for every element and group, references remapped
 * or cut, indices above `indexAbove`), and a final cross-element check (`checkInvariants`). The server
 * re-validates everything again when the elements are pushed (files through file-refs, class rules).
 * Throws only `ArchiveError`; `warnings` say what was dropped or repaired (counts, never content).
 */
import { lobbyKeySpec, TAG_KEY_PREFIX } from '@draftroom/canvas-schema/custom-data'
import {
  docKeySpec,
  docValueProblem,
  MAX_DOC_TAG_DEFS,
  TAG_DEF_KEY_PREFIX,
} from '@draftroom/canvas-schema/doc'
import {
  checkElement,
  isElementType,
  REFUSED_ELEMENT_TYPES,
  type WireElement,
} from '@draftroom/canvas-schema/elements'
import { checkInvariants } from '@draftroom/canvas-schema/invariants'
import { ARCHIVE_MAX_ELEMENTS } from '@draftroom/canvas-schema/limits'
import { ELEMENT_SCHEMA_VERSION } from '@draftroom/canvas-schema/protocol'
import {
  ARCHIVE_LIMITS,
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
} from '../archive-common.ts'
import { elementFileRefs } from './files.ts'
import type { IdSource } from './ids.ts'
import { asElements, type BoardElement, compareByIndex, isLive } from './read.ts'
import { remapElements } from './remap.ts'

export const ARCHIVE_V2_FORMAT = 'lobby-board'
export const ARCHIVE_V2_VERSION = 2
export const ARCHIVE_ENGINE = 'excalidraw'
/** The pinned engine (`@excalidraw/*` in the pnpm catalog); elements.test.ts checks it against the install. */
export const ARCHIVE_ENGINE_VERSION = '0.18.0-1118751'

export interface BoardArchiveV2 {
  format: 'lobby-board'
  version: 2
  engine: 'excalidraw'
  engineVersion: string
  /** the element schema version (canvas-schema protocol.ts ELEMENT_SCHEMA_VERSION) */
  schema: number
  exportedAt: string
  elements: WireElement[]
  /** `lb_doc` keys a client may write: `startView`, `workshop`, `tagDef:<key>` */
  doc: Record<string, unknown>
  assets: ArchiveAssetRef[]
}

/**
 * The v2 import's caps: the v1 archive's, with `maxRecords` counting elements (the live element cap,
 * 40,000, canvas-schema limits.ts ARCHIVE_MAX_ELEMENTS) and room for strokes' point arrays.
 */
export const ELEMENT_ARCHIVE_LIMITS: Readonly<ArchiveLimits> = Object.freeze({
  ...ARCHIVE_LIMITS,
  maxRecords: ARCHIVE_MAX_ELEMENTS,
  maxNodes: 20_000_000,
  maxTotalChars: 128_000_000,
})

const ENVELOPE_KEYS = [
  'format',
  'version',
  'engine',
  'engineVersion',
  'schema',
  'exportedAt',
  'elements',
  'doc',
  'assets',
] as const

type El = Record<string, unknown>
const isObj = (v: unknown): v is El => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * An element as a portable file keeps it: no server-owned (`customData.lobbyServer`) or identity-bound data
 * (the registry's `strip` keys), no local-only `status`. `keepUnknown` (import) keeps keys the registry does
 * not know, so the element check refuses them instead of this dropping them unseen.
 */
export function portableElement(el: BoardElement, opts: { keepUnknown?: boolean } = {}): El {
  const c = structuredClone(el) as unknown as El
  delete c.status
  const cd = isObj(c.customData) ? c.customData : null
  if (cd) {
    const next: El = {}
    if (opts.keepUnknown)
      for (const [k, v] of Object.entries(cd)) if (k !== 'lobby' && k !== 'lobbyServer') next[k] = v
    const lobby: El = {}
    if (isObj(cd.lobby)) {
      for (const [k, v] of Object.entries(cd.lobby)) {
        const spec = lobbyKeySpec(k)
        if (spec ? spec.duplicate !== 'strip' : opts.keepUnknown) lobby[k] = v
      }
    } else if (opts.keepUnknown && cd.lobby !== undefined) next.lobby = cd.lobby
    if (Object.keys(lobby).length) next.lobby = lobby
    if (Object.keys(next).length) c.customData = next
    else delete c.customData
  }
  return c
}

/** The doc entries a client may write, valid by the doc key registry (the server's `import` is never exported). */
export function portableDoc(doc: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(doc).sort()) {
    const spec = docKeySpec(key)
    if (!spec || spec.writer === 'server') continue
    const value = doc[key]
    if (value !== null && docValueProblem(key, value) === null) out[key] = structuredClone(value)
  }
  return out
}

/**
 * The v2 archive of a board: its live elements in paint order (made portable, see `portableElement`), its
 * doc (`portableDoc`) and its file manifest. Throws `ArchiveError` (`invalid-asset-ref`) for a malformed
 * manifest entry.
 */
export function exportElementArchive(
  elements: Iterable<unknown>,
  doc: Readonly<Record<string, unknown>>,
  assets: readonly ArchiveAssetRef[],
  opts: { exportedAt?: Date } = {},
): BoardArchiveV2 {
  const seen = new Set<string>()
  const live: BoardElement[] = []
  for (const el of asElements(elements)) {
    if (!isLive(el) || seen.has(el.id)) continue
    seen.add(el.id)
    live.push(el)
  }
  live.sort(compareByIndex)
  return {
    format: ARCHIVE_V2_FORMAT,
    version: ARCHIVE_V2_VERSION,
    engine: ARCHIVE_ENGINE,
    engineVersion: ARCHIVE_ENGINE_VERSION,
    schema: ELEMENT_SCHEMA_VERSION,
    exportedAt: (opts.exportedAt ?? new Date()).toISOString(),
    elements: live.map((e) => portableElement(e)) as unknown as WireElement[],
    doc: portableDoc(doc),
    assets: assets.map((asset, i) => readAssetRef(asset, `assets[${i}]`)),
  }
}

// ---- import -------------------------------------------------------------------------------------------

export interface ImportElementArchiveOptions {
  /** Fresh indices go above this key (the target board's top index). */
  indexAbove?: string | null
  /** Added to every element's position. */
  offset?: { x: number; y: number }
  /** Override caps (defaults: ELEMENT_ARCHIVE_LIMITS; a v1 archive: the v1 archive's). */
  limits?: Partial<ArchiveLimits>
  /** Where new ids come from (tests). */
  newId?: IdSource
  now?: number
}

export interface ImportedElementArchive {
  /** fresh ids, paint order, indices above `indexAbove`; each passes the server's `checkElement` */
  elements: WireElement[]
  /** the doc entries to apply (`startView` with its frame remapped, `workshop`, `tagDef:*`) */
  doc: Record<string, unknown>
  assets: ArchiveAssetRef[]
  warnings: string[]
  /** which archive version was read */
  from: 1 | 2
  /** a v1 import's lossy codes (code → count), empty for v2 */
  lossy: Record<string, number>
  /** archive element id → new element id */
  idMap: Map<string, string>
}

/** The v1 archive's `format` (the tldraw archive, `../archive.ts`), recognised to point at the v1 reader. */
const V1_FORMAT = 'draftroom-board'

/**
 * Imports an untrusted v2 archive (already JSON-parsed). A v1 archive (`draftroom-board`) is
 * `unsupported-version` here: read it with `importAnyBoardArchive` (`@draftroom/board-ops/elements/v1`),
 * which carries the tldraw schema this module stays free of. Throws only `ArchiveError`.
 */
export function importElementArchive(
  input: unknown,
  opts: ImportElementArchiveOptions = {},
): ImportedElementArchive {
  try {
    if (!isPlainObject(input)) throw new ArchiveError('invalid-envelope', 'the archive must be a JSON object')
    const format = own(input, 'format')
    if (format === V1_FORMAT)
      throw new ArchiveError(
        'unsupported-version',
        'this archive was made on the old canvas and needs the converter',
        {
          path: 'format',
        },
      )
    if (format !== ARCHIVE_V2_FORMAT)
      throw new ArchiveError('wrong-format', 'not a Lobby board archive', { path: 'format' })
    return importV2(input, opts)
  } catch (error) {
    if (error instanceof ArchiveError) throw error
    throw new ArchiveError('invalid-input', 'the archive could not be read', { cause: error })
  }
}

function importV2(input: Record<string, unknown>, opts: ImportElementArchiveOptions): ImportedElementArchive {
  const limits = resolveLimits({ ...ELEMENT_ARCHIVE_LIMITS, ...definedOnly(opts.limits) })
  if (own(input, 'version') !== ARCHIVE_V2_VERSION)
    throw new ArchiveError('unsupported-version', 'unsupported archive version', { path: 'version' })
  for (const key of Object.keys(input)) {
    if (!(ENVELOPE_KEYS as readonly string[]).includes(key))
      throw new ArchiveError(
        FORBIDDEN_KEYS.has(key) ? 'forbidden-key' : 'invalid-envelope',
        `unexpected top-level key ${shortId(key)}`,
        { path: key },
      )
  }
  if (own(input, 'engine') !== ARCHIVE_ENGINE)
    throw new ArchiveError('invalid-envelope', 'the archive is not an Excalidraw board', { path: 'engine' })
  const engineVersion = own(input, 'engineVersion')
  if (typeof engineVersion !== 'string' || engineVersion.length > 64)
    throw new ArchiveError('invalid-envelope', 'engineVersion must be a short string', {
      path: 'engineVersion',
    })
  const schema = own(input, 'schema')
  if (typeof schema !== 'number' || !Number.isSafeInteger(schema) || schema < 1)
    throw new ArchiveError('invalid-schema', 'schema must be a positive integer', { path: 'schema' })
  if (schema > ELEMENT_SCHEMA_VERSION)
    throw new ArchiveError(
      'incompatible-schema',
      `the archive was written by a newer version (element schema ${schema} > ${ELEMENT_SCHEMA_VERSION})`,
      { path: 'schema' },
    )
  const exportedAt = own(input, 'exportedAt')
  if (typeof exportedAt !== 'string' || exportedAt.length > 64 || Number.isNaN(Date.parse(exportedAt)))
    throw new ArchiveError('invalid-envelope', 'exportedAt must be an ISO date string', {
      path: 'exportedAt',
    })
  const rawElements = own(input, 'elements')
  const rawAssets = own(input, 'assets')
  const rawDoc = own(input, 'doc')
  if (!Array.isArray(rawElements))
    throw new ArchiveError('invalid-envelope', 'elements must be an array', { path: 'elements' })
  if (!Array.isArray(rawAssets))
    throw new ArchiveError('invalid-envelope', 'assets must be an array', { path: 'assets' })
  if (!isPlainObject(rawDoc))
    throw new ArchiveError('invalid-envelope', 'doc must be an object', { path: 'doc' })
  if (rawElements.length > limits.maxRecords)
    throw new ArchiveError('too-large', `the archive has more than ${limits.maxRecords} elements`, {
      path: 'elements',
    })
  if (rawAssets.length > limits.maxAssets)
    throw new ArchiveError('too-large', `the archive lists more than ${limits.maxAssets} files`, {
      path: 'assets',
    })

  const copy = sanitizeJson(input, limits) as Record<string, unknown>
  const warnings: string[] = []
  if (engineVersion !== ARCHIVE_ENGINE_VERSION)
    warnings.push('The archive was made with another version of the canvas; it was checked against this one.')
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
  const out = importElements(
    copy.elements as unknown[],
    copy.doc as Record<string, unknown>,
    manifest,
    opts,
    warnings,
    'elements',
  )
  return { ...out, from: 2, lossy: {} }
}

/** Keeps the entries of a partial limits object that are set (a spread of `undefined` would unset a default). */
function definedOnly(limits: Partial<ArchiveLimits> | undefined): Partial<ArchiveLimits> {
  const out: Partial<ArchiveLimits> = {}
  if (!limits) return out
  for (const [k, v] of Object.entries(limits)) if (v !== undefined) (out as Record<string, unknown>)[k] = v
  return out
}

/**
 * The steps after the envelope, shared with the v1 reader (./archive-v1.ts): elements, doc, tags, files,
 * remap, final checks. `rawElements` and `rawDoc` must already be plain JSON (`sanitizeJson`).
 */
export function importElements(
  rawElements: readonly unknown[],
  rawDoc: Record<string, unknown>,
  manifest: ArchiveAssetRef[],
  opts: ImportElementArchiveOptions,
  warnings: string[],
  where: string,
): Omit<ImportedElementArchive, 'from' | 'lossy'> {
  // 1. elements: known types, unique ids, portable, each valid by the server's element check
  const ids = new Set<string>()
  const valid: El[] = []
  let deleted = 0
  rawElements.forEach((value, i) => {
    const path = `${where}[${i}]`
    if (!isObj(value)) throw new ArchiveError('invalid-record', 'element must be an object', { path })
    const { id, type } = value
    if (typeof id !== 'string' || typeof type !== 'string')
      throw new ArchiveError('invalid-record', 'element needs an id and a type', { path })
    if (ids.has(id)) throw new ArchiveError('duplicate-id', `duplicate element id ${shortId(id)}`, { path })
    ids.add(id)
    if ((REFUSED_ELEMENT_TYPES as readonly string[]).includes(type))
      throw new ArchiveError('forbidden-record-type', `${shortId(type)} elements cannot be imported`, {
        path,
      })
    if (!isElementType(type))
      throw new ArchiveError('unknown-shape-type', `unknown element type ${shortId(type)}`, { path })
    if (value.isDeleted === true) {
      deleted++
      return
    }
    const el = portableElement(value as unknown as BoardElement, { keepUnknown: true })
    // server-owned fields restart on import (remapElements), so their archived values are not checked
    Object.assign(el, { version: 1, versionNonce: 1, created: null, updated: 0 })
    const check = checkElement(el)
    if (!check.ok)
      throw new ArchiveError(
        check.code === 'TOO_LARGE' ? 'too-large' : 'invalid-record',
        `element ${shortId(id)} is invalid: ${check.detail.length > 300 ? `${check.detail.slice(0, 300)}…` : check.detail}`,
        { path },
      )
    valid.push(check.element as unknown as El)
  })
  if (deleted) warnings.push(`Left out ${deleted} deleted element(s).`)

  // 2. doc: what a client may write, valid per key
  const doc: Record<string, unknown> = {}
  let droppedDoc = 0
  let tagDefs = 0
  for (const key of Object.keys(rawDoc).sort()) {
    const value = rawDoc[key]
    const spec = docKeySpec(key)
    if (!spec || spec.writer === 'server' || value === null || docValueProblem(key, value) !== null) {
      droppedDoc++
      continue
    }
    if (key.startsWith(TAG_DEF_KEY_PREFIX) && ++tagDefs > MAX_DOC_TAG_DEFS) {
      droppedDoc++
      continue
    }
    doc[key] = value
  }
  if (droppedDoc) warnings.push(`Left out ${droppedDoc} board setting(s) that cannot be imported.`)

  // 3. tags must be defined on the board (the server's rule), files should be in the manifest
  let strippedTags = 0
  for (const el of valid) {
    const cd = isObj(el.customData) ? el.customData : null
    const lobby = cd && isObj(cd.lobby) ? cd.lobby : null
    if (!lobby) continue
    for (const k of Object.keys(lobby)) {
      if (!k.startsWith(TAG_KEY_PREFIX)) continue
      if (!Object.hasOwn(doc, `${TAG_DEF_KEY_PREFIX}${k.slice(TAG_KEY_PREFIX.length)}`)) {
        delete lobby[k]
        strippedTags++
      }
    }
    if (!Object.keys(lobby).length) delete el.customData
  }
  if (strippedTags) warnings.push(`Removed ${strippedTags} tag(s) the archive does not define.`)
  const listed = new Set(manifest.map((a) => a.versionId))
  const unlisted = elementFileRefs(valid).filter((f) => !listed.has(f.versionId))
  if (unlisted.length)
    warnings.push(`${unlisted.length} referenced file(s) are not listed in the archive manifest.`)

  // 4. fresh ids, references remapped or cut, indices above the target's top
  const remapped = remapElements(valid, {
    indexAbove: opts.indexAbove ?? null,
    offset: opts.offset,
    keepPresentIndex: true,
    newId: opts.newId,
    now: opts.now,
  })
  const { cut } = remapped
  const repaired = cut.labels + cut.bindings + cut.frames + cut.bound
  if (repaired) warnings.push(`Repaired ${repaired} reference(s) to elements missing from the archive.`)
  if (cut.customData) warnings.push(`Removed ${cut.customData} value(s) that cannot be copied.`)
  const sv = doc.startView
  if (isObj(sv) && typeof sv.frameId === 'string') {
    const f = remapped.idMap.get(sv.frameId)
    doc.startView = f ? { ...sv, frameId: f } : (({ frameId: _f, ...rest }) => rest)(sv)
  }

  // 5. the result is what the server accepts, element by element and across elements
  const elements: WireElement[] = []
  remapped.elements.forEach((el, i) => {
    const check = checkElement(el)
    if (!check.ok)
      throw new ArchiveError(
        'invalid-record',
        `imported element ${i} does not fit the canvas: ${check.detail}`,
        {
          path: `${where}[${i}]`,
        },
      )
    elements.push(check.element)
  })
  const violations = checkInvariants(elements)
  if (violations.length)
    throw new ArchiveError(
      'invalid-record',
      `the imported elements are inconsistent (${[...new Set(violations.map((v) => v.code))].join(', ')})`,
    )
  return { elements, doc, assets: manifest, warnings, idMap: remapped.idMap }
}
