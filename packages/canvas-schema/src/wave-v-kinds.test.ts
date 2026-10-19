// Wave V needs no CONTRACTS_REV bump (docs/WAVE-V-CONTRACTS.md §7): what it places on a board (a poll or scale chart,
// a word cloud, the frames "Make N frames" makes for breakouts) are ordinary elements that carry only the existing,
// create-only `customData.lobby.kind`, with new VALUES (@draftroom/contracts LIVE_ELEMENT_KINDS). This proves that every
// reader and writer still in use takes them as they are:
//  - the frozen schemas of the older webs a tab of may still be open (rev 11 437b4e7, rev 12 3c83611, rev 13 6769e07,
//    test/fixtures) and this package (rev 14: `git diff 711dd04 -- packages/canvas-schema` is empty, so it is the
//    deployed web's AND the deployed sync's): `checkElement` (the sync's per-element check, the one a placement's every
//    create goes through) and the strict `ServerMessage` of each web (a frame naming them is never dropped);
//  - the kind is create-only in every one of them, so no later patch of a placed element names it.
import { LIVE_ELEMENT_KINDS } from '@draftroom/contracts'
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
import * as Elements from './elements.ts'
import * as Proto from './protocol.ts'
import { SAMPLE_ELEMENTS } from './test-samples.ts'

type Check = (raw: unknown) => { ok: boolean }
type Parse = { safeParse(v: unknown): { success: boolean } }
type KeySpec = (key: string) => { class: string } | null

const READERS: [string, Check, Parse, KeySpec][] = [
  ['rev 11 (437b4e7)', Elements11.checkElement, Proto11.ServerMessage, Custom11.lobbyKeySpec],
  ['rev 12 (3c83611)', Elements12.checkElement, Proto12.ServerMessage, Custom12.lobbyKeySpec],
  ['rev 13 (6769e07)', Elements13.checkElement, Proto13.ServerMessage, Custom13.lobbyKeySpec],
  ['rev 14 (this package, the deployed 711dd04)', Elements.checkElement, Proto.ServerMessage, Custom.lobbyKeySpec],
]

const KINDS = Object.values(LIVE_ELEMENT_KINDS)
const withKind = (el: Record<string, unknown>, kind: string, id: string) => ({
  ...el,
  id,
  customData: { ...((el.customData as Record<string, unknown> | undefined) ?? {}), lobby: { kind } },
})
/** What a placement writes: a frame, its bars (rectangles), its words and labels (free texts), and notes ("As sticky notes"). */
const SHAPES = ['frame', 'rectangle', 'text', 'stickynote'] as const

describe('wave V element kinds against every reader still in use', () => {
  it('are the kinds the contracts name, each a valid KindValue', () => {
    expect(KINDS).toEqual(['poll-chart', 'word-cloud', 'breakout-frame'])
  })

  for (const [name, check, ServerMessage, keySpec] of READERS) {
    it(`${name}: checkElement accepts a frame, a rectangle, a free text and a note with each kind`, () => {
      for (const kind of KINDS)
        for (const shape of SHAPES) {
          const el = withKind(SAMPLE_ELEMENTS[shape] as Record<string, unknown>, kind, `${shape}-${kind}`)
          const r = check(el)
          expect(r.ok, `${name} ${shape} ${kind}: ${JSON.stringify(r)}`).toBe(true)
        }
    })

    it(`${name}: a changes frame creating them is accepted (never dropped), and the kind stays create-only`, () => {
      const ops = KINDS.flatMap((kind) =>
        SHAPES.map((shape) => ({
          k: 'c',
          el: withKind(SAMPLE_ELEMENTS[shape] as Record<string, unknown>, kind, `${shape}-${kind}`),
        })),
      )
      const frame = { type: 'changes', clock: 9, ops }
      expect(ServerMessage.safeParse(JSON.parse(JSON.stringify(frame))).success, name).toBe(true)
      expect(keySpec('kind')?.class, name).toBe('create-only')
    })
  }

  it('a kind outside the word rule is still refused by the deployed check (the rule did not loosen)', () => {
    for (const bad of ['Poll-Chart', 'poll chart', `p${'x'.repeat(32)}`])
      expect(
        Elements.checkElement(withKind(SAMPLE_ELEMENTS.frame as Record<string, unknown>, bad, 'frame-bad')).ok,
        bad,
      ).toBe(false)
  })
})
