/**
 * The convergence hash (spike B contracts step C0; docs/EXCALIDRAW-MIGRATION.md §8.6.2 `hash.ts`).
 * `HASH_SAMPLE` and `HASH_SAMPLE_DIGEST` are shared with the browser half of this check,
 * `e2e/spike-b/contracts/hash-browser.spec.ts`, which computes the same digest in Chromium.
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { canonicalElement, canonicalElementList, canonicalJson, hashElements } from './hash.ts'
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

  it('canonical JSON: sorted keys, undefined dropped, null kept, numbers as JSON writes them', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: null, c: undefined }], e: -0, f: 0.1 + 0.2 })).toBe(
      '{"a":[2,{"d":null}],"b":1,"e":0,"f":0.30000000000000004}',
    )
    expect(() => canonicalJson({ x: Number.NaN })).toThrow()
    expect(() => canonicalElementList([{ id: 'a' }, { id: 'a' }])).toThrow(/duplicate/)
  })
})
