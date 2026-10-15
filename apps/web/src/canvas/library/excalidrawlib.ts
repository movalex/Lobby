// OWNER: WS4 (wave Q, kits and import; docs/WAVE-Q-CONTRACTS.md §6). Reading an `.excalidrawlib` into the body of
// POST /api/workspaces/:wid/library/import (ImportLibraryInput). This is the only place that reads a library file, and
// the only new `@excalidraw/*` importer of the wave: it uses three PURE exports of the pinned engine and nothing else:
//   loadLibraryFromBlob   reads the file (it checks `type` and `version` 1 or 2 and migrates v1 to items),
//   restoreLibraryItems   (inside it) and restoreElements (again, with repairBindings) bring old element shapes to
//                         the pinned engine's.
// Excalidraw's own library machinery stays unused: no `libraryItems` state, no `useHandleLibrary` (it reads
// `#addLibrary=` URLs and fetches from other origins), no sidebar, no File System Access picker. The file arrives
// through an `<input type=file>`; Lobby never fetches a library from libraries.excalidraw.com or any other origin.
//
// What the import does with what it reads (./normalise.ts has the per-item rules): pictures, embeds, iframes, foreign
// customData and links that are not allowed links are left out; fonts are mapped to the families Lobby serves; bound
// labels are laid out again; every item then passes board-ops serializeLibraryItem (canvas-schema checks, the item's
// limits). The result is an ImportLibraryInput the api validates again as a save, plus a report of counts for the
// dialog (never content). Images inside a library are skipped, not uploaded: see ./normalise.ts for why.
import {
  ImportLibraryInput,
  LIBRARY_DEFAULT_LICENCE,
  LIBRARY_LIMITS,
  type LibraryScope,
} from '@draftroom/contracts'
import type { WireElement } from '@draftroom/canvas-schema/elements'
import { type ItemCuts, type ItemResult, noCuts, normaliseLibraryItem } from './normalise.ts'

/** The three pure engine functions the import uses, so tests can stand in for the engine. */
export interface LibraryEngine {
  /** `loadLibraryFromBlob(blob, 'unpublished')`: the file's items, restored (v1 files become items) */
  loadLibraryFromBlob(blob: Blob): Promise<readonly { name?: unknown; elements: readonly unknown[] }[]>
  /** `restoreElements(elements, null, { repairBindings: true })` */
  restoreElements(elements: readonly unknown[]): readonly unknown[]
}

/** The pinned engine's pure functions (a lazy import: the board already loads this module's chunk). */
export async function loadLibraryEngine(): Promise<LibraryEngine> {
  const m = await import('@excalidraw/excalidraw')
  return {
    loadLibraryFromBlob: (blob) => m.loadLibraryFromBlob(blob, 'unpublished'),
    restoreElements: (elements) => m.restoreElements(elements as never, null, { repairBindings: true }),
  }
}

export type LibraryRefusal =
  /** over LIBRARY_LIMITS.importBytes */
  | 'too-large'
  /** not a JSON file of type excalidrawlib, version 1 or 2 (or an image, which the engine would read as a scene) */
  | 'not-a-library'
  /** the file is a library but holds no items */
  | 'empty'
  /** every item was left out */
  | 'nothing-usable'

export interface LibraryImportReport {
  /** items the file holds */
  itemsInFile: number
  /** items in the import body */
  itemsImported: number
  /** items left out: the cap, an item with nothing left, an item that fails the checks, the body cap */
  itemsSkipped: number
  /** why each skipped item was (item position, a code; at most LIBRARY_LIMITS.importWarnings) */
  skipped: { index: number; problem: string }[]
  /** items that held pictures (the pictures were left out) */
  itemsWithImages: number
  /** what was left out or changed, summed over the items */
  cuts: ItemCuts
  /** why elements failed canvas-schema's check: its own field-path wording, at most 10 distinct */
  invalidReasons: string[]
}

export type NormaliseLibraryResult =
  | { ok: true; input: ImportLibraryInput; report: LibraryImportReport; warnings: string[] }
  | { ok: false; code: LibraryRefusal }

export interface NormaliseLibraryOptions {
  scope: LibraryScope
  folderId?: string | null
  /** the licence note to store with each item; else the file's own `license`/`licence` string, else the default */
  licence?: string
  /** else the file's own `author` or its first author's name */
  author?: string
  /** default: the pinned engine (tests pass their own) */
  engine?: LibraryEngine
  /** the file's name, if `file` is a bare Blob */
  fileName?: string
  /** `updated` of the items' elements (tests) */
  now?: number
  /** the body's byte cap (default LIBRARY_LIMITS.importBytes; tests lower it) */
  maxBodyBytes?: number
}

const cap = (s: string, n: number) => [...s.trim()].slice(0, n).join('')

/** The file's own claims about itself: a licence note and an author, as short strings. Never trusted for anything else. */
function readMeta(text: string): { licence: string | null; author: string | null } {
  try {
    const j: unknown = JSON.parse(text)
    if (typeof j !== 'object' || j === null) return { licence: null, author: null }
    const o = j as Record<string, unknown>
    const licence = [o.licence, o.license].find((v): v is string => typeof v === 'string' && v.trim() !== '')
    const authors = Array.isArray(o.authors) ? o.authors : []
    const first = authors.find((a): a is Record<string, unknown> => typeof a === 'object' && a !== null)
    const author = [o.author, first?.name].find((v): v is string => typeof v === 'string' && v.trim() !== '')
    return {
      licence: licence ? cap(licence, LIBRARY_LIMITS.licenceChars) : null,
      author: author ? cap(author, LIBRARY_LIMITS.authorChars) : null,
    }
  } catch {
    return { licence: null, author: null }
  }
}

const ADD: readonly (keyof ItemCuts)[] = [
  'images',
  'embeds',
  'unknown',
  'links',
  'customData',
  'fonts',
  'relaid',
  'invalid',
  'deleted',
]

/** One line per kind of cut: its count key, and the sentence for one and for many (`{n}`). */
const CUT_LINES: readonly { key: keyof ItemCuts; one: string; many: string }[] = [
  {
    key: 'images',
    one: '1 picture was left out (a library file carries no pictures).',
    many: '{n} pictures were left out (a library file carries no pictures).',
  },
  { key: 'embeds', one: '1 embed was left out.', many: '{n} embeds were left out (embeds are not allowed).' },
  {
    key: 'unknown',
    one: '1 unsupported element was left out.',
    many: '{n} unsupported elements were left out.',
  },
  {
    key: 'links',
    one: '1 link was removed.',
    many: '{n} links were removed (only web and mail links are kept).',
  },
  {
    key: 'customData',
    one: '1 element lost its extra data.',
    many: '{n} elements lost their extra data.',
  },
  {
    key: 'invalid',
    one: '1 element was left out (it failed the checks).',
    many: '{n} elements were left out (they failed the checks).',
  },
  {
    key: 'fonts',
    one: '1 text was set in a font Lobby has.',
    many: '{n} texts were set in a font Lobby has.',
  },
]

/** The count lines the dialog shows (and the import's `warnings`): counts only, one line each, nothing of the content. */
function warningsOf(report: LibraryImportReport): string[] {
  const out: string[] = []
  if (report.itemsSkipped === 1)
    out.push('1 item was left out (nothing Lobby can hold in it, or over a limit).')
  else if (report.itemsSkipped > 1)
    out.push(`${report.itemsSkipped} items were left out (nothing Lobby can hold in them, or over a limit).`)
  for (const { key, one, many } of CUT_LINES) {
    const count = report.cuts[key]
    if (count) out.push(count === 1 ? one : many.replace('{n}', String(count)))
  }
  return out.slice(0, LIBRARY_LIMITS.importWarnings)
}

/**
 * An `.excalidrawlib` file as an import body. Never throws: an unreadable file is `{ ok: false, code }`. The engine's
 * parser reads it; each item is cleaned and checked (./normalise.ts); the body is checked against ImportLibraryInput
 * (the api's own schema) and the import's byte cap, dropping the last items when it is over.
 */
export async function normaliseExcalidrawLib(
  file: Blob & { name?: string },
  opts: NormaliseLibraryOptions,
): Promise<NormaliseLibraryResult> {
  if (file.size > LIBRARY_LIMITS.importBytes) return { ok: false, code: 'too-large' }
  // an image would be read by the engine as a scene (a PNG with an embedded scene): this is a JSON file only
  if (/^image\//.test(file.type)) return { ok: false, code: 'not-a-library' }
  let items: readonly { name?: unknown; elements: readonly unknown[] }[]
  let text = ''
  try {
    const engine = opts.engine ?? (await loadLibraryEngine())
    items = await engine.loadLibraryFromBlob(file)
    text = await file.text()
    // restore again with the bindings repaired (the engine's library restore does not repair them)
    items = items.map((it) => ({ name: it.name, elements: engine.restoreElements(it.elements) }))
  } catch {
    return { ok: false, code: 'not-a-library' }
  }
  if (!items.length) return { ok: false, code: 'empty' }

  const report: LibraryImportReport = {
    itemsInFile: items.length,
    itemsImported: 0,
    itemsSkipped: 0,
    skipped: [],
    itemsWithImages: 0,
    cuts: noCuts(),
    invalidReasons: [],
  }
  const skip = (index: number, problem: string) => {
    report.itemsSkipped++
    if (report.skipped.length < LIBRARY_LIMITS.importWarnings) report.skipped.push({ index, problem })
  }
  const made: { index: number; name: string; elements: WireElement[] }[] = []
  for (const [index, item] of items.entries()) {
    if (index >= LIBRARY_LIMITS.importItems) {
      skip(index, 'over-item-limit')
      continue
    }
    const r: ItemResult = normaliseLibraryItem(item, index, opts.now)
    for (const k of ADD) report.cuts[k] += r.cuts[k]
    if (r.cuts.images) report.itemsWithImages++
    for (const why of r.reasons)
      if (report.invalidReasons.length < 10 && !report.invalidReasons.includes(why))
        report.invalidReasons.push(why)
    if (r.ok) made.push({ index, name: r.name, elements: r.elements })
    else skip(index, r.problem)
  }
  if (!made.length) return { ok: false, code: 'nothing-usable' }

  const meta = readMeta(text)
  const fileName = (opts.fileName ?? file.name ?? '').replace(/^.*[\\/]/, '')
  const licence = opts.licence ? cap(opts.licence, LIBRARY_LIMITS.licenceChars) : null
  const author = opts.author ? cap(opts.author, LIBRARY_LIMITS.authorChars) : null
  // the body must fit the import's byte cap: leave the last items out until it does
  const encoder = new TextEncoder()
  let room = (opts.maxBodyBytes ?? LIBRARY_LIMITS.importBytes) - 4096
  let count = 0
  for (const m of made) {
    room -= encoder.encode(JSON.stringify({ name: m.name, elements: m.elements })).length + 1
    if (room < 0 && count > 0) break
    count++
  }
  const parsed = ImportLibraryInput.safeParse({
    scope: opts.scope,
    fileName: cap(fileName, LIBRARY_LIMITS.fileNameChars) || 'library.excalidrawlib',
    licence: licence ?? meta.licence ?? LIBRARY_DEFAULT_LICENCE,
    author: author ?? meta.author,
    folderId: opts.folderId ?? null,
    items: made.slice(0, count).map(({ name, elements }) => ({ name, elements })),
  })
  if (!parsed.success) return { ok: false, code: 'nothing-usable' }
  for (const dropped of made.slice(count)) skip(dropped.index, 'over-body-limit')
  report.itemsImported = count
  return { ok: true, input: parsed.data, report, warnings: warningsOf(report) }
}
