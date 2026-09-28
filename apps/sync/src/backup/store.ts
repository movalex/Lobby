// The offsite store for board backups: a @draftroom/blob-store BlobStore (fs for development and tests,
// Cloudflare R2 on staging), plus the small JSON reads and writes the manifests need.
//
// Keys (docs/WAVE3-CONTRACTS.md "offsite-backups"), under a prefix that is `backups/sync` in the
// server and `test/<run>/backups/sync` in the live R2 test:
//   <prefix>/index.json                          the boards that have offsite backups
//   <prefix>/<boardId>/manifest.json             what is stored for that board (offsite-manifest.ts)
//   <prefix>/<boardId>/<stamp>-c<clock>.sqlite   one consistent backup file (backup.ts)

import { type BlobStore, createFsBlobStore, createR2BlobStore, isBlobStoreError } from '@draftroom/blob-store'
import type { BackupStoreConfig } from '../config.ts'

export const OFFSITE_PREFIX = 'backups/sync'

/** The configured store, or null when offsite backups are off. Never logs or returns credentials. */
export function openBackupStore(config: BackupStoreConfig | undefined): BlobStore | null {
  if (!config || config.kind === 'off') return null
  if (config.kind === 'fs') return createFsBlobStore(config.root)
  return createR2BlobStore({
    accountId: config.accountId,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    bucket: config.bucket,
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
  })
}

/**
 * One line for the startup log: the driver, where it writes, and whether the bucket and token are the
 * backups' own or shared with the api (docs/DEPLOY.md "Backups"). Never a credential.
 */
export function describeBackupStore(config: BackupStoreConfig | undefined): string {
  if (!config || config.kind === 'off') return 'off'
  if (config.kind === 'fs') return `fs (${config.root})`
  const { bucket, credentials } = config.dedicated
  const how =
    bucket && credentials
      ? 'backup-only bucket and token'
      : bucket
        ? 'backup-only bucket, shared R2_* token'
        : credentials
          ? 'shared R2_BUCKET, backup-only token'
          : 'shared with the api: R2_BUCKET and the R2_* token, see docs/DEPLOY.md "Backups"'
  return `r2 (bucket ${config.bucket}; ${how})`
}

/**
 * A short, credential-free description of a failure for logs and the status endpoint: blob store
 * errors by code, HTTP status and S3 code (their messages hold only the operation and the key);
 * system errors by their code; everything else generically. Never the error object itself.
 */
export function describeFailure(e: unknown): string {
  if (e instanceof OffsiteError) return e.message
  if (isBlobStoreError(e)) {
    const parts: string[] = [e.code]
    if (e.status !== undefined) parts.push(`HTTP ${e.status}`)
    if (e.upstreamCode) parts.push(e.upstreamCode)
    return parts.join(' ')
  }
  const code = (e as NodeJS.ErrnoException | null)?.code
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,40}$/.test(code)) return code
  return 'unexpected error'
}

/** A failure whose message is ours and safe to log (no paths, no values from the store). */
export class OffsiteError extends Error {
  override name = 'OffsiteError'
}

/** Reads a JSON object of at most `maxBytes`; null when the key does not exist. */
export async function getJson(store: BlobStore, key: string, maxBytes: number): Promise<unknown | null> {
  const obj = await store.get(key)
  if (!obj) return null
  if (obj.contentLength > maxBytes) {
    ;(obj.body as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.()
    throw new OffsiteError(`${key} is larger than ${maxBytes} bytes`)
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of obj.body as AsyncIterable<Buffer | string>) {
    const b = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    size += b.byteLength
    if (size > maxBytes) throw new OffsiteError(`${key} is larger than ${maxBytes} bytes`)
    chunks.push(b)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new OffsiteError(`${key} is not valid JSON`)
  }
}

export async function putJson(store: BlobStore, key: string, value: unknown): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
  await store.put(key, bytes, { contentType: 'application/json', contentLength: bytes.byteLength })
}
