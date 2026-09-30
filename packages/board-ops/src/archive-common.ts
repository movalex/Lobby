// Engine-neutral archive pieces shared by the v1 (tldraw, ./archive.ts) and v2 (Excalidraw,
// ./elements/archive.ts) board archives: the typed error, the limits, the untrusted-JSON copy and the file
// manifest. Moved here unchanged from archive.ts (docs/EXCALIDRAW-MIGRATION.md §3.7).

export interface ArchiveAssetRef {
  assetId: string
  versionId: string
  name: string
  mimeType: string
  sizeBytes: number
  sha256: string
}

export interface ArchiveLimits {
  maxRecords: number
  maxAssets: number
  /** Longest allowed string (and object key) anywhere in the archive. */
  maxStringLength: number
  /** Deepest allowed nesting of objects/arrays (rich text lists nest a few levels). */
  maxDepth: number
  /** Most JSON values (objects, arrays, primitives) in the whole archive. */
  maxNodes: number
  /** Most string characters in the whole archive. */
  maxTotalChars: number
}

export const ARCHIVE_LIMITS: Readonly<ArchiveLimits> = Object.freeze({
  maxRecords: 20_000,
  maxAssets: 5_000,
  maxStringLength: 100_000,
  maxDepth: 64,
  maxNodes: 4_000_000,
  maxTotalChars: 64_000_000,
})

export type ArchiveErrorCode =
  | 'invalid-input'
  | 'wrong-format'
  | 'unsupported-version'
  | 'invalid-envelope'
  | 'too-large'
  | 'forbidden-key'
  | 'invalid-schema'
  | 'incompatible-schema'
  | 'invalid-asset-ref'
  | 'unknown-record-type'
  | 'forbidden-record-type'
  | 'unknown-shape-type'
  | 'duplicate-id'
  | 'migration-failed'
  | 'invalid-record'

/** The only error `importBoardArchive` throws for bad input. Messages are user-safe (no record content beyond short ids). */
export class ArchiveError extends Error {
  readonly code: ArchiveErrorCode
  /** JSON-ish location of the problem, e.g. `records[12].props`. */
  readonly path: string | undefined

  constructor(code: ArchiveErrorCode, message: string, options?: { path?: string; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ArchiveError'
    this.code = code
    this.path = options?.path
  }
}

export const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

export const ASSET_REF_KEYS = ['assetId', 'versionId', 'name', 'mimeType', 'sizeBytes', 'sha256'] as const

export const APP_ASSET_ID = /^ast_[0-9A-Za-z]{10,40}$/

export const APP_VERSION_ID = /^ver_[0-9A-Za-z]{10,40}$/

export const SHA256_HEX = /^[0-9a-f]{64}$/

export const MIME_TYPE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/

export function shortId(id: unknown): string {
  const text = typeof id === 'string' ? id : String(typeof id)
  return JSON.stringify(text.length > 80 ? `${text.slice(0, 80)}…` : text)
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** Own data property (never runs getters, never reads the prototype chain). */
export function own(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor && 'value' in descriptor ? descriptor.value : undefined
}

/**
 * Deep-copies untrusted JSON-like input into fresh plain objects/arrays, enforcing the limits and
 * rejecting prototype-pollution keys, accessors, non-plain objects and non-JSON values.
 */
export function sanitizeJson(input: unknown, limits: ArchiveLimits): unknown {
  let nodes = 0
  let chars = 0
  const path: (string | number)[] = []
  const where = () =>
    path
      .map((part) =>
        typeof part === 'number' ? `[${part}]` : `.${part.length > 40 ? `${part.slice(0, 40)}…` : part}`,
      )
      .join('')
      .replace(/^\./, '')
  const countString = (value: string) => {
    if (value.length > limits.maxStringLength) {
      throw new ArchiveError('too-large', `a string is longer than ${limits.maxStringLength} characters`, {
        path: where(),
      })
    }
    chars += value.length
    if (chars > limits.maxTotalChars) {
      throw new ArchiveError(
        'too-large',
        `the archive has more than ${limits.maxTotalChars} characters of text`,
      )
    }
  }
  const visit = (value: unknown, depth: number): unknown => {
    if (++nodes > limits.maxNodes) {
      throw new ArchiveError('too-large', `the archive has more than ${limits.maxNodes} values`)
    }
    if (value === null || typeof value === 'boolean') return value
    if (typeof value === 'number') {
      if (!Number.isFinite(value))
        throw new ArchiveError('invalid-input', 'non-finite number', { path: where() })
      return value
    }
    if (typeof value === 'string') {
      countString(value)
      return value
    }
    if (typeof value !== 'object') {
      throw new ArchiveError('invalid-input', `unsupported ${typeof value} value`, { path: where() })
    }
    if (depth >= limits.maxDepth) {
      throw new ArchiveError('too-large', `nesting is deeper than ${limits.maxDepth}`, { path: where() })
    }
    if (Array.isArray(value)) {
      const out: unknown[] = []
      const length = value.length
      for (let i = 0; i < length; i++) {
        path.push(i)
        const descriptor = Object.getOwnPropertyDescriptor(value, i)
        if (!descriptor || !('value' in descriptor)) {
          throw new ArchiveError('invalid-input', 'sparse array or accessor element', { path: where() })
        }
        out.push(visit(descriptor.value, depth + 1))
        path.pop()
      }
      return out
    }
    if (!isPlainObject(value))
      throw new ArchiveError('invalid-input', 'not a plain object', { path: where() })
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value)) {
      path.push(key)
      if (FORBIDDEN_KEYS.has(key)) {
        throw new ArchiveError('forbidden-key', `forbidden key ${JSON.stringify(key)}`, { path: where() })
      }
      countString(key)
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !('value' in descriptor)) {
        throw new ArchiveError('invalid-input', 'accessor property', { path: where() })
      }
      out[key] = visit(descriptor.value, depth + 1)
      path.pop()
    }
    return out
  }
  return visit(input, 0)
}

export function readAssetRef(value: unknown, path: string): ArchiveAssetRef {
  if (!isPlainObject(value))
    throw new ArchiveError('invalid-asset-ref', 'asset reference must be an object', { path })
  for (const key of Object.keys(value)) {
    if (!(ASSET_REF_KEYS as readonly string[]).includes(key)) {
      throw new ArchiveError('invalid-asset-ref', `unexpected key ${shortId(key)}`, { path })
    }
  }
  const assetId = own(value, 'assetId')
  const versionId = own(value, 'versionId')
  const name = own(value, 'name')
  const mimeType = own(value, 'mimeType')
  const sizeBytes = own(value, 'sizeBytes')
  const sha256 = own(value, 'sha256')
  if (typeof assetId !== 'string' || !APP_ASSET_ID.test(assetId)) {
    throw new ArchiveError('invalid-asset-ref', 'assetId must be an ast_… id', { path })
  }
  if (typeof versionId !== 'string' || !APP_VERSION_ID.test(versionId)) {
    throw new ArchiveError('invalid-asset-ref', 'versionId must be a ver_… id', { path })
  }
  if (typeof name !== 'string' || name.length > 1024) {
    throw new ArchiveError('invalid-asset-ref', 'name must be a string of at most 1024 characters', { path })
  }
  if (typeof mimeType !== 'string' || !MIME_TYPE.test(mimeType)) {
    throw new ArchiveError('invalid-asset-ref', 'mimeType must look like type/subtype', { path })
  }
  if (typeof sizeBytes !== 'number' || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    throw new ArchiveError('invalid-asset-ref', 'sizeBytes must be a non-negative integer', { path })
  }
  if (typeof sha256 !== 'string' || !SHA256_HEX.test(sha256)) {
    throw new ArchiveError('invalid-asset-ref', 'sha256 must be 64 lowercase hex characters', { path })
  }
  return { assetId, versionId, name, mimeType, sizeBytes, sha256 }
}

/**
 * Defaults with the caller's overrides applied, keeping only finite non-negative numbers: a spread of
 * `{ maxRecords: undefined }` (or NaN, which fails every `>` comparison) would otherwise switch a cap off.
 */
export function resolveLimits(overrides: Partial<ArchiveLimits> | undefined): ArchiveLimits {
  const limits: ArchiveLimits = { ...ARCHIVE_LIMITS }
  if (typeof overrides !== 'object' || overrides === null) return limits
  for (const key of Object.keys(ARCHIVE_LIMITS) as (keyof ArchiveLimits)[]) {
    const value: unknown = Object.hasOwn(overrides, key) ? overrides[key] : undefined
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) limits[key] = Math.floor(value)
  }
  return limits
}
