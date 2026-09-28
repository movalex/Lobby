// Authenticity of the offsite backup store (SEAM-08). The store is not trusted to say what a backup
// holds: whoever can write the bucket could replace a backup file AND rewrite the checksums its manifest
// lists, and the drill would pass and restore-board would stage it. So the sync server signs what it
// writes there, and the restore tools verify before they trust a checksum:
//
//   - each manifest entry (its file, key, times, clock, schema, counts, checksums and asset list, bound
//     to its board): proves the facts about one backup came from the sync server;
//   - each manifest as a whole (every entry with its signature, pendingDeletes, updatedAt): proves the
//     list was written by the sync server, so entries cannot be dropped, reordered or added;
//   - the index (the boards that have offsite backups): a board cannot be hidden from the drill.
//
// The key is derived from DRAFTROOM_INTERNAL_SECRET with HKDF-SHA256 and a label used for nothing
// else, so it never equals the secret itself and signs nothing but backups. Each signature carries a
// key id (a hash of the derived key, not secret), so a manifest signed under an older secret is told
// apart from a forged one. What this cannot do: tell a backup written before signing existed from one
// whose signature was removed. Those are "unsigned", and the tools accept them only with
// --allow-unsigned, saying so on every line concerned.

import { createHash, createHmac, hkdfSync, timingSafeEqual } from 'node:crypto'

const KDF_SALT = 'draftroom offsite backups'
const KDF_INFO = 'draftroom offsite backup signing key v1'
const ALG = 'HMAC-SHA256'
const HEX64 = /^[0-9a-f]{64}$/
const KEY_ID_RE = /^[0-9a-f]{16}$/

/** Domain separation: an entry's signature can never pass as a manifest's, nor a manifest's as the index's. */
const LABELS = {
  entry: 'draftroom-offsite-entry/v1',
  manifest: 'draftroom-offsite-manifest/v1',
  index: 'draftroom-offsite-index/v1',
} as const
export type SignedDocument = 'manifest' | 'index'

export interface Signature {
  alg: typeof ALG
  /** Which derived key signed (16 hex characters of its sha256; reveals nothing about the key). */
  keyId: string
  /** HMAC-SHA256, lowercase hex. */
  value: string
}

/**
 * valid: signed by this key and unchanged. invalid: signed under this key id but changed since, or a
 * signature field that is not one of ours. unknown-key: signed under another key id (a rotated
 * DRAFTROOM_INTERNAL_SECRET, a different deployment, or a forger who picked another id). missing: no
 * signature at all (written before signing, or removed).
 */
export type SignatureStatus = 'valid' | 'invalid' | 'unknown-key' | 'missing'
export interface SignatureCheck {
  status: SignatureStatus
  /** The key id the signature names (for unknown-key messages). */
  keyId?: string
}

/** The offsite backup signing key. The key bytes are private: printing or serializing it shows only its id. */
export class BackupSigningKey {
  readonly id: string
  readonly #key: Buffer

  constructor(internalSecret: string) {
    if (typeof internalSecret !== 'string' || internalSecret.length < 32)
      throw new Error('the backup signing key needs DRAFTROOM_INTERNAL_SECRET (at least 32 characters)')
    this.#key = Buffer.from(hkdfSync('sha256', internalSecret, KDF_SALT, KDF_INFO, 32))
    this.id = createHash('sha256').update(this.#key).digest('hex').slice(0, 16)
  }

  /** HMAC over the label and the canonical JSON of `payload`. */
  mac(label: string, payload: unknown): string {
    return createHmac('sha256', this.#key)
      .update(`${label}\n${canonicalJson(payload)}`)
      .digest('hex')
  }

  toJSON(): { keyId: string } {
    return { keyId: this.id }
  }

  toString(): string {
    return `BackupSigningKey(${this.id})`
  }
}

export function backupSigningKey(internalSecret: string): BackupSigningKey {
  return new BackupSigningKey(internalSecret)
}

/**
 * The bytes a signature covers: JSON with object keys sorted at every level, no whitespace. The value
 * is first put through a JSON round trip, so what is signed is exactly what the store holds and a
 * reader parses back (undefined fields dropped, -0 as 0, and so on).
 */
export function canonicalJson(value: unknown): string {
  return canonical(JSON.parse(JSON.stringify(value ?? null)))
}

function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(',')}}`
}

function withoutSignature(o: Record<string, unknown>): Record<string, unknown> {
  const { signature: _drop, ...rest } = o
  return rest
}

const entryPayload = (boardId: string, entry: Record<string, unknown>) => ({
  boardId,
  entry: withoutSignature(entry),
})

function seal(key: BackupSigningKey, label: string, payload: unknown): Signature {
  return { alg: ALG, keyId: key.id, value: key.mac(label, payload) }
}

function verify(key: BackupSigningKey, label: string, payload: unknown, sig: unknown): SignatureCheck {
  if (sig === undefined || sig === null) return { status: 'missing' }
  const s = sig as Partial<Signature>
  if (
    typeof sig !== 'object' ||
    s.alg !== ALG ||
    typeof s.keyId !== 'string' ||
    !KEY_ID_RE.test(s.keyId) ||
    typeof s.value !== 'string' ||
    !HEX64.test(s.value)
  )
    return { status: 'invalid' }
  if (s.keyId !== key.id) return { status: 'unknown-key', keyId: s.keyId }
  let expected: Buffer
  try {
    expected = Buffer.from(key.mac(label, payload), 'hex')
  } catch {
    return { status: 'invalid' } // not representable as JSON (for example nested too deeply)
  }
  return timingSafeEqual(expected, Buffer.from(s.value, 'hex')) ? { status: 'valid' } : { status: 'invalid' }
}

/** The signature of one manifest entry of `boardId` (every field of the entry except its signature). */
export function signEntry(key: BackupSigningKey, boardId: string, entry: object): Signature {
  return seal(key, LABELS.entry, entryPayload(boardId, entry as Record<string, unknown>))
}

/** Checks the `signature` field of one entry as read from the store (the raw object, not a cleaned copy). */
export function checkEntry(key: BackupSigningKey, boardId: string, raw: unknown): SignatureCheck {
  if (!raw || typeof raw !== 'object') return { status: 'invalid' }
  const o = raw as Record<string, unknown>
  return verify(key, LABELS.entry, entryPayload(boardId, o), o.signature)
}

/** `doc` with a `signature` over everything else in it. */
export function signDocument<T extends object>(
  key: BackupSigningKey,
  kind: SignedDocument,
  doc: T,
): T & { signature: Signature } {
  const body = withoutSignature(doc as Record<string, unknown>) as T
  return { ...body, signature: seal(key, LABELS[kind], body) }
}

/** Checks the top-level `signature` of a manifest or index as read from the store. */
export function checkDocument(key: BackupSigningKey, kind: SignedDocument, raw: unknown): SignatureCheck {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { status: 'invalid' }
  const o = raw as Record<string, unknown>
  return verify(key, LABELS[kind], withoutSignature(o), o.signature)
}
