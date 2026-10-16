// OWNER: WS2 (wave S, versions of a deliverable; landed as a stub by the wave S foundation). The web side of the
// version list (@draftroom/contracts asset-versions.ts; docs/WAVE-S-CONTRACTS.md §3):
//
//   listAssetVersions(boardId, assetId): Promise<ListAssetVersionsResponse | null>
//       null: unavailable (an api without the route, a refusal, offline); the card then shows no version chip
//   supersedesHeader(versionId): Record<string, string>
//       the upload header (dev-assets SUPERSEDES_HEADER) Replace media sends once the versions switch is on
//
// Until WS2 ships, the list answers null without a request.
import type { ListAssetVersionsResponse } from '@draftroom/contracts'
import { SUPERSEDES_HEADER } from '../../../assets/contract.ts'

export async function listAssetVersions(
  _boardId: string,
  _assetId: string,
): Promise<ListAssetVersionsResponse | null> {
  return null
}

export const supersedesHeader = (versionId: string): Record<string, string> => ({
  [SUPERSEDES_HEADER]: versionId,
})
