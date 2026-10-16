// Secrets Lobby must use again but must not keep readable (wave R: a chat hook's webhook URL; whoever has it can post
// to the channel, so it cannot be hashed like session tokens). AES-256-GCM (node:crypto), the key derived from
// DRAFTROOM_WEBHOOK_SECRET with HKDF-SHA256 (info `lobby-chat-hook-url-v1`), a fresh 12-byte nonce per seal, and the
// row's identity as additional data (`workspaceId:hookId`), so a sealed value moved to another row does not open.
//
//   sealed = nonce (12) ‖ ciphertext ‖ tag (16), stored as bytea with its key id (`k` + 3 digits of the key's
//   fingerprint; 0036 CHECKs both)
//
// Rotation: set DRAFTROOM_WEBHOOK_SECRET to the new value and DRAFTROOM_WEBHOOK_SECRET_PREVIOUS to the old one; rows
// sealed under the old key still open (`open` says they are `stale`) and a re-seal pass rewrites them; then the previous one
// is removed. Losing the secret means the admins paste the URLs again. No secret configured: createSecretBox gives
// null and chat hooks are off (fail closed). Errors say nothing about the value; nothing here logs.

import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto'

export const SEAL_INFO = 'lobby-chat-hook-url-v1'
const NONCE_BYTES = 12
const TAG_BYTES = 16
export const KEY_ID_PATTERN = /^k[0-9]{1,3}$/

/** A sealed value that did not open: wrong key, wrong row, or changed. Its message holds nothing else. */
export class SealedOpenError extends Error {
  constructor() {
    super('a sealed value did not open')
    this.name = 'SealedOpenError'
  }
}

export interface Sealed {
  readonly sealed: Buffer
  readonly keyId: string
}

export interface SecretBox {
  /** the key id new seals carry */
  readonly keyId: string
  seal(plain: string, aad: string): Sealed
  /** the value, and whether it opened only with the previous key (seal it again); throws SealedOpenError */
  open(sealed: Buffer, keyId: string, aad: string): { value: string; stale: boolean }
}

interface Key {
  readonly id: string
  readonly key: Buffer
}

function deriveKey(secret: string): Key {
  const key = Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), SEAL_INFO, 32))
  const fingerprint = createHash('sha256').update(key).digest().readUInt16BE(0) % 1000
  return { id: `k${fingerprint}`, key }
}

function openWith(k: Key, sealed: Buffer, aad: string): string {
  if (sealed.length < NONCE_BYTES + 1 + TAG_BYTES) throw new SealedOpenError()
  const nonce = sealed.subarray(0, NONCE_BYTES)
  const tag = sealed.subarray(sealed.length - TAG_BYTES)
  const body = sealed.subarray(NONCE_BYTES, sealed.length - TAG_BYTES)
  try {
    const d = createDecipheriv('aes-256-gcm', k.key, nonce, { authTagLength: TAG_BYTES })
    d.setAAD(Buffer.from(aad, 'utf8'))
    d.setAuthTag(tag)
    return Buffer.concat([d.update(body), d.final()]).toString('utf8')
  } catch {
    throw new SealedOpenError()
  }
}

/** The box for the configured secret (and the one being rotated away from), or null when none is set. */
export function createSecretBox(
  secret: { current: string; previous: string | null } | null,
): SecretBox | null {
  if (!secret) return null
  const current = deriveKey(secret.current)
  const previous = secret.previous ? deriveKey(secret.previous) : null
  return {
    keyId: current.id,
    seal(plain, aad) {
      const nonce = randomBytes(NONCE_BYTES)
      const c = createCipheriv('aes-256-gcm', current.key, nonce, { authTagLength: TAG_BYTES })
      c.setAAD(Buffer.from(aad, 'utf8'))
      const body = Buffer.concat([c.update(Buffer.from(plain, 'utf8')), c.final()])
      return { sealed: Buffer.concat([nonce, body, c.getAuthTag()]), keyId: current.id }
    },
    open(sealed, keyId, aad) {
      // the named key first; GCM's tag decides (two fingerprints may share their 3 digits)
      const keys = [current, previous].filter((k): k is Key => k !== null)
      keys.sort((a, b) => Number(b.id === keyId) - Number(a.id === keyId))
      for (const k of keys) {
        try {
          return { value: openWith(k, sealed, aad), stale: k !== current }
        } catch {}
      }
      throw new SealedOpenError()
    },
  }
}

/** The additional data of a chat hook's sealed URL: the row it belongs to. */
export const chatHookAad = (workspaceId: string, hookId: string) => `${workspaceId}:${hookId}`
