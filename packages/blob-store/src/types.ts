// The BlobStore contract (docs/M3-STORAGE-CONTRACTS.md §1). Node only.

export interface BlobRange {
  /** First byte, inclusive (>= 0). */
  start: number
  /** Last byte, inclusive (>= start). Clamped to the object's last byte, as in HTTP. */
  end: number
}

export interface PutOptions {
  contentType: string
  /** Exact body length in bytes. A body with any other length is refused (LENGTH_MISMATCH). */
  contentLength: number
}

export interface HeadResult {
  contentLength: number
  /** fs: always null (the fs store does not persist content types; the DB holds them). */
  contentType: string | null
}

export interface BlobObject {
  /** Must be consumed or destroyed by the caller; destroying it releases the file/connection. */
  body: NodeJS.ReadableStream
  /** Bytes in `body` (the range length for a range read). */
  contentLength: number
  contentType: string | null
  /** `bytes <start>-<end>/<size>`, only for range reads. */
  contentRange?: string
}

export interface BlobStore {
  readonly kind: 'fs' | 'r2'
  /**
   * Stores `body` under `key`, replacing any existing object. Streams are never buffered in full.
   * Readers see the old object or the new one, never a partial one; on any failure nothing new is
   * stored. Once the arguments validate, a stream body is consumed (and destroyed on failure).
   * A stream that errors rejects put() with that same error.
   */
  put(
    key: string,
    body: NodeJS.ReadableStream | Uint8Array,
    opts: { contentType: string; contentLength: number },
  ): Promise<void>
  /**
   * null = no such object. A range whose start is at or past the end of the object rejects with
   * BlobStoreError RANGE_NOT_SATISFIABLE (`size` set when known).
   */
  get(key: string, opts?: { range?: { start: number; end: number } }): Promise<BlobObject | null>
  head(key: string): Promise<{ contentLength: number; contentType: string | null } | null>
  /** Idempotent: deleting a missing object succeeds. */
  delete(key: string): Promise<void>
  /** Short-lived signed GET for a server-side consumer (the worker). fs → null (caller serves bytes itself). */
  presignGet(key: string, opts: { expiresSec: number }): Promise<string | null>
  /**
   * Short-lived signed PUT for a server-side producer (the worker). fs → null.
   * The upload must send exactly `Content-Type: <contentType>` (and `Content-Length: <contentLength>`
   * when given): both are part of the signature, so the URL cannot store another type or size.
   * Use presignedPutHeaders() to build those headers.
   */
  presignPut(
    key: string,
    opts: { expiresSec: number; contentType: string; contentLength?: number },
  ): Promise<string | null>
}
