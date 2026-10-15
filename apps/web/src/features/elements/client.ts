// OWNER: WS3 (wave Q, the Elements panel's Library tab; a stub landed by the wave Q foundation, implemented against WS2's
// routes). The web side of the element library (@draftroom/contracts library.ts; docs/WAVE-Q-CONTRACTS.md §2).
//
// Frozen signatures (same origin, the session cookie, LOBBY_CLIENT_HEADER; every answer parsed with its contract schema;
// a 404 from an api without the routes, a refusal, an unreadable body or a network error is never thrown by the reads):
//   libraryAvailable(): boolean                                             whether the Library tab is offered at all
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
//
// The stub: libraryAvailable() is false, every read answers empty without a request and every write rejects
// 'unavailable', so the board page is unchanged until WS3 lands the client (the routes are pending on the api: 404).
// Nothing is logged; nothing is stored in the browser.
import type {
  CreateLibraryFolderInput,
  CreateLibraryItemInput,
  ImportLibraryInput,
  ImportLibraryResponse,
  LibraryFolder,
  LibraryItem,
  LibraryItemSummary,
  LibraryMark,
  LibraryScope,
  ListLibraryMarksResponse,
  ListLibraryQuery,
  ListLibraryResponse,
  PatchLibraryFolderInput,
  PatchLibraryItemInput,
  PlaceLibraryItemResponse,
  PutLibraryMarkInput,
} from '@draftroom/contracts'

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

const unavailable = () => Promise.reject(new LibraryRequestError('unavailable'))

export function libraryAvailable(): boolean {
  return false
}

export async function listLibrary(
  _workspaceId: string,
  _query: Partial<ListLibraryQuery> = {},
): Promise<ListLibraryResponse> {
  return { items: [], nextCursor: null }
}

export async function getLibraryItem(_workspaceId: string, _id: string): Promise<LibraryItem | null> {
  return null
}

export async function listLibraryFolders(
  _workspaceId: string,
  _scope: LibraryScope,
): Promise<LibraryFolder[]> {
  return []
}

export async function listLibraryMarks(_workspaceId: string): Promise<ListLibraryMarksResponse> {
  return { favourites: [], recents: [] }
}

export async function putLibraryMark(
  _workspaceId: string,
  _input: PutLibraryMarkInput,
): Promise<LibraryMark | null> {
  return null
}

export function saveLibraryItem(
  _workspaceId: string,
  _input: CreateLibraryItemInput,
): Promise<LibraryItemSummary> {
  return unavailable()
}

export function patchLibraryItem(
  _workspaceId: string,
  _id: string,
  _input: PatchLibraryItemInput,
): Promise<LibraryItemSummary> {
  return unavailable()
}

export function deleteLibraryItem(_workspaceId: string, _id: string): Promise<void> {
  return unavailable()
}

export function restoreLibraryItem(_workspaceId: string, _id: string): Promise<LibraryItemSummary> {
  return unavailable()
}

export function importLibrary(
  _workspaceId: string,
  _input: ImportLibraryInput,
): Promise<ImportLibraryResponse> {
  return unavailable()
}

export function createLibraryFolder(
  _workspaceId: string,
  _input: CreateLibraryFolderInput,
): Promise<LibraryFolder> {
  return unavailable()
}

export function patchLibraryFolder(
  _workspaceId: string,
  _fid: string,
  _input: PatchLibraryFolderInput,
): Promise<LibraryFolder> {
  return unavailable()
}

export function deleteLibraryFolder(_workspaceId: string, _fid: string): Promise<void> {
  return unavailable()
}

export function placeLibraryItem(_boardId: string, _id: string): Promise<PlaceLibraryItemResponse> {
  return unavailable()
}
