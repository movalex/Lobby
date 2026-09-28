// The api's view of object storage (docs/M3-STORAGE-CONTRACTS.md §1): the BlobStore interface that
// @draftroom/blob-store implements (a local directory or Cloudflare R2), plus the blob keys of assets.
// Keys are derived from validated ids only, never from request input, so they cannot leave their prefix.

import { isId } from '@draftroom/dev-assets'

export type { BlobObject, BlobStore } from '@draftroom/blob-store'

export type DerivativeExt = 'webp' | 'png'

export const DERIVATIVE_EXT: Record<'image/webp' | 'image/png', DerivativeExt> = {
  'image/webp': 'webp',
  'image/png': 'png',
}

function checkIds(assetId: string, versionId: string) {
  if (!isId('ast', assetId) || !isId('ver', versionId)) throw new Error('invalid asset/version id')
}

/** `assets/<ast>/<ver>/original`: the uploaded bytes (immutable). */
export function originalKey(assetId: string, versionId: string): string {
  checkIds(assetId, versionId)
  return `assets/${assetId}/${versionId}/original`
}

/** `assets/<ast>/<ver>/d/<drv>.<webp|png>`: one preview image. */
export function derivativeKey(assetId: string, versionId: string, derivativeId: string, ext: DerivativeExt) {
  checkIds(assetId, versionId)
  if (!isId('drv', derivativeId) || (ext !== 'webp' && ext !== 'png')) throw new Error('invalid derivative')
  return `assets/${assetId}/${versionId}/d/${derivativeId}.${ext}`
}

/** Deletes blobs without ever throwing (cleanup paths): failures are reported, not raised. */
export async function deleteQuietly(
  blobs: { delete(key: string): Promise<void> },
  keys: Iterable<string>,
  onError: (key: string, err: unknown) => void,
): Promise<void> {
  await Promise.all(
    [...keys].map(async (key) => {
      try {
        await blobs.delete(key)
      } catch (err) {
        onError(key, err)
      }
    }),
  )
}
