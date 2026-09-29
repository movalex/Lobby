/**
 * Archive import for the new canvas that also reads v1 archives (`draftroom-board`, tldraw 5.4.2 records;
 * docs/EXCALIDRAW-MIGRATION.md §3.7 "Import accepts v2 natively, and v1 through packages/tldraw-import").
 *
 * Its own subpath (`@draftroom/board-ops/elements/v1`) because a v1 archive is read with the tldraw schema
 * (`../archive.ts`: envelope, caps, schema migration, record validation, file policy), which the element
 * readers (`@draftroom/board-ops/elements`) never load. The converter itself is injected: board-ops does
 * not depend on packages/tldraw-import (§5.7: it is apps/sync's and apps/api's), so the api passes
 * `(records) => convertBoard(records, { updatedAt, metrics })`.
 *
 * A v1 archive: `importBoardArchive` (every v1 check, fresh tldraw ids, one page), the converter (the
 * board's pages flattened as the conversion does), then the same element steps as a v2 archive
 * (`importElements`: server element check, doc keys, tags, remap with fresh ids, invariants). A v2 archive
 * goes to `importElementArchive`.
 */
import { TAG_DEF_KEY_PREFIX } from '@draftroom/canvas-schema/doc'
import { ARCHIVE_FORMAT, ARCHIVE_VERSION, importBoardArchive } from '../archive.ts'
import { ArchiveError, isPlainObject, own, sanitizeJson } from '../archive-common.ts'
import {
  ELEMENT_ARCHIVE_LIMITS,
  type ImportElementArchiveOptions,
  type ImportedElementArchive,
  importElementArchive,
  importElements,
} from './archive.ts'

/** What a v1 archive's records become: the shape of packages/tldraw-import `convertBoard`'s result. */
export interface V1Conversion {
  readonly elements: readonly unknown[]
  readonly doc?: {
    readonly startView?: unknown
    readonly workshop?: unknown
    readonly tagDefs?: Readonly<Record<string, unknown>>
  }
  readonly lossy?: readonly { readonly code: string; readonly id: string }[]
  readonly failures?: readonly { readonly id: string; readonly code: string; readonly detail: string }[]
}

/** The v1 converter the caller passes in, e.g. `(records) => convertBoard(records, {updatedAt, metrics})`. */
export type V1Converter = (records: readonly Record<string, unknown>[]) => V1Conversion

export interface ImportAnyBoardArchiveOptions extends ImportElementArchiveOptions {
  /** Converts a v1 archive's records; without it a v1 archive is `unsupported-version`. */
  convertV1?: V1Converter
}

/** Imports an untrusted archive of either version (already JSON-parsed). Throws only `ArchiveError`. */
export function importAnyBoardArchive(
  input: unknown,
  opts: ImportAnyBoardArchiveOptions = {},
): ImportedElementArchive {
  if (!isPlainObject(input) || own(input, 'format') !== ARCHIVE_FORMAT)
    return importElementArchive(input, opts)
  try {
    return importV1(input, opts)
  } catch (error) {
    if (error instanceof ArchiveError) throw error
    throw new ArchiveError('invalid-input', 'the archive could not be read', { cause: error })
  }
}

function importV1(
  input: Record<string, unknown>,
  opts: ImportAnyBoardArchiveOptions,
): ImportedElementArchive {
  if (own(input, 'version') !== ARCHIVE_VERSION)
    throw new ArchiveError('unsupported-version', 'unsupported archive version', { path: 'version' })
  if (!opts.convertV1)
    throw new ArchiveError(
      'unsupported-version',
      'this archive was made on the old canvas and needs the converter',
      {
        path: 'version',
      },
    )
  const v1 = importBoardArchive(input, { targetPageId: 'page:import' as never, limits: opts.limits })
  const conv = opts.convertV1(v1.records as unknown as Record<string, unknown>[])
  if (conv.failures?.length)
    throw new ArchiveError(
      'invalid-record',
      `${conv.failures.length} shape(s) could not be converted for the new canvas (${[
        ...new Set(conv.failures.map((f) => f.code)),
      ].join(', ')})`,
    )
  const doc: Record<string, unknown> = {}
  if (conv.doc?.startView !== undefined) doc.startView = conv.doc.startView
  if (conv.doc?.workshop !== undefined) doc.workshop = conv.doc.workshop
  for (const [k, v] of Object.entries(conv.doc?.tagDefs ?? {})) doc[`${TAG_DEF_KEY_PREFIX}${k}`] = v
  const lossy: Record<string, number> = {}
  for (const l of conv.lossy ?? []) lossy[l.code] = (lossy[l.code] ?? 0) + 1
  const warnings = [...v1.warnings]
  const lost = Object.entries(lossy)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([code, n]) => `${code} ${n}`)
  if (lost.length)
    warnings.push(`Converted from the old canvas; not everything carries over: ${lost.join(', ')}.`)
  // the converter's output is ours, not the file's, but it goes through the same caps and checks (as JSON)
  const json = JSON.parse(JSON.stringify({ elements: conv.elements, doc })) as unknown
  const plain = sanitizeJson(json, ELEMENT_ARCHIVE_LIMITS) as {
    elements: unknown[]
    doc: Record<string, unknown>
  }
  const out = importElements(plain.elements, plain.doc, v1.assets, opts, warnings, 'elements')
  return { ...out, from: 1, lossy }
}
