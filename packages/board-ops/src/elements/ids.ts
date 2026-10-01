/**
 * Fresh element ids, seeds and nonces for elements Lobby makes outside the editor (templates, pasted notes,
 * archive imports). New ids are 21-character nanoid-style ids like Excalidraw's own (`[A-Za-z0-9_-]`,
 * canvas-schema limits.ts ELEMENT_ID_PATTERN; docs/EXCALIDRAW-MIGRATION.md §3.6 "New ids are Excalidraw's
 * nanoids"). Uses Web Crypto where the platform has it (browsers, Node 24), else Math.random.
 *
 * Pure: no imports.
 */

// nanoid's url alphabet: 64 distinct characters, so a byte & 63 picks one uniformly
const ALPHABET = 'useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict'

type RandomSource = (bytes: Uint8Array) => Uint8Array

const webCrypto = (globalThis as { crypto?: { getRandomValues?: RandomSource } }).crypto
const fill: RandomSource =
  webCrypto && typeof webCrypto.getRandomValues === 'function'
    ? (bytes) => webCrypto.getRandomValues?.call(webCrypto, bytes) ?? bytes
    : (bytes) => {
        for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
        return bytes
      }

/** A new element id (21 characters of `[A-Za-z0-9_-]`). */
export function newElementId(): string {
  const bytes = fill(new Uint8Array(21))
  let id = ''
  for (const b of bytes) id += ALPHABET[b & 63]
  return id
}

/** A random 31-bit positive integer (Excalidraw's `seed` and `versionNonce` range). */
export function randomInt31(): number {
  const b = fill(new Uint8Array(4))
  const n = ((b[0] ?? 0) | ((b[1] ?? 0) << 8) | ((b[2] ?? 0) << 16) | ((b[3] ?? 0) << 24)) & 0x7fffffff
  return n || 1
}

/** Where ids come from: fresh ones by default, or the caller's (deterministic tests, conversions). */
export type IdSource = () => string
