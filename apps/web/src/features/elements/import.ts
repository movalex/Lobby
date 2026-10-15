// Wave Q (the integration): importing an `.excalidrawlib` into the Library tab. The file comes from an
// `<input type="file">` (never the File System Access picker), WS4's normaliser (canvas/library, a lazy chunk: the
// engine's pure library readers) turns it into an ImportLibraryInput, and the library client posts it (the api checks
// every item as a save). Lobby never fetches a library from anywhere: only the person's own file is read.
import type { ImportLibraryResponse, LibraryScope } from '@draftroom/contracts'
import type { LibraryRefusal, NormaliseLibraryResult } from '../../canvas/library/index.ts'
import { countUsage } from '../../lib/usage.ts'
import { importLibrary } from './client.ts'
import { libraryErrorText } from './LibraryDialogs.tsx'

/** What the file input accepts (the engine's library MIME type, its extension, plain JSON). */
export const LIBRARY_FILE_ACCEPT = '.excalidrawlib,application/vnd.excalidrawlib+json,application/json'

export type ImportOutcome =
  | { readonly ok: true; readonly created: number; readonly skipped: number; readonly text: string }
  | { readonly ok: false; readonly text: string }

/** Words for a file the normaliser refused. */
export function refusalText(code: LibraryRefusal): string {
  switch (code) {
    case 'too-large':
      return 'That file is too big to import (at most 5 MB).'
    case 'empty':
      return 'That library file holds no items.'
    case 'nothing-usable':
      return 'Nothing in that library file can go on a Lobby board.'
    default:
      return 'That isn’t an Excalidraw library file (.excalidrawlib).'
  }
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** The notice after an import: what was created, and what was left out. */
export function importedText(r: ImportLibraryResponse, skippedBefore: number, scope: LibraryScope): string {
  const where = scope === 'workspace' ? 'the workspace library' : 'your library'
  const skipped = r.skipped + skippedBefore
  const left = skipped ? ` ${plural(skipped, 'item')} could not be used.` : ''
  return `Imported ${plural(r.created, 'item')} to ${where}.${left}`
}

export interface ImportDeps {
  readonly normalise?: (
    file: File,
    opts: { scope: LibraryScope; folderId: string | null },
  ) => Promise<NormaliseLibraryResult>
  readonly post?: typeof importLibrary
}

/** Reads `file`, imports what it can into `scope` (and `folderId`), and says how it went. Never throws. */
export async function importLibraryFile(
  workspaceId: string,
  file: File,
  opts: { readonly scope: LibraryScope; readonly folderId: string | null },
  deps: ImportDeps = {},
): Promise<ImportOutcome> {
  let r: NormaliseLibraryResult
  try {
    const normalise = deps.normalise ?? (await import('../../canvas/library/index.ts')).normaliseExcalidrawLib
    r = await normalise(file, { scope: opts.scope, folderId: opts.folderId })
  } catch (e) {
    console.warn('elements: the library file could not be read', e)
    return { ok: false, text: refusalText('not-a-library') }
  }
  if (!r.ok) return { ok: false, text: refusalText(r.code) }
  try {
    const answer = await (deps.post ?? importLibrary)(workspaceId, r.input)
    countUsage('elements.import')
    return {
      ok: true,
      created: answer.created,
      skipped: answer.skipped + r.report.itemsSkipped,
      text: importedText(answer, r.report.itemsSkipped, opts.scope),
    }
  } catch (e) {
    return { ok: false, text: libraryErrorText(e) }
  }
}
