// Upload a file through the api and place it on the canvas (docs/EXCALIDRAW-MIGRATION.md §2.10.1
// "Uploads", §2.10.4 file cards; check B7). Excalidraw's own image path (base64 copies, 1440 px, a 4 MiB
// cap) never runs: Lobby uploads the bytes to `/api/boards/:bid/assets` (fs blob store in spike B), then
// creates ONE `image` element through `CanvasPort.transact` holding only the version id (`fileId`) and
// the card's stable facts (`customData.lobby.file`, which the server canonicalizes from the A1 file-refs
// answer, §3.3 class 4). No bytes, no `data:`, no `blob:`, no signed URL ever reach the element.
import { type AssetVersionMeta, isId, sanitizeDisplayName, uploadUrl } from '@draftroom/dev-assets/shared'
import type { CanvasPort, ScenePoint } from '../port.ts'
import type { FileUrlResolver } from './resolve.ts'

/** The card's stable facts, as the element stores them (canvas-schema custom-data.ts FileValue). */
export interface FileFacts {
  readonly assetId: string
  readonly versionId: string
  readonly kind: 'image' | 'pdf' | 'video' | 'other'
  readonly name: string
  readonly mimeType: string
  readonly sizeBytes: number
}

export const factsOf = (meta: AssetVersionMeta): FileFacts => ({
  assetId: meta.assetId,
  versionId: meta.versionId,
  kind: meta.kind,
  name: meta.name.slice(0, 200),
  mimeType: meta.mimeType,
  sizeBytes: meta.sizeBytes,
})

/** POSTs the bytes (the session cookie authorizes; `edit` on the board is required). */
export async function uploadToBoard(
  boardId: string,
  file: Blob,
  name: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AssetVersionMeta> {
  const res = await fetchImpl(uploadUrl(boardId), {
    method: 'POST',
    body: file,
    credentials: 'same-origin',
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      'X-File-Name': encodeURIComponent(sanitizeDisplayName(name)),
    },
  })
  if (!res.ok) throw new Error(`upload failed with ${res.status}`)
  const meta = (await res.json()) as AssetVersionMeta
  if (!isId('ast', meta?.assetId) || !isId('ver', meta?.versionId))
    throw new Error('unexpected upload answer')
  return meta
}

/** The size an element gets: the image's own aspect at `maxSide`, a card's fixed 240 × 300 (PDF) / 320 × 200. */
export function placedSize(meta: AssetVersionMeta, maxSide = 400): { width: number; height: number } {
  const w = meta.probe?.width ?? 0
  const h = meta.probe?.height ?? 0
  if (meta.kind === 'image' && w > 0 && h > 0) {
    const s = Math.min(1, maxSide / Math.max(w, h))
    return { width: Math.round(w * s), height: Math.round(h * s) }
  }
  return meta.kind === 'pdf' ? { width: 240, height: 300 } : { width: 320, height: 200 }
}

/**
 * Places an uploaded version at `at` (its centre) as one `image` element: an image, or a file card
 * (PDF, video, other). Returns the element id.
 */
export function placeFile(
  port: CanvasPort,
  meta: AssetVersionMeta,
  at: ScenePoint,
  resolver?: FileUrlResolver,
): string {
  resolver?.learnRef(meta.versionId, meta.assetId)
  const { width, height } = placedSize(meta)
  return port.transact('Add file', (tx) =>
    tx.create('image', {
      x: Math.round(at.x - width / 2),
      y: Math.round(at.y - height / 2),
      width,
      height,
      fileId: meta.versionId,
      status: 'saved',
      scale: [1, 1],
      customData: { lobby: { file: factsOf(meta) } },
    }),
  )
}

/** Waits until the worker finished a version (its derivatives exist), or `timeoutMs` passed. */
export async function waitForProcessing(
  boardId: string,
  meta: AssetVersionMeta,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<AssetVersionMeta> {
  const doFetch = opts.fetchImpl ?? fetch
  const until = Date.now() + (opts.timeoutMs ?? 60_000)
  let current = meta
  while (current.status !== 'ready' && current.status !== 'failed' && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 500))
    const res = await doFetch(
      `/api/boards/${encodeURIComponent(boardId)}/assets/${meta.assetId}/${meta.versionId}`,
      { cache: 'no-store', credentials: 'same-origin' },
    )
    if (res.ok) current = (await res.json()) as AssetVersionMeta
  }
  return current
}
