// OWNER: WS3 (wave Q, the Elements panel's Library tab; implemented against WS2's routes). The web side of the element
// library (@draftroom/contracts library.ts; docs/WAVE-Q-CONTRACTS.md §2).
//
// Frozen signatures (same origin, the session cookie, LOBBY_CLIENT_HEADER through the api client; every answer parsed
// with its contract schema; a 404 from an api without the routes, a refusal, an unreadable body or a network error is
// never thrown by the reads):
//   libraryAvailable(workspaceId?): boolean                                 whether the Library tab is offered at all
//   listLibrary(workspaceId, query): Promise<ListLibraryResponse>           a page of summaries; empty when unavailable
//   getLibraryItem(workspaceId, id): Promise<LibraryItem | null>            one item; null when unavailable or refused
//   listLibraryFolders(workspaceId, scope): Promise<LibraryFolder[]>        a scope's folders; [] when unavailable
//   listLibraryMarks(workspaceId): Promise<ListLibraryMarksResponse>        favourites and recents; empty when unavailable
//   putLibraryMark(workspaceId, input): Promise<LibraryMark | null>         star / stamp a use; null when it did not happen
// The writes reject with LibraryRequestError (`code`: 'unavailable', or the api's error code such as CREATOR_REQUIRED,
// LIBRARY_STALE_REVISION, LIBRARY_FULL, LIBRARY_TOO_LARGE) so the panel can say why:
//   saveLibraryItem(workspaceId, input): Promise<LibraryItemSummary>
//   patchLibraryItem(workspaceId, id, input): Promise<LibraryItemSummary>
//   deleteLibraryItem(workspaceId, id): Promise<void>
//   restoreLibraryItem(workspaceId, id): Promise<LibraryItemSummary>
//   importLibrary(workspaceId, input): Promise<ImportLibraryResponse>
//   createLibraryFolder(workspaceId, input) / patchLibraryFolder(workspaceId, fid, input): Promise<LibraryFolder>
//   deleteLibraryFolder(workspaceId, fid): Promise<void>
//   placeLibraryItem(boardId, id): Promise<PlaceLibraryItemResponse>        call BEFORE the elements are pushed
//   confirmLibraryPlace(boardId, id): Promise<void>                        AFTER their push succeeded: the links stay
//
// Downgrade: an api without the library (before WS2's routes, or a rollback) answers 404 to the list. That latches the
// library off for that workspace in this tab: libraryAvailable(workspaceId) turns false (the panel hides the Library
// tab, the save entries hide), later reads answer empty without a request and writes reject 'unavailable'. A 404 to
// one item, folder or place is that thing's own answer (gone, or not visible), never a latch. Nothing is logged;
// nothing is stored in the browser.
import {
  type CreateLibraryFolderInput,
  type CreateLibraryItemInput,
  type ImportLibraryInput,
  ImportLibraryResponse,
  LibraryFolder,
  LibraryItem,
  LibraryItemSummary,
  LibraryMark,
  type LibraryScope,
  ListLibraryFoldersResponse,
  ListLibraryMarksResponse,
  type ListLibraryQuery,
  ListLibraryResponse,
  libraryFolderPath,
  libraryFoldersPath,
  libraryImportPath,
  libraryItemPath,
  libraryItemsPath,
  libraryListPath,
  libraryMarksPath,
  libraryPlaceConfirmPath,
  libraryPlacePath,
  libraryRestorePath,
  type PatchLibraryFolderInput,
  type PatchLibraryItemInput,
  PlaceLibraryItemResponse,
  type PutLibraryMarkInput,
} from '@draftroom/contracts'
import type { z } from 'zod'
import { type ApiClient, api as defaultApi, isApiError } from '../../api/client.ts'

/** A library write that did not happen: 'unavailable' (no api routes, offline) or the api's error code. */
export class LibraryRequestError extends Error {
  readonly code: string
  readonly status: number | null
  constructor(code: string, status: number | null = null) {
    super(`library request failed: ${code}`)
    this.name = 'LibraryRequestError'
    this.code = code
    this.status = status
  }
}

type Requester = Pick<ApiClient, 'request'>
type Method = Parameters<ApiClient['request']>[0]

let requester: Requester | null = null
/** The api client the library uses (tests pass a fake; null: the page's own). */
export function setLibraryRequester(r: Requester | null): void {
  requester = r
}
const client = (): Requester => requester ?? defaultApi

/** Workspaces whose library list answered 404 in this tab (the api has no library for them). */
const missing = new Set<string>()
const listeners = new Set<() => void>()

/** fn runs when a workspace is found to have no library (re-read libraryAvailable then). */
export function subscribeLibrary(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

function latch(workspaceId: string): void {
  if (missing.has(workspaceId)) return
  missing.add(workspaceId)
  for (const fn of [...listeners]) {
    try {
      fn()
    } catch {
      // a listener's failure is its own
    }
  }
}

/** Tests: forget every latch. */
export function resetLibraryClient(): void {
  missing.clear()
}

/** Whether the library is offered (no list of this workspace, or any if none is named, answered 404 in this tab). */
export function libraryAvailable(workspaceId?: string): boolean {
  return workspaceId === undefined ? missing.size === 0 : !missing.has(workspaceId)
}

const call = <S extends z.ZodType | null>(method: Method, path: string, schema: S, body?: unknown) =>
  client().request(method, path, body === undefined ? { schema } : { schema, body })

/** A read: its answer, or `fallback` for any failure (a 404 to the list latches the workspace off). */
async function read<T>(workspaceId: string, fallback: T, run: () => Promise<T>, latches = false): Promise<T> {
  if (missing.has(workspaceId)) return fallback
  try {
    return await run()
  } catch (e) {
    if (latches && isApiError(e) && e.status === 404) latch(workspaceId)
    return fallback
  }
}

/** A write: its answer, or a LibraryRequestError with the api's code. */
async function write<T>(workspaceId: string | null, run: () => Promise<T>): Promise<T> {
  if (workspaceId !== null && missing.has(workspaceId)) throw new LibraryRequestError('unavailable')
  try {
    return await run()
  } catch (e) {
    if (isApiError(e)) {
      if (e.kind === 'network') throw new LibraryRequestError('unavailable', null)
      throw new LibraryRequestError(e.code, e.status)
    }
    throw new LibraryRequestError('unavailable')
  }
}

export function listLibrary(
  workspaceId: string,
  query: Partial<ListLibraryQuery> = {},
): Promise<ListLibraryResponse> {
  return read(
    workspaceId,
    { items: [], nextCursor: null },
    () => call('GET', libraryListPath(workspaceId, query), ListLibraryResponse),
    true,
  )
}

export function getLibraryItem(workspaceId: string, id: string): Promise<LibraryItem | null> {
  return read<LibraryItem | null>(workspaceId, null, () =>
    call('GET', libraryItemPath(workspaceId, id), LibraryItem),
  )
}

export function listLibraryFolders(workspaceId: string, scope: LibraryScope): Promise<LibraryFolder[]> {
  return read<LibraryFolder[]>(workspaceId, [], async () => {
    const r = await call('GET', libraryFoldersPath(workspaceId, scope), ListLibraryFoldersResponse)
    return r.folders
  })
}

export function listLibraryMarks(workspaceId: string): Promise<ListLibraryMarksResponse> {
  return read(workspaceId, { favourites: [], recents: [] }, () =>
    call('GET', libraryMarksPath(workspaceId), ListLibraryMarksResponse),
  )
}

export function putLibraryMark(workspaceId: string, input: PutLibraryMarkInput): Promise<LibraryMark | null> {
  return read<LibraryMark | null>(workspaceId, null, () =>
    call('PUT', libraryMarksPath(workspaceId), LibraryMark, input),
  )
}

export function saveLibraryItem(
  workspaceId: string,
  input: CreateLibraryItemInput,
): Promise<LibraryItemSummary> {
  return write(workspaceId, () => call('POST', libraryItemsPath(workspaceId), LibraryItemSummary, input))
}

export function patchLibraryItem(
  workspaceId: string,
  id: string,
  input: PatchLibraryItemInput,
): Promise<LibraryItemSummary> {
  return write(workspaceId, () => call('PATCH', libraryItemPath(workspaceId, id), LibraryItemSummary, input))
}

export function deleteLibraryItem(workspaceId: string, id: string): Promise<void> {
  return write(workspaceId, async () => {
    await call('DELETE', libraryItemPath(workspaceId, id), null)
  })
}

export function restoreLibraryItem(workspaceId: string, id: string): Promise<LibraryItemSummary> {
  return write(workspaceId, () => call('POST', libraryRestorePath(workspaceId, id), LibraryItemSummary))
}

export function importLibrary(
  workspaceId: string,
  input: ImportLibraryInput,
): Promise<ImportLibraryResponse> {
  return write(workspaceId, () => call('POST', libraryImportPath(workspaceId), ImportLibraryResponse, input))
}

export function createLibraryFolder(
  workspaceId: string,
  input: CreateLibraryFolderInput,
): Promise<LibraryFolder> {
  return write(workspaceId, () => call('POST', libraryFoldersPath(workspaceId), LibraryFolder, input))
}

export function patchLibraryFolder(
  workspaceId: string,
  fid: string,
  input: PatchLibraryFolderInput,
): Promise<LibraryFolder> {
  return write(workspaceId, () => call('PATCH', libraryFolderPath(workspaceId, fid), LibraryFolder, input))
}

export function deleteLibraryFolder(workspaceId: string, fid: string): Promise<void> {
  return write(workspaceId, async () => {
    await call('DELETE', libraryFolderPath(workspaceId, fid), null)
  })
}

export function placeLibraryItem(boardId: string, id: string): Promise<PlaceLibraryItemResponse> {
  return write(null, () => call('POST', libraryPlacePath(boardId, id), PlaceLibraryItemResponse))
}

/**
 * Review fix (docs/WAVE-Q-CONTRACTS.md §9): the push of a place's elements succeeded, so the file links that place
 * made on the board stay (unconfirmed ones are swept after an hour, unless the board shows them by then).
 */
export function confirmLibraryPlace(boardId: string, id: string): Promise<void> {
  return write(null, async () => {
    await call('POST', libraryPlaceConfirmPath(boardId, id), null)
  })
}
