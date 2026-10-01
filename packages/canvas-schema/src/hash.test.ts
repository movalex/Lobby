/**
 * The convergence hash (spike B contracts step C0; docs/EXCALIDRAW-MIGRATION.md §8.6.2 `hash.ts`).
 * `HASH_SAMPLE` and `HASH_SAMPLE_DIGEST` are shared with the browser half of this check,
 * `e2e/spike-b/contracts/hash-browser.spec.ts`, which computes the same digest in Chromium.
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { redactTombstone, WireElement } from './elements.ts'
import {
  canonicalElement,
  canonicalElementList,
  canonicalJson,
  hashElements,
  TOMBSTONE_KEYS,
} from './hash.ts'
import { HASH_SAMPLE, HASH_SAMPLE_DIGEST } from './hash-sample.ts'

describe('hash.ts', () => {
  it('gives the pinned digest for the sample map with tombstones (Node 24 WebCrypto)', async () => {
    expect(HASH_SAMPLE.filter((e) => e.isDeleted).length).toBeGreaterThanOrEqual(2)
    expect(await hashElements(HASH_SAMPLE)).toBe(HASH_SAMPLE_DIGEST)
    // WebCrypto and node:crypto agree on the canonical input
    expect(createHash('sha256').update(canonicalElementList(HASH_SAMPLE), 'utf8').digest('hex')).toBe(
      HASH_SAMPLE_DIGEST,
    )
  })

  it('does not depend on element order or key order', async () => {
    const shuffled = [...HASH_SAMPLE].reverse().map((e) => Object.fromEntries(Object.entries(e).reverse()))
    expect(await hashElements(shuffled)).toBe(HASH_SAMPLE_DIGEST)
  })

  it('drops status and the local derivative suffix, and nothing else', async () => {
    const withLocal = HASH_SAMPLE.map((e) =>
      e.type === 'image' ? { ...e, status: 'error', fileId: `${String(e.fileId)}@thumb` } : e,
    )
    expect(await hashElements(withLocal)).toBe(HASH_SAMPLE_DIGEST)
    const edited = HASH_SAMPLE.map((e, i) => (i === 0 ? { ...e, version: Number(e.version) + 1 } : e))
    expect(await hashElements(edited)).not.toBe(HASH_SAMPLE_DIGEST)
    const undeleted = HASH_SAMPLE.map((e) => (e.isDeleted ? { ...e, isDeleted: false } : e))
    expect(await hashElements(undeleted)).not.toBe(HASH_SAMPLE_DIGEST)
    expect(canonicalElement({ id: 'x', status: 'saved', fileId: 'ver_0123456789@display' })).toEqual({
      id: 'x',
      fileId: 'ver_0123456789',
    })
  })

  it('CONTRACTS_REV 7 (W5-02): a tombstone is hashed by its TOMBSTONE_KEYS, so its redacted wire form converges with the full row', async () => {
    const gone = HASH_SAMPLE.filter((e) => e.isDeleted)
    expect(gone.length).toBeGreaterThanOrEqual(2)
    for (const t of gone)
      expect(Object.keys(canonicalElement(t)).sort()).toEqual(
        TOMBSTONE_KEYS.filter((k) => t[k] !== undefined).sort(),
      )
    // a client that holds the content it saw live, one that holds the redacted form, and the server's
    // full row: one digest
    const redacted = HASH_SAMPLE.map((e) =>
      e.isDeleted
        ? (redactTombstone({ ...e, updated: 1, versionNonce: 3, index: e.index ?? null } as never) as never)
        : e,
    )
    const full = HASH_SAMPLE.map((e) =>
      e.isDeleted ? { ...e, updated: 1, versionNonce: 3, index: e.index ?? null } : e,
    )
    const contentChanged = full.map((e) =>
      e.isDeleted ? { ...e, text: 'other words', x: 99, customData: { lobby: { secret: 1 } } } : e,
    )
    const d = await hashElements(full)
    expect(await hashElements(redacted)).toBe(d)
    expect(await hashElements(contentChanged)).toBe(d)
    // what a tombstone keeps still counts
    for (const k of ['version', 'versionNonce', 'index', 'updated'] as const) {
      const moved = full.map((e) => (e.id === 'gone-1' ? { ...e, [k]: k === 'index' ? 'Zy' : 77 } : e))
      expect(await hashElements(moved)).not.toBe(d)
    }
    for (const t of redacted.filter((e) => e.isDeleted)) expect(WireElement.safeParse(t).success).toBe(true)
  })

  it('canonical JSON: sorted keys, undefined dropped, null kept, numbers as JSON writes them', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: null, c: undefined }], e: -0, f: 0.1 + 0.2 })).toBe(
      '{"a":[2,{"d":null}],"b":1,"e":0,"f":0.30000000000000004}',
    )
    expect(() => canonicalJson({ x: Number.NaN })).toThrow()
    expect(() => canonicalElementList([{ id: 'a' }, { id: 'a' }])).toThrow(/duplicate/)
  })
})
