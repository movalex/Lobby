// Wave T foundation (docs/WAVE-T-CONTRACTS.md §3): the room of CONTRACTS_REV 14, against the REAL sync server process.
// Pinned here (the rules with the switch on, which replaced the foundation's blanket INVALID, are WS1's
// ./planning-keys.test.ts):
//  - the kill switch DRAFTROOM_PLANNING (config.ts, fail-closed): on, the room says 14; off or unset, it says 13 and
//    every planning write is UNAVAILABLE; with reactions off it says 12 whatever planning is;
//  - the writer rules for a rev-13 tab (generic since wave N): its patch's planning keys are dropped (the rest of its
//    `c` lands, no refusal), its create of a note carrying one is stripped with an ack fix (a plain note);
//  - checkElement holds the types and cross-key rules (a card key on an ellipse is INVALID with the switch on, and
//    UNAVAILABLE with it off: the switch answers first; never reached for a rev-13 writer, whose key is dropped first).

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONNECT_REV_PARAM, CONTRACTS_REV, PLANNING_REV } from '@draftroom/canvas-schema/protocol'
import { afterAll, describe, expect, it } from 'vitest'
import type { ProtocolClientOptions } from '../harness/element-client.ts'
import {
  createElementStack,
  type ElementStack,
  newBoardId,
  sharedElementStack,
} from '../harness/element-stack.ts'
import { ellipse, frame, noteWithLabel } from '../harness/elements.ts'
import { expectAccepted, expectRefused, storedLobby } from './support.ts'

const shared = sharedElementStack()

type Opts = Omit<ProtocolClientOptions, 'wsUrl' | 'boardId' | 'user'>
/** A tab of this build (rev 14 in its connect URL). */
const tab14 = (st: ElementStack, boardId: string, user: string, o: Opts = {}) =>
  st.client({ boardId, user, query: { [CONNECT_REV_PARAM]: String(CONTRACTS_REV) }, ...o })
/** A tab of the deployed web 6769e07 (rev 13 in its connect URL). */
const tab13 = (st: ElementStack, boardId: string, user: string, o: Opts = {}) =>
  st.client({ boardId, user, query: { [CONNECT_REV_PARAM]: '13' }, ...o })

const TAG_DEF = { set: { 'tagDef:urgent': { name: 'urgent', color: 'red' } } }
const TAG = { 'tag:urgent': { name: 'urgent', color: 'red' } }
const CARD = { 'card:status': 'todo', 'card:due': '2026-10-30' }

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})
async function withEnv(env: Record<string, string | undefined>, fn: (st: ElementStack) => Promise<void>) {
  const dataDir = mkdtempSync(join(tmpdir(), 'dr-planning-'))
  dirs.push(dataDir)
  const st = await createElementStack({ dataDir, env })
  try {
    await fn(st)
  } finally {
    await st.dispose()
  }
}

describe('the planning kill switch: the revision the room says', () => {
  it('on (the test stacks): 14 = PLANNING_REV, to every reader', async () => {
    const st = shared.get()
    const b = newBoardId()
    expect(CONTRACTS_REV).toBe(PLANNING_REV)
    for (const c of [
      await tab14(st, b, 'alice'),
      await tab13(st, b, 'bob'),
      await st.client({ boardId: b, user: 'c' }),
    ])
      expect(c.of('contracts').at(-1)).toEqual({ type: 'contracts', rev: 14 })
    expect(st.server.logs()).toContain('[planning] on')
  })

  it('off and unset: 13, the log says so; reactions off: 12 whatever planning is', async () => {
    for (const env of [{ DRAFTROOM_PLANNING: 'off' }, { DRAFTROOM_PLANNING: undefined }])
      await withEnv(env, async (st) => {
        const a = await tab14(st, newBoardId(), 'alice')
        expect(a.of('contracts').at(-1)).toEqual({ type: 'contracts', rev: 13 })
        expect(st.server.logs()).toContain('[planning] off (DRAFTROOM_PLANNING is not on)')
      })
    await withEnv({ DRAFTROOM_REACTIONS: 'off', DRAFTROOM_PLANNING: 'on' }, async (st) => {
      const a = await tab14(st, newBoardId(), 'alice')
      expect(a.of('contracts').at(-1)).toEqual({ type: 'contracts', rev: 12 })
    })
  })
})

describe('the kill switch off refuses every planning write from a rev-14 tab', () => {
  it('switch off: UNAVAILABLE (retryable, nothing written); also for a key on the wrong type', async () => {
    await withEnv({ DRAFTROOM_PLANNING: 'off' }, async (st) => {
      const b = newBoardId()
      const a = await tab14(st, b, 'alice', { role: 'owner' })
      expect((await a.create([...noteWithLabel('n1', 'idea')])).r.every((r) => r.ok)).toBe(true)
      expectRefused(await a.patch('n1', { c: { 'card:status': 'doing' } }), 'UNAVAILABLE', a)
      expectRefused(
        await a.createOne(
          frame('f9', {
            customData: {
              lobby: { timeline: { start: '2026-01-01', end: '2026-02-01', scale: 'week', lanes: 'none' } },
            },
          }),
        ),
        'UNAVAILABLE',
        a,
      )
      expect(await storedLobby(st, b, 'n1')).toEqual({})
      // the switch answers before the element rule: nothing planned is written while it is off, valid or not
      expectRefused(await a.createOne(ellipse('e1', { customData: { lobby: CARD } })), 'UNAVAILABLE', a)
    })
    // with it on, the element rule (checkElement: card keys only on rectangles and notes) holds as everywhere
    const st = shared.get()
    const a = await tab14(st, newBoardId(), 'alice', { role: 'owner' })
    expectRefused(await a.createOne(ellipse('e1', { customData: { lobby: CARD } })), 'INVALID', a)
  })
})

describe('a rev-13 tab (the deployed web) never writes a planning key: the generic writer rules', () => {
  it('its patch keeps everything but the planning keys (no refusal); its copy of a card is a plain note with a fix', async () => {
    const st = shared.get()
    const b = newBoardId()
    const old = await tab13(st, b, 'bob')
    await old.push([], { doc: TAG_DEF })
    expect((await old.create([...noteWithLabel('n1', 'idea')])).r.every((r) => r.ok)).toBe(true)
    // its patch names a planning key (it came from a diff against a copy it never wrote): dropped, the tag lands
    expectAccepted(await old.patch('n1', { c: { ...TAG, 'card:status': 'done' } }))
    expect(await storedLobby(st, b, 'n1')).toEqual(TAG)
    // its paste of a card (an Excalidraw-native copy with the keys): a plain note, each stripped key in the fix
    const ack = await old.create([
      ...noteWithLabel('copy', 'Task', { x: 600, customData: { lobby: { ...CARD, ...TAG } } }),
    ])
    const first = ack.r[0]
    expect(first?.ok).toBe(true)
    if (first?.ok) expect(first.fix).toMatchObject({ 'c:card:status': null, 'c:card:due': null })
    expect(await storedLobby(st, b, 'copy')).toEqual(TAG)
  })
})
