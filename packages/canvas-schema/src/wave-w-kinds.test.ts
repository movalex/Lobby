// Wave W needs no CONTRACTS_REV bump (docs/WAVE-W-CONTRACTS.md §9): what it places on a board (a doc card, a deck's
// slides) are ordinary elements that carry only the existing, create-only `customData.lobby.kind`, with new VALUES
// (@draftroom/contracts FORMAT_ELEMENT_KINDS):
//  - a doc card is a rectangle with a bound label (text, containerId = the card) whose words are Markdown-lite;
//  - a deck slide is a frame, and in it an image of the deck's page `ver_….p<n>` (canvas-schema FILE_ID_PATTERN).
// This proves that every reader and writer still in use takes them as they are, the copy of wave-v-kinds.test.ts:
//  - the frozen schemas of the older webs a tab of may still be open (rev 11 437b4e7, rev 12 3c83611, rev 13 6769e07,
//    test/fixtures) and this package (rev 14: `git diff 7e5b4d6 -- packages/canvas-schema` is empty, so it is the
//    deployed web's AND the deployed sync's): `checkElement` (the sync's per-element check) and the strict
//    `ServerMessage` of each web (a frame naming them is never dropped);
//  - the kind is create-only in every one of them;
//  - the card and its label, the slide and its page are consistent together (the room's cross-element check).
import { FORMAT_ELEMENT_KINDS } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import * as Custom11 from '../test/fixtures/rev11-437b4e7/custom-data.ts'
import * as Elements11 from '../test/fixtures/rev11-437b4e7/elements.ts'
import * as Proto11 from '../test/fixtures/rev11-437b4e7/protocol.ts'
import * as Custom12 from '../test/fixtures/rev12-3c83611/custom-data.ts'
import * as Elements12 from '../test/fixtures/rev12-3c83611/elements.ts'
import * as Proto12 from '../test/fixtures/rev12-3c83611/protocol.ts'
import * as Custom13 from '../test/fixtures/rev13-6769e07/custom-data.ts'
import * as Elements13 from '../test/fixtures/rev13-6769e07/elements.ts'
import * as Proto13 from '../test/fixtures/rev13-6769e07/protocol.ts'
import * as Custom from './custom-data.ts'
import type { WireElement } from './elements.ts'
import * as Elements from './elements.ts'
import { checkInvariants } from './invariants.ts'
import { MAX_ORIGINAL_TEXT_CHARS } from './limits.ts'
import * as Proto from './protocol.ts'
import { SAMPLE_ELEMENTS } from './test-samples.ts'

type Check = (raw: unknown) => { ok: boolean }
type Parse = { safeParse(v: unknown): { success: boolean } }
type KeySpec = (key: string) => { class: string } | null

const READERS: [string, Check, Parse, KeySpec][] = [
  ['rev 11 (437b4e7)', Elements11.checkElement, Proto11.ServerMessage, Custom11.lobbyKeySpec],
  ['rev 12 (3c83611)', Elements12.checkElement, Proto12.ServerMessage, Custom12.lobbyKeySpec],
  ['rev 13 (6769e07)', Elements13.checkElement, Proto13.ServerMessage, Custom13.lobbyKeySpec],
  [
    'rev 14 (this package, the deployed 7e5b4d6)',
    Elements.checkElement,
    Proto.ServerMessage,
    Custom.lobbyKeySpec,
  ],
]

const sample = (k: string) => SAMPLE_ELEMENTS[k] as Record<string, unknown>
const lobbyOf = (el: Record<string, unknown>) =>
  ((el.customData as { lobby?: Record<string, unknown> } | undefined)?.lobby ?? {}) as Record<string, unknown>
const withKind = (el: Record<string, unknown>, kind: string) => ({
  ...el,
  customData: {
    ...((el.customData as Record<string, unknown> | undefined) ?? {}),
    lobby: { ...lobbyOf(el), kind },
  },
})

/** A doc card: a rectangle with a white fill and a top-left label of Markdown-lite words. */
function docCard(words: string): Record<string, unknown>[] {
  const card = withKind(
    {
      ...sample('rectangle'),
      id: 'doc-1',
      width: 640,
      height: 400,
      backgroundColor: '#ffffff',
      fillStyle: 'solid',
      strokeWidth: 1,
      boundElements: [{ id: 'doc-1.t', type: 'text' }],
    },
    FORMAT_ELEMENT_KINDS.docCard,
  )
  const label = {
    ...sample('label'),
    id: 'doc-1.t',
    containerId: 'doc-1',
    x: 10,
    y: 10,
    width: 620,
    height: 380,
    text: words,
    originalText: words,
    textAlign: 'left',
    verticalAlign: 'top',
    autoResize: true,
  }
  return [card, label]
}

/** A deck slide: a frame named "<n> · …" and the page image inside it (fileId ver_….p<n>). */
function deckSlide(n: number, frameIndex = 'aC', imageIndex = 'aD'): Record<string, unknown>[] {
  const frame = withKind(
    {
      ...sample('frame'),
      id: `slide-${n}`,
      index: frameIndex,
      width: 1600,
      height: 900,
      name: `${n} · Our plan`,
    },
    FORMAT_ELEMENT_KINDS.deckSlide,
  )
  const image = withKind(
    {
      ...sample('image'),
      id: `slide-${n}.img`,
      index: imageIndex,
      width: 1600,
      height: 900,
      frameId: `slide-${n}`,
      fileId: `ver_0123456789abcdef.p${n}`,
    },
    FORMAT_ELEMENT_KINDS.deckPage,
  )
  return [frame, image]
}

const WORDS =
  '# Brief\n\n**Goal:** ship _wave W_.\n\n- [ ] one\n- [x] two\n\n> quoted\n\n---\n[link](https://example.com)'
const PLACED = [...docCard(WORDS), ...deckSlide(9, 'aC', 'aD'), ...deckSlide(100, 'aE', 'aF')]

describe('wave W element kinds against every reader still in use', () => {
  it('are the kinds the contracts name', () => {
    expect(Object.values(FORMAT_ELEMENT_KINDS)).toEqual(['doc-card', 'deck-slide', 'deck-page'])
  })

  for (const [name, check, ServerMessage, keySpec] of READERS) {
    it(`${name}: checkElement accepts a doc card, its label, a slide frame and its page image`, () => {
      for (const el of PLACED) {
        const r = check(el)
        expect(r.ok, `${name} ${String(el.id)}: ${JSON.stringify(r)}`).toBe(true)
      }
    })

    it(`${name}: a changes frame creating them is accepted (never dropped), and the kind stays create-only`, () => {
      const frame = { type: 'changes', clock: 9, ops: PLACED.map((el) => ({ k: 'c', el })) }
      expect(ServerMessage.safeParse(JSON.parse(JSON.stringify(frame))).success, name).toBe(true)
      expect(keySpec('kind')?.class, name).toBe('create-only')
    })

    it(`${name}: a doc card at the text cap is accepted`, () => {
      const words = `# Title\n${'a'.repeat(MAX_ORIGINAL_TEXT_CHARS - 8)}`
      expect(words.length).toBe(MAX_ORIGINAL_TEXT_CHARS)
      for (const el of docCard(words)) expect(check(el).ok, `${name} ${String(el.id)}`).toBe(true)
    })
  }

  it('the card and its label, and each slide and its page, are consistent together', () => {
    expect(checkInvariants(PLACED as unknown as WireElement[])).toEqual([])
  })

  it('a kind outside the word rule is still refused, and so is a page past 9999', () => {
    for (const bad of ['Doc-Card', 'doc card', `d${'x'.repeat(32)}`])
      expect(Elements.checkElement(withKind(sample('rectangle'), bad)).ok, bad).toBe(false)
    const [, image] = deckSlide(1) as [Record<string, unknown>, Record<string, unknown>]
    expect(Elements.checkElement({ ...image, fileId: 'ver_0123456789abcdef.p10000' }).ok).toBe(false)
    expect(Elements.checkElement({ ...image, fileId: 'ver_0123456789abcdef.p0' }).ok).toBe(false)
  })
})
