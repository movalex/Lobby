// OWNER: WS2 (wave S, versions of a deliverable). The web side of the version list (@draftroom/contracts
// asset-versions.ts; docs/WAVE-S-CONTRACTS.md §3):
//
//   listAssetVersions(boardId, assetId): Promise<ListAssetVersionsResponse | null>
//       null: unavailable (an api without the route, a refusal, an unreadable answer, offline); the card then shows no
//       version chip. Same origin, the session cookie, LOBBY_CLIENT_HEADER through the api client; parsed with the
//       contract's schema.
//   supersedesHeader(versionId): Record<string, string>
//       the upload header (dev-assets SUPERSEDES_HEADER) Replace media sends once the versions switch is on
//
// Nothing is logged; nothing is stored in the browser.
import { assetVersionsPath, ListAssetVersionsResponse } from '@draftroom/contracts'
import { type ApiClient, api as defaultApi } from '../../../api/client.ts'
import { SUPERSEDES_HEADER } from '../../../assets/contract.ts'

type Requester = Pick<ApiClient, 'request'>
let requester: Requester | null = null
/** The api client the list uses (tests pass a fake; null: the page's own). */
export function setVersionsRequester(r: Requester | null): void {
  requester = r
}

export async function listAssetVersions(
  boardId: string,
  assetId: string,
  signal?: AbortSignal,
): Promise<ListAssetVersionsResponse | null> {
  try {
    const res = await (requester ?? defaultApi).request('GET', assetVersionsPath(boardId, assetId), {
      schema: ListAssetVersionsResponse,
      signal,
    })
    // an answer about another asset is no answer
    return res.assetId === assetId && res.versions.length > 0 ? res : null
  } catch {
    return null
  }
}

export const supersedesHeader = (versionId: string): Record<string, string> => ({
  [SUPERSEDES_HEADER]: versionId,
})
