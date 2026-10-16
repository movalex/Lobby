// OWNER: WS1 (wave R, import from Miro; landed as a stub by the wave R foundation, live against WS1's routes). The web
// side of the Miro routes (@draftroom/contracts miro-import.ts; docs/WAVE-R-CONTRACTS.md §3).
//
// Frozen signatures (same origin; the token goes in the JSON body as `token`, never in a URL, a header of ours, the
// browser's storage or a log; it is kept only in the dialog's memory and cleared when the dialog closes):
//   listMiroBoards(workspaceId, token, input): Promise<ListMiroBoardsResponse>
//   startMiroImport(workspaceId, token, input): Promise<StartImportResponse>     202
// Both reject with ImportRequestError (`code`: 'unavailable', or the api's: MIRO_TOKEN_INVALID, MIRO_SCOPE_MISSING,
// MIRO_BOARD_NOT_VISIBLE, MIRO_RATE_LIMITED, MIRO_UNAVAILABLE, IMPORT_BUSY, IMPORT_TOO_LARGE, CREATOR_REQUIRED, …).
// The browser itself never calls Miro (the e2e network assertion): parseMiroBoardLink (contracts) reads a pasted link.
import {
  type ListMiroBoardsInput,
  ListMiroBoardsResponse,
  miroBoardsPath,
  miroImportPath,
  StartImportResponse,
  type StartMiroImportInput,
} from '@draftroom/contracts'
import { api } from '../../api/client.ts'
import { importErrorOf } from '../imports/client.ts'

export async function listMiroBoards(
  workspaceId: string,
  token: string,
  input: ListMiroBoardsInput = {},
): Promise<ListMiroBoardsResponse> {
  try {
    return await api.request('POST', miroBoardsPath(workspaceId), {
      body: { token, ...input },
      schema: ListMiroBoardsResponse,
    })
  } catch (e) {
    throw importErrorOf(e)
  }
}

export async function startMiroImport(
  workspaceId: string,
  token: string,
  input: StartMiroImportInput,
): Promise<StartImportResponse> {
  try {
    return await api.request('POST', miroImportPath(workspaceId), {
      body: { token, ...input },
      schema: StartImportResponse,
    })
  } catch (e) {
    throw importErrorOf(e)
  }
}
