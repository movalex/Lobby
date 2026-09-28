// Object storage for asset originals and derivatives (docs/M3-STORAGE-CONTRACTS.md §1). Node only.
//   createFsBlobStore(root) - local files (dev, e2e, tests)
//   createR2BlobStore(cfg)  - Cloudflare R2 over the S3 API (aws4fetch SigV4)

export { MAX_OBJECT_BYTES, MAX_PRESIGN_EXPIRES_SEC, presignedPutHeaders } from './common.ts'
export { BlobStoreError, type BlobStoreErrorCode, isBlobStoreError } from './errors.ts'
export { createFsBlobStore } from './fs-store.ts'
export { assertValidBlobKey, blobKeyProblem, blobKeys, isValidBlobKey, MAX_KEY_LENGTH } from './keys.ts'
export { createR2BlobStore, type R2BlobStoreConfig } from './r2-store.ts'
export type { BlobObject, BlobRange, BlobStore, HeadResult, PutOptions } from './types.ts'
