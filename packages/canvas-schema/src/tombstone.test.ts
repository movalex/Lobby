/**
 * Tombstones on the wire (CONTRACTS_REV 7, W5-02): `redactTombstone` gives every stored type a valid
 * `WireElement` that keeps the TOMBSTONE_KEYS and carries none of the deleted element's content, and hash.ts
 * hashes it like the full row.
 */
import { describe, expect, it } from 'vitest'
import {
  ELEMENT_TYPES,
  isRedactedTombstone,
  REDACTED_FILE_ID,
  redactTombstone,
  TOMBSTONE_KEYS,
  WireElement,
} from './elements.ts'
import { canonicalElement, canonicalJson } from './hash.ts'
import { SAMPLE_ELEMENTS } from './test-samples.ts'

/** Every string a deleted element may carry as content: text, authors, links, names, file ids. */
const CONTENT = [
  'secret words',
  'usr_alice',
  'Alice',
  'https://intranet.test/x',
  'Q3 plan',
  'ver_abcdefghij12',
]

const withContent = (el: Record<string, unknown>): Record<string, unknown> => ({
  ...el,
  x: 123.5,
  y: -40,
  width: 310,
  height: 99,
  isDeleted: true,
  version: 7,
  versionNonce: 4242,
  index: 'a5',
  updated: 1_790_000_000_999,
  link: CONTENT[3],
  groupIds: ['g1'],
  frameId: 'f1',
  customData: {
    lobby: { 'tag:plan': { name: CONTENT[0], color: 'green' } },
    lobbyServer: { createdBy: { uid: CONTENT[1], name: CONTENT[2], guest: false }, createdAt: 1 },
  },
  ...(el.type === 'text' ? { text: CONTENT[0], originalText: CONTENT[0], containerId: 'n1' } : {}),
  ...(el.type === 'frame' ? { name: CONTENT[4] } : {}),
  ...(el.type === 'image' ? { fileId: CONTENT[5] } : {}),
  ...(el.type === 'freedraw' || el.type === 'arrow' || el.type === 'line'
    ? {
        points: [
          [0, 0],
          [50, 75],
        ],
      }
    : {}),
})

describe('redactTombstone (W5-02)', () => {
  it('keeps the TOMBSTONE_KEYS of every stored type, is a valid WireElement, and carries no content', () => {
    const types = new Set<string>()
    for (const sample of Object.values(SAMPLE_ELEMENTS)) {
      types.add(sample.type)
      const full = withContent(sample as unknown as Record<string, unknown>)
      const r = redactTombstone(full as never) as unknown as Record<string, unknown>
      expect(WireElement.safeParse(r).success, sample.type).toBe(true)
      for (const k of TOMBSTONE_KEYS) expect(r[k], `${sample.type}.${k}`).toEqual(full[k])
      const json = JSON.stringify(r)
      for (const c of CONTENT) expect(json.includes(c), `${sample.type} carries ${c}`).toBe(false)
      expect(r.customData).toBeUndefined()
      expect([r.x, r.y, r.width, r.height]).toEqual([0, 0, 0, 0])
      expect(r.groupIds).toEqual([])
      expect(r.frameId).toBeNull()
      if (sample.type === 'image') expect(r.fileId).toBe(REDACTED_FILE_ID)
      // the convergence hash: the full row and the redacted form are one element
      expect(canonicalJson(canonicalElement(r))).toBe(canonicalJson(canonicalElement(full)))
      expect(isRedactedTombstone(r as never)).toBe(true)
      expect(isRedactedTombstone(full as never)).toBe(false)
    }
    expect([...types].sort()).toEqual([...ELEMENT_TYPES].sort())
  })

  it('a live element is never "redacted"', () => {
    expect(isRedactedTombstone(SAMPLE_ELEMENTS.rectangle as never)).toBe(false)
  })
})
