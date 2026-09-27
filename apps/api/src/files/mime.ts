import type { AssetKind } from '@draftroom/dev-assets'

/** The only types ever served inline for each previewable kind; anything else is an attachment. */
export const INLINE_MIMES: Record<AssetKind, readonly string[]> = {
  image: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
  pdf: ['application/pdf'],
  video: ['video/mp4', 'video/quicktime', 'video/webm'],
  other: [],
}

export const DERIVATIVE_MIMES: readonly string[] = ['image/webp', 'image/png']

const EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
}

const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/

/** The client's Content-Type reduced to a well-formed `type/subtype`, or octet-stream. Untrusted either way. */
export function normalizeDeclaredMime(raw: string | undefined): string {
  const base = (raw ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
  return MIME_RE.test(base) ? base : 'application/octet-stream'
}

/**
 * The type the original is served with until the worker confirms it by content: the declared type
 * when it is allowlisted for the kind, else the extension's, else octet-stream.
 */
export function initialServedMime(kind: AssetKind, declared: string, name: string): string {
  const allowed = INLINE_MIMES[kind]
  if (allowed.includes(declared)) return declared
  const byExt = EXT_MIME[name.toLowerCase().split('.').pop() ?? '']
  return byExt && allowed.includes(byExt) ? byExt : 'application/octet-stream'
}
