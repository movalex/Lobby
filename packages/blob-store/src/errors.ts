// Errors thrown by every BlobStore implementation. Messages carry the operation and the key only:
// never a URL (signed or not), a host name, a header, a credential or an upstream response body.

export type BlobStoreErrorCode =
  /** The key is outside the allowed alphabet/shape (see keys.ts). Nothing was touched. */
  | 'INVALID_KEY'
  /** Another argument or config value is invalid (range, length, expiry, content type, config). */
  | 'INVALID_ARGUMENT'
  /** The body did not have exactly `contentLength` bytes. Nothing was stored. */
  | 'LENGTH_MISMATCH'
  /** `range.start` is at or past the end of the object. `size` is set when the store knows it. */
  | 'RANGE_NOT_SATISFIABLE'
  /** fs only: the key needs a directory where a file exists, or the reverse (`a` vs `a/b`). */
  | 'KEY_CONFLICT'
  /** fs only (Windows): the object stayed open by a reader, so it could not be replaced in time. */
  | 'BUSY'
  /** No response, or no body progress, within the configured time. */
  | 'TIMEOUT'
  /** The connection failed (DNS, reset, TLS...). `upstreamCode` holds the system code if any. */
  | 'NETWORK'
  /** The object store answered with an unexpected status. `status`/`upstreamCode` describe it. */
  | 'UPSTREAM'

export class BlobStoreError extends Error {
  readonly code: BlobStoreErrorCode
  /** HTTP status from the object store, for UPSTREAM. */
  readonly status: number | undefined
  /** S3 error code (e.g. `SignatureDoesNotMatch`) or a system error code (e.g. `ECONNRESET`). */
  readonly upstreamCode: string | undefined
  /** Object size, for RANGE_NOT_SATISFIABLE when known. */
  readonly size: number | undefined

  constructor(
    code: BlobStoreErrorCode,
    message: string,
    extra: { status?: number; upstreamCode?: string; size?: number } = {},
  ) {
    super(message)
    this.name = 'BlobStoreError'
    this.code = code
    this.status = extra.status
    this.upstreamCode = extra.upstreamCode
    this.size = extra.size
  }
}

export function isBlobStoreError(e: unknown, code?: BlobStoreErrorCode): e is BlobStoreError {
  return e instanceof BlobStoreError && (code === undefined || e.code === code)
}
