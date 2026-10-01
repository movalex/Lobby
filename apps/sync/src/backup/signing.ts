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
// The key (security audit M3, wave 4b): the signing key is derived with HKDF-SHA256 from
// DRAFTROOM_BACKUP_SIGNING_SECRET, a secret of the sync service's own that nothing else reads. The api
// shares DRAFTROOM_INTERNAL_SECRET with the sync (one env group), so a key derived from it let anyone with
// the internal secret (an api compromise, a Shell of either service) forge backups and manifests the
// restore tools accepted as "signature verified"; the two trust domains are apart now. The key derived from
// DRAFTROOM_INTERNAL_SECRET, which signed every backup before, is kept as a VERIFY-ONLY key: manifests and
// entries written under it still verify (a `valid` check says `via: 'derived'`), it never signs again
// once the dedicated secret is set, and a manifest or index it signed is re-signed with the dedicated key
// at its next write. Without DRAFTROOM_BACKUP_SIGNING_SECRET (development, tests) the derived key signs as
// before; in production with an offsite store the dedicated secret is required (config.ts).
//
// Each signature carries a key id (a hash of the key that signed, not secret), so a manifest signed under
// another secret is told apart from a forged one. What this cannot do: tell a backup written before
// signing existed from one whose signature was removed. Those are "unsigned", and the tools accept them
// only with --allow-unsigned, saying so on every line concerned.

import { createHash, createHmac, hkdfSync, timingSafeEqual } from 'node:crypto'

const KDF_SALT = 'draftroom offsite backups'
/** The key derived from DRAFTROOM_INTERNAL_SECRET (every backup before wave 4b; verify-only once a dedicated secret exists). */
const KDF_INFO_DERIVED = 'draftroom offsite backup signing key v1'
/** The key derived from DRAFTROOM_BACKUP_SIGNING_SECRET. */
const KDF_INFO_DEDICATED = 'draftroom offsite backup signing key v2 (dedicated secret)'
const ALG = 'HMAC-SHA256'
const HEX64 = /^[0-9a-f]{64}$/
const KEY_ID_RE = /^[0-9a-f]{16}$/
const MIN_SECRET_LENGTH = 32

/** Domain separation: an entry's signature can never pass as a manifest's, nor a manifest's as the index's. */
const LABELS = {
  entry: 'draftroom-offsite-entry/v1',
  manifest: 'draftroom-offsite-manifest/v1',
  index: 'draftroom-offsite-index/v1',
} as const
export type SignedDocument = 'manifest' | 'index'

export interface Signature {
  alg: typeof ALG
  /** Which key signed (16 hex characters of its sha256; reveals nothing about the key). */
  keyId: string
  /** HMAC-SHA256, lowercase hex. */
  value: string
}

/** Where a signing key's secret comes from. */
export type KeySource = 'dedicated' | 'derived'

/**
 * valid: signed by this key (or by its verify-only key: `via: 'derived'`) and unchanged. invalid: signed
 * under a known key id but changed since, or a signature field that is not one of ours. unknown-key:
 * signed under another key id (a rotated secret, a different deployment, or a forger who picked another
 * id). missing: no signature at all (written before signing, or removed).
 */
export type SignatureStatus = 'valid' | 'invalid' | 'unknown-key' | 'missing'
export interface SignatureCheck {
  status: SignatureStatus
  /** The key id the signature names (for unknown-key messages). */
  keyId?: string
  /** valid only: which of this key's secrets verified it (`derived`: the older key, verify-only). */
  via?: KeySource
}

/** The secrets a signing key is made of (config.ts backupSigningSecrets). */
export interface BackupSigningSecrets {
  /** DRAFTROOM_BACKUP_SIGNING_SECRET; null or absent: the derived key signs (development, tests). */
  backup?: string | null
  /** DRAFTROOM_INTERNAL_SECRET: the verify-only key's root (and the signing key's without `backup`). */
  internal: string
}

interface KeyMaterial {
  readonly id: string
  readonly key: Buffer
  readonly source: KeySource
}

function derive(secret: string, info: string, source: KeySource, name: string): KeyMaterial {
  if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH)
    throw new Error(`the backup signing key needs ${name} (at least ${MIN_SECRET_LENGTH} characters)`)
  const key = Buffer.from(hkdfSync('sha256', secret, KDF_SALT, info, 32))
  return { id: createHash('sha256').update(key).digest('hex').slice(0, 16), key, source }
}

/**
 * The offsite backup signing key: one key that signs, and the keys that only verify (the derived key,
 * once a dedicated secret signs). The key bytes are private: printing or serializing it shows only ids.
 */
export class BackupSigningKey {
  /** The signing key's id. */
  readonly id: string
  /** Which secret the signing key comes from. */
  readonly source: KeySource
  readonly #signing: KeyMaterial
  /** Verify-only keys by id (the derived key, when the dedicated secret signs). */
  readonly #verifiers: ReadonlyMap<string, KeyMaterial>

  constructor(secrets: string | BackupSigningSecrets) {
    const s: BackupSigningSecrets = typeof secrets === 'string' ? { internal: secrets } : secrets
    const derived = derive(s.internal, KDF_INFO_DERIVED, 'derived', 'DRAFTROOM_INTERNAL_SECRET')
    if (s.backup) {
      if (s.backup === s.internal)
        throw new Error('DRAFTROOM_BACKUP_SIGNING_SECRET and DRAFTROOM_INTERNAL_SECRET must differ')
      this.#signing = derive(s.backup, KDF_INFO_DEDICATED, 'dedicated', 'DRAFTROOM_BACKUP_SIGNING_SECRET')
      this.#verifiers = new Map([[derived.id, derived]])
    } else {
      this.#signing = derived
      this.#verifiers = new Map()
    }
    this.id = this.#signing.id
    this.source = this.#signing.source
  }

  /** The ids of the keys that only verify (the derived key's, when a dedicated secret signs). */
  get verifyOnlyIds(): readonly string[] {
    return [...this.#verifiers.keys()]
  }

  /**
   * The environment variables whose values this key verifies with, for messages: a signature under
   * another key id means none of them is the one that wrote it.
   */
  get secretNames(): string {
    return this.source === 'dedicated'
      ? 'DRAFTROOM_BACKUP_SIGNING_SECRET (or, for older backups, DRAFTROOM_INTERNAL_SECRET)'
      : 'DRAFTROOM_INTERNAL_SECRET'
  }

  /** HMAC over the label and the canonical JSON of `payload`, with the signing key or a verify-only key by id. */
  mac(label: string, payload: unknown, keyId: string = this.id): string {
    const material = keyId === this.id ? this.#signing : this.#verifiers.get(keyId)
    if (!material) throw new Error('unknown key id')
    return createHmac('sha256', material.key)
      .update(`${label}\n${canonicalJson(payload)}`)
      .digest('hex')
  }

  /** Whether `keyId` is this key's or one of its verify-only keys', and which. */
  sourceOf(keyId: string): KeySource | null {
    if (keyId === this.id) return this.source
    return this.#verifiers.get(keyId)?.source ?? null
  }

  toJSON(): { keyId: string; source: KeySource; verifyOnly: string[] } {
    return { keyId: this.id, source: this.source, verifyOnly: [...this.#verifiers.keys()] }
  }

  toString(): string {
    return `BackupSigningKey(${this.id})`
  }
}

/**
 * The key from the secrets (a string: the internal secret alone, as every caller before wave 4b; the
 * derived key then signs). With `backup` set, the dedicated key signs and the derived key only verifies.
 */
export function backupSigningKey(secrets: string | BackupSigningSecrets): BackupSigningKey {
  return new BackupSigningKey(secrets)
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
  const via = key.sourceOf(s.keyId)
  if (via === null) return { status: 'unknown-key', keyId: s.keyId }
  let expected: Buffer
  try {
    expected = Buffer.from(key.mac(label, payload, s.keyId), 'hex')
  } catch {
    return { status: 'invalid' } // not representable as JSON (for example nested too deeply)
  }
  if (!timingSafeEqual(expected, Buffer.from(s.value, 'hex'))) return { status: 'invalid' }
  return s.keyId === key.id ? { status: 'valid' } : { status: 'valid', keyId: s.keyId, via }
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
