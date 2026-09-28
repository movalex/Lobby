// Opens the configured blob store (docs/M3-STORAGE-CONTRACTS.md §1, §6) from @draftroom/blob-store.

import { type BlobStore, createFsBlobStore, createR2BlobStore } from '@draftroom/blob-store'
import type { BlobStoreConfig } from '../config.ts'

export function openBlobStore(config: BlobStoreConfig): BlobStore {
  if (config.kind === 'fs') return createFsBlobStore(config.root)
  return createR2BlobStore({
    accountId: config.accountId,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    bucket: config.bucket,
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
  })
}
