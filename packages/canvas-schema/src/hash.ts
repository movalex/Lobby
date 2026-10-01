/**
 * The convergence hash (docs/EXCALIDRAW-MIGRATION.md §8.6.2 `hash.ts`, revised in revision 3.3), frozen
 * at the spike B contracts step C0.
 *
 * It hashes exactly the element list of the test snapshot route (`GET /internal/test/boards/:bid/
 * snapshot`, §2.4.6): the live elements AND the tombstones, in `(id)` order, each as canonical JSON with
 * sorted keys, without `status` and with the local derivative suffix (`@thumb`, `@display`) stripped
 * from `fileId`. Every browser (the facade's `hash()` over the engine core's map, deleted elements
 * included), every headless client and the harness's snapshot read use this one function.
 *
 * Isomorphic: WebCrypto `crypto.subtle.digest`, so it is async and runs in browsers and in Node 24 with no
 * `node:crypto`. It has NO imports at all, so a browser test can load this file with only its types
 * stripped.
 *
 * The digest input is the UTF-8 of `[e1,e2,…]` where each `eᵢ` is `canonicalJson(canonicalElement(el))`:
 * - object keys sorted by UTF-16 code unit (`<`), never locale order;
 * - properties whose value is `undefined` dropped (as `JSON.stringify` drops them); `null` kept;
 * - numbers as `JSON.stringify` writes them (shortest round-trip form, the same in every engine; `-0` is `0`);
 * - arrays in their own order.
 * The result is the lowercase hex SHA-256.
 *
 * Tombstones (CONTRACTS_REV 7, W5-02): a deleted element is hashed as its `TOMBSTONE_KEYS` only. No client
 * is ever sent a tombstone's content (text, authors, customData, links, file ids, geometry): the wire form
 * of a tombstone is elements.ts `redactTombstone`, and the server keeps the full row for "Recently deleted"
 * and restores. A client that saw the element live and then its delete still holds the content locally, a
 * joiner holds the redacted form; both hash the same, and so does the test snapshot's full row.
 */

/** Keys dropped from every element before hashing: local-only state (§3.2). */
export const HASH_DROPPED_KEYS: readonly string[] = ['status']

/**
 * The fields a tombstone keeps on the wire and in the hash (W5-02): what keeps a deleted element from being
 * resurrected or re-keyed by a stale client (its id and type, the deletion, the server's version and nonce,
 * its z-order key) and when it was deleted (`updated`). Everything else of a deleted element is local.
 */
export const TOMBSTONE_KEYS: readonly string[] = [
  'id',
  'type',
  'isDeleted',
  'version',
  'versionNonce',
  'index',
  'updated',
]

/** `JSON.stringify` with object keys sorted (see the file comment). Throws on non-finite numbers. */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'number':
      if (!Number.isFinite(value)) throw new Error('canonicalJson: non-finite number')
      return JSON.stringify(value)
    case 'string':
    case 'boolean':
      return JSON.stringify(value)
    case 'object': {
      if (Array.isArray(value))
        return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`
      const obj = value as Record<string, unknown>
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`
    }
    default:
      throw new Error(`canonicalJson: cannot encode ${typeof value}`)
  }
}

/**
 * One element as it is hashed: without `status`, and with `fileId`'s local derivative suffix stripped; a
 * tombstone (`isDeleted: true`) as its `TOMBSTONE_KEYS` only.
 */
export function canonicalElement(el: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const tombstone = el.isDeleted === true
  for (const [k, v] of Object.entries(el)) {
    if (HASH_DROPPED_KEYS.includes(k)) continue
    if (tombstone && !TOMBSTONE_KEYS.includes(k)) continue
    out[k] = k === 'fileId' && typeof v === 'string' ? v.replace(/@(thumb|display)$/, '') : v
  }
  return out
}

/** The canonical digest input for a set of elements (live and deleted), sorted by id. Throws on a duplicate id. */
export function canonicalElementList(elements: Iterable<Readonly<Record<string, unknown>>>): string {
  const list = [...elements]
  list.sort((a, b) => {
    const x = String(a.id)
    const y = String(b.id)
    return x < y ? -1 : x > y ? 1 : 0
  })
  for (let i = 1; i < list.length; i++)
    if (String(list[i]?.id) === String(list[i - 1]?.id)) throw new Error('hashElements: duplicate element id')
  return `[${list.map((el) => canonicalJson(canonicalElement(el))).join(',')}]`
}

/**
 * The convergence digest of a board's elements, tombstones included (lowercase hex SHA-256). Pass the
 * test snapshot's `elements`, or every element of a client's map (deleted ones too).
 */
export async function hashElements(elements: Iterable<Readonly<Record<string, unknown>>>): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalElementList(elements))
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
