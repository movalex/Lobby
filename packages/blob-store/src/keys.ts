// Object keys. One rule for every implementation, so a key that works against R2 also works as a
// path under the fs root (Windows included) and nothing can address a file outside it.

import { BlobStoreError } from './errors.ts'

export const MAX_KEY_LENGTH = 512
const MAX_SEGMENT_LENGTH = 255

const SEGMENT_RE = /^[A-Za-z0-9_.-]+$/
// Windows device names are reserved in every directory and with any extension ("nul.txt").
const WINDOWS_DEVICE_RE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i

/**
 * Why a key is refused, or null when it is valid. Keys are `/`-separated segments of
 * `[A-Za-z0-9_.-]`; no leading/trailing `/`, no empty segment, no segment that starts or ends with
 * `.` (this excludes `.` and `..` and names Windows would silently rewrite), no Windows device
 * name, at most 512 characters. This is stricter than the M3 contract's alphabet rule on purpose.
 */
export function blobKeyProblem(key: unknown): string | null {
  if (typeof key !== 'string') return 'not a string'
  if (key.length === 0) return 'empty'
  if (key.length > MAX_KEY_LENGTH) return 'too long'
  const segments = key.split('/')
  for (const s of segments) {
    if (s.length === 0) return 'empty segment (leading, trailing or double slash)'
    if (s.length > MAX_SEGMENT_LENGTH) return 'segment too long'
    if (!SEGMENT_RE.test(s)) return 'character outside [A-Za-z0-9_./-]'
    if (s.startsWith('.') || s.endsWith('.')) return 'segment starts or ends with a dot'
    if (WINDOWS_DEVICE_RE.test(s)) return 'reserved device name'
  }
  return null
}

export function isValidBlobKey(key: unknown): key is string {
  return blobKeyProblem(key) === null
}

export function assertValidBlobKey(key: unknown): asserts key is string {
  const problem = blobKeyProblem(key)
  // The key itself is not echoed: it may be attacker-controlled input.
  if (problem !== null) throw new BlobStoreError('INVALID_KEY', `blob store: invalid key (${problem})`)
}

function assertSegment(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.includes('/') || blobKeyProblem(value) !== null) {
    throw new BlobStoreError('INVALID_KEY', 'blob store: invalid key (id is not a single key segment)')
  }
}

/**
 * Keys from docs/M3-STORAGE-CONTRACTS.md §1. Each id must be one valid key segment; callers still
 * validate the id format itself (`ast_`/`ver_`/`drv_`) before building a key.
 */
export const blobKeys = {
  original(assetId: string, versionId: string): string {
    assertSegment(assetId)
    assertSegment(versionId)
    return `assets/${assetId}/${versionId}/original`
  },
  derivative(assetId: string, versionId: string, derivativeId: string, ext: 'webp' | 'png'): string {
    assertSegment(assetId)
    assertSegment(versionId)
    assertSegment(derivativeId)
    if (ext !== 'webp' && ext !== 'png') {
      throw new BlobStoreError('INVALID_ARGUMENT', 'blob store: derivative extension must be webp or png')
    }
    return `assets/${assetId}/${versionId}/d/${derivativeId}.${ext}`
  },
}
