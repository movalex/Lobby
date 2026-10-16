// OWNER: WS3 (wave S, media comments). The numbers of an asset's versions on this board ("v1", "v2"), from WS2's
// version list (../versions/client.ts listAssetVersions). Until WS2 ships that list answers null without a request,
// and the chips say "Earlier version" and the exports write the version's id.
import { useEffect, useState } from 'react'
import { listAssetVersions } from '../versions/client.ts'

const EMPTY: ReadonlyMap<string, number> = new Map()

/** versionId -> its number among the versions servable on this board (empty until the list answers). */
export function useVersionNumbers(boardId: string, assetId: string | null): ReadonlyMap<string, number> {
  const [numbers, setNumbers] = useState<ReadonlyMap<string, number>>(EMPTY)
  useEffect(() => {
    if (!assetId) return
    let live = true
    void listAssetVersions(boardId, assetId)
      .then((res) => {
        if (live && res) setNumbers(new Map(res.versions.map((v) => [v.versionId, v.n])))
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [boardId, assetId])
  return numbers
}
