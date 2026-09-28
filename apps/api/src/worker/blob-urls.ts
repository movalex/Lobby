// fs-mode blob URLs for workers (docs/M3-STORAGE-CONTRACTS.md §4): when the blob store cannot presign
// (a local directory), the api hands out `/api/worker/blobs/<opaque>` and serves or receives the bytes
// itself. The opaque part works like a presigned URL: one blob, one method, a short expiry, and an HMAC
// under a key derived from DRAFTROOM_WORKER_TOKEN (rotating the token revokes every URL).
//
//   <opaque> = <kind>.<id>.<expUnixSec>.<mac>     kind o = GET original (id = ver_…)
//                                                  kind d = PUT reserved derivative (id = drv_…)
//
// It names ids only; the blob key, length and type are looked up in Postgres when the URL is used, so a
// reservation dropped since (lease lost, job reclaimed) makes its URL useless. Kept short on purpose:
// Fastify's router refuses path parameters longer than 100 characters.

import { createHmac, timingSafeEqual } from 'node:crypto'

export type BlobUrlKind = 'o' | 'd'

export interface BlobGrant {
  kind: BlobUrlKind
  id: string
}

const ID_RE: Record<BlobUrlKind, RegExp> = {
  o: /^ver_[0-9A-Za-z]{10,40}$/,
  d: /^drv_[0-9A-Za-z]{10,40}$/,
}
const OPAQUE_RE = /^([od])\.([A-Za-z0-9_]{14,44})\.(\d{10})\.([A-Za-z0-9_-]{22})$/
const MAC_CHARS = 22 // 132 bits of HMAC-SHA256

export function createBlobUrlSigner(workerToken: string, now: () => Date) {
  const key = createHmac('sha256', workerToken).update('draftroom-worker-blob-url-v1').digest()
  const mac = (payload: string) =>
    createHmac('sha256', key).update(payload).digest('base64url').slice(0, MAC_CHARS)
  return {
    /** The opaque path segment for `grant`, valid for `ttlSec` seconds. */
    sign(grant: BlobGrant, ttlSec: number): string {
      if (!ID_RE[grant.kind].test(grant.id)) throw new Error('invalid blob grant')
      const exp = Math.floor(now().getTime() / 1000) + ttlSec
      const payload = `${grant.kind}.${grant.id}.${exp}`
      return `${payload}.${mac(payload)}`
    },
    /** The grant of a well-formed, authentic, unexpired opaque value; null otherwise. */
    verify(opaque: string): BlobGrant | null {
      const m = OPAQUE_RE.exec(opaque)
      if (!m) return null
      const [, kind = '', id = '', exp = '', sig = ''] = m
      if (!ID_RE[kind as BlobUrlKind].test(id)) return null
      const expected = Buffer.from(mac(`${kind}.${id}.${exp}`))
      const given = Buffer.from(sig)
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
      if (Number(exp) * 1000 < now().getTime()) return null
      return { kind: kind as BlobUrlKind, id }
    },
  }
}

export type BlobUrlSigner = ReturnType<typeof createBlobUrlSigner>
