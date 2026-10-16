// OWNER: WS1 (wave R, import from Miro; a stub landed by the wave R foundation). The web side of the Miro routes
// (@draftroom/contracts miro-import.ts; docs/WAVE-R-CONTRACTS.md §3).
//
// Frozen signatures (same origin; the token goes in the JSON body as `token`, never in a URL, a header of ours, the
// browser's storage or a log; it is kept only in the dialog's memory and cleared when the dialog closes):
//   listMiroBoards(workspaceId, token, input): Promise<ListMiroBoardsResponse>
//   startMiroImport(workspaceId, token, input): Promise<StartImportResponse>
// Both reject with ImportRequestError (`code`: 'unavailable', or the api's: MIRO_TOKEN_INVALID, MIRO_SCOPE_MISSING,
// MIRO_BOARD_NOT_VISIBLE, MIRO_RATE_LIMITED, MIRO_UNAVAILABLE, IMPORT_BUSY, IMPORT_TOO_LARGE, CREATOR_REQUIRED, …).
// The browser itself never calls Miro (the e2e network assertion): parseMiroBoardLink (contracts) reads a pasted link.
//
// The stub: both reject 'unavailable' without a request.
import type {
  ListMiroBoardsInput,
  ListMiroBoardsResponse,
  StartImportResponse,
  StartMiroImportInput,
} from '@draftroom/contracts'
import { importUnavailable } from '../imports/client.ts'

export function listMiroBoards(
  _workspaceId: string,
  _token: string,
  _input: ListMiroBoardsInput = {},
): Promise<ListMiroBoardsResponse> {
  return importUnavailable()
}

export function startMiroImport(
  _workspaceId: string,
  _token: string,
  _input: StartMiroImportInput,
): Promise<StartImportResponse> {
  return importUnavailable()
}
