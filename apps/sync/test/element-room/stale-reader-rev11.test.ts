// CONTRACTS_REV 12, the per-reader rule against the REAL room (room/reader-frames.ts; canvas-schema protocol.ts
// `frameForReader`, `lobbyWriteOf`; docs/EXCALIDRAW-CONTRACTS.md §0b). The deployed web (437b4e7, rev 11) parses
// every server frame with its own build's strict schemas and drops a whole frame it refuses; here a socket of that
// web is a protocol client that parses with exactly those schemas (packages/canvas-schema/test/fixtures/
// rev11-437b4e7) and names no revision in its connect URL, as that web does. While a rev-12 tab writes every data
// shape wave L writes, the rev-11 socket:
//  - parses EVERY frame it gets (a frame its schemas refuse would land in `schemaErrors` and not be applied, as its
//    socket drops it), presence with the laser in use included;
//  - holds exactly the server's board (the convergence hash, tombstones included): live, after a reconnect's
//    catch-up of minutes written while it was away, and after a fresh open (the reset snapshot);
//  - and its own writes keep what it cannot know: its reorder, skip or auto-order of a frame keeps the frame's
//    planned minutes (the ack's fix names the stored value), its edits of AI-made elements keep their run ids;
//    while a rev-12 tab's write without the minutes clears them.
// Before this rule (stale pair (c), wave L integration) the rev-11 socket dropped every `changes` frame that carried
// a `present.mins` (and every op committed with it), and a rev-11 reorder erased the minutes.

import { installServerTextMetrics } from '@draftroom/canvas-schema/engine'
import { CONNECT_REV_PARAM, CONTRACTS_REV, PRESENCE_LASER_REV } from '@draftroom/canvas-schema/protocol'
import { describe, expect, it } from 'vitest'
import * as Old from '../../../../packages/canvas-schema/test/fixtures/rev11-437b4e7/protocol.ts'
import { instantiatePiece, PIECE_IDS } from '../../../../packages/templates/src/pieces/index.ts'
import type { FrameSchemas } from '../harness/element-client.ts'
import { type ElementStack, newBoardId, sharedElementStack } from '../harness/element-stack.ts'
import {
  arrow,
  bindArrow,
  diamond,
  type El,
  frame,
  label,
  noteWithLabel,
  rect,
  text,
  withLabel,
} from '../harness/elements.ts'
import { sleep } from '../harness/wait.ts'

installServerTextMetrics()

const shared = sharedElementStack()

/** How the deployed web (437b4e7) parses a server frame: its own frozen schemas. */
const REV11_WEB: FrameSchemas = {
  ServerMessage: Old.ServerMessage as unknown as FrameSchemas['ServerMessage'],
  decodeSnapshotFrame: Old.decodeSnapshotFrame,
}
const RUN = 'air_0123456789ABCDEFGHIJ'

/** A tab of the deployed web: no revision in its connect URL, its frames parsed by its own schemas. */
const rev11Tab = (
  st: ElementStack,
  boardId: string,
  user: string,
  o: Partial<Parameters<ElementStack['client']>[0]> = {},
) => st.client({ boardId, user, schemas: REV11_WEB, ...o })
/** A rev-12 tab (the wave L web): its connect URL names its revision. */
const rev12Tab = (
  st: ElementStack,
  boardId: string,
  user: string,
  o: Partial<Parameters<ElementStack['client']>[0]> = {},
) => st.client({ boardId, user, role: 'owner', query: { [CONNECT_REV_PARAM]: String(CONTRACTS_REV) }, ...o })

const lobbyOf = (el: El | undefined) => (el?.customData?.lobby ?? {}) as Record<string, unknown>
const storedLobby = async (st: ElementStack, b: string, id: string) => lobbyOf(await st.stored(b, id))

/** Every data shape wave L writes (docs/EXCALIDRAW-CONTRACTS.md L-1), made by `by` (the AI provenance's writer). */
function waveLBoard(by: string): El[] {
  const ai = (kind: string) => ({ ai: { by, run: RUN }, kind })
  const els: El[] = []
  // W5 run of show: frames with planned minutes, one skipped
  els.push(
    frame('f1', { name: 'Warm-up', customData: { lobby: { present: { index: 0, mins: 5 } } } }),
    frame('f2', { name: 'Ideas', x: 1000, customData: { lobby: { present: { index: 1, mins: 20 } } } }),
    frame('f3', {
      name: 'Wrap',
      x: 2000,
      customData: { lobby: { present: { index: 2, skip: true, mins: 10 } } },
    }),
  )
  // W2: AI notes and an answer with provenance (run id), tagged
  const [n1, n1t] = noteWithLabel('n1', 'idea', { x: 40, y: 40, customData: { lobby: ai('ai-idea') } })
  const [n2, n2t] = noteWithLabel('n2', 'answer', { x: 300, y: 40, customData: { lobby: ai('ai-answer') } })
  els.push(n1, n1t, n2, n2t)
  // W2 Wrap up: the Recap frame, its AI heading and the room's table and items
  els.push(
    frame('recap', { name: 'Recap', x: 4000, customData: { lobby: ai('ai-recap') } }),
    text('recap-h', { x: 4020, y: 20, customData: { lobby: ai('ai-recap-heading') } }),
    rect('recap-t', { x: 4020, y: 80, customData: { lobby: { kind: 'recap-table' } } }),
    text('recap-i', { x: 4020, y: 200, customData: { lobby: { kind: 'recap-item' } } }),
  )
  // W4 diagram from words: AI nodes, a labelled AI edge bound to both (the room derives its ends)
  const d1 = rect('d1', { x: 6000, y: 0, customData: { lobby: ai('ai-diagram-node') } })
  const d2 = diamond('d2', { x: 6400, y: 0, customData: { lobby: ai('ai-diagram-node') } })
  const e1 = bindArrow(
    arrow('e1', {
      x: 6100,
      y: 50,
      width: 300,
      points: [
        [0, 0],
        [300, 0],
      ],
      customData: { lobby: ai('ai-diagram-edge') },
    }),
    d1,
    d2,
  )
  const e1t = label('e1.t', 'e1', { x: 6200, y: 40, customData: { lobby: ai('ai-diagram-label') } })
  withLabel(e1, e1t)
  els.push(d1, d2, e1, e1t)
  // W4 flow next shape and Mermaid paste: plain shapes and a bound connector (no new key)
  const s1 = rect('s1', { x: 8000 })
  const s2 = rect('s2', { x: 8300 })
  els.push(
    s1,
    s2,
    bindArrow(
      arrow('c1', {
        x: 8100,
        y: 50,
        width: 200,
        points: [
          [0, 0],
          [200, 0],
        ],
      }),
      s1,
      s2,
    ),
  )
  // W8 sort headings (by colour; by an AI lens with provenance) and the 2x2
  els.push(
    text('h1', { x: 40, y: 900, customData: { lobby: { kind: 'sort-label' } } }),
    text('h2', { x: 300, y: 900, customData: { lobby: ai('ai-sort-label') } }),
    frame('m1', { name: '2x2', x: 0, y: 3000, customData: { lobby: { kind: 'sort-matrix' } } }),
  )
  // W5 results to the board: the chart frame, its winners and ranks
  els.push(
    frame('v1', { name: 'Vote results', x: 10_000, customData: { lobby: { kind: 'vote-chart' } } }),
    text('v1-rank', { x: 10_020, y: 20, customData: { lobby: { kind: 'vote-rank' } } }),
    frame('v2', { name: 'Winners', x: 12_000, customData: { lobby: { kind: 'vote-winners' } } }),
  )
  return els
}

/** A presence message with the laser down (CONTRACTS_REV 12), from a rev-12 tab. */
const laserPresence = (x: number) => ({
  type: 'presence',
  pointer: { x, y: 10 },
  button: 'down',
  sel: [],
  view: { x: 0, y: 0, w: 800, h: 600, z: 1 },
  idle: false,
  editing: null,
  f: null,
  t: 'laser',
  trail: [
    { x: x - 10, y: 10 },
    { x: x - 5, y: 10 },
  ],
})

describe('CONTRACTS_REV 12 against a tab of the deployed web (437b4e7): every frame it parses, every change it holds', () => {
  it('everything wave L writes reaches it, in every frame, and its copy stays the server’s: live, after a catch-up, after a reset', async () => {
    const st = shared.get()
    const b = newBoardId()
    const fac = await rev12Tab(st, b, 'fac')
    const old = await rev11Tab(st, b, 'old-web')

    // every wave L shape, and every piece of the catalogue (W8), each kind of write a feature makes
    const made = await fac.create(waveLBoard('fac'))
    expect(made.r.filter((r) => !r.ok)).toEqual([])
    let n = 0
    for (const id of PIECE_IDS) {
      const p = instantiatePiece(id, { origin: { x: 20_000 + 600 * n++, y: 20_000 } }, { now: 1 })
      const ack = await fac.create(p.elements)
      expect(
        ack.r.filter((r) => !r.ok),
        id,
      ).toEqual([])
    }
    // the minutes changed with a note's move in the SAME push (one commit, one `changes` frame): before the rule
    // the rev-11 tab dropped both
    await fac.push([
      fac.patchOp('f1', { c: { present: { index: 0, mins: 10 } } }),
      fac.patchOp('n1', { g: { pos: { x: 120, y: 140 } } }),
    ])
    // W5's reorder writes every frame's present whole (index, skip and mins together)
    await fac.push([
      fac.patchOp('f1', { c: { present: { index: 2, mins: 10 } } }),
      fac.patchOp('f2', { c: { present: { index: 0, mins: 20 } } }),
      fac.patchOp('f3', { c: { present: { index: 1, mins: 10 } } }),
    ])
    // a skip, a recolour of an AI note, a re-tag, a move of a diagram node (its edge re-snapped by the room)
    await fac.push([
      fac.patchOp('f2', { c: { present: { index: 0, skip: true, mins: 25 } } }),
      fac.patchOp('n2', { g: { style: { backgroundColor: '#ffc9c9' } } }),
      fac.patchOp('d2', { g: { pos: { x: 6500, y: 100 } } }),
    ])
    await old.untilClock(fac.clock)
    expect(old.schemaErrors).toEqual([])
    await st.converged(b, [old, fac])
    // the rev-11 tab got the minutes in the `c` op of the stored frame (it parses those whole)
    expect(lobbyOf(old.confirmed.get('f2')).present).toEqual({ index: 0, skip: true, mins: 25 })
    expect(
      old.rawFrames.some(
        (f) => f.startsWith('{"type":"changes"') && f.includes('"k":"c"') && f.includes('"mins":25'),
      ),
    ).toBe(true)

    // the laser in use: the rev-11 tab's presence frames never carry `t` or `trail`, and it still gets the cursor
    for (const x of [100, 140, 180]) {
      fac.send(laserPresence(x))
      await sleep(120)
    }
    await old.until(
      () => old.of('presence').some((p) => p.peers.some((e) => e.pointer?.x === 180)),
      'the laser cursor',
    )
    expect(old.schemaErrors).toEqual([])
    for (const raw of old.rawFrames.filter((f) => f.startsWith('{"type":"presence"'))) {
      expect(raw).not.toContain('"t":')
      expect(raw).not.toContain('"trail":')
    }

    // away: minutes and a move written while the tab is gone come back in its catch-up (the welcome's `c` ops)
    const held = new Map(old.confirmed)
    const since = old.clock
    const epoch = old.epoch
    old.close()
    await old.untilClosed()
    await fac.push([
      fac.patchOp('f3', { c: { present: { index: 1, mins: 45 } } }),
      fac.patchOp('n2', { g: { pos: { x: 600, y: 600 } } }),
    ])
    await fac.push([fac.patchOp('f1', { c: { present: { mins: 3 } } })])
    const back = await rev11Tab(st, b, 'old-web', { tab: 'tab-old-web-2', since, epoch, confirmed: held })
    expect(back.welcome?.reset).toBe(false)
    expect(back.schemaErrors).toEqual([])
    await st.converged(b, [back, fac])
    expect(lobbyOf(back.confirmed.get('f3')).present).toEqual({ index: 1, mins: 45 })
    expect(back.confirmed.get('n2')?.x).toBe(600)

    // a fresh open of the deployed web: the reset snapshot, then live again
    const fresh = await rev11Tab(st, b, 'old-web-2')
    expect(fresh.welcome?.reset).toBe(true)
    await fac.push([fac.patchOp('f1', { c: { present: { index: 4, mins: 30 } } })])
    await fresh.untilClock(fac.clock)
    await back.untilClock(fac.clock)
    expect(fresh.schemaErrors).toEqual([])
    expect(back.schemaErrors).toEqual([])
    await st.converged(b, [fresh, back, fac])
  })

  it('its reorder, skip and auto-order keep the frame’s minutes, told in the ack’s fix; a rev-12 write without them clears them', async () => {
    const st = shared.get()
    const b = newBoardId()
    const fac = await rev12Tab(st, b, 'fac')
    await fac.create([
      frame('f1', { name: 'Warm-up', customData: { lobby: { present: { index: 0, mins: 7 } } } }),
    ])
    const old = await rev11Tab(st, b, 'old-web')
    // the deployed web's Frames panel writes `present` whole, as {index, skip} or null: it has never heard of mins
    const reorder = await old.patch('f1', { c: { present: { index: 2 } } })
    expect(reorder).toMatchObject({ ok: true, fix: { 'c:present': { index: 2, mins: 7 } } })
    expect(await storedLobby(st, b, 'f1')).toEqual({ present: { index: 2, mins: 7 } })
    expect((await old.patch('f1', { c: { present: { index: 2, skip: true } } })).ok).toBe(true)
    expect(await storedLobby(st, b, 'f1')).toEqual({ present: { index: 2, skip: true, mins: 7 } })
    // "Auto-order" with no skip mark removes the key: the index and the skip go, the minutes stay
    const auto = await old.patch('f1', { c: { present: null } })
    expect(auto).toMatchObject({ ok: true, fix: { 'c:present': { mins: 7 } } })
    expect(await storedLobby(st, b, 'f1')).toEqual({ present: { mins: 7 } })
    // the same write once more changes nothing (no new version), and is still told
    const v = (await st.stored(b, 'f1'))?.version
    expect(await old.patch('f1', { c: { present: null } })).toMatchObject({
      ok: true,
      fix: { 'c:present': { mins: 7 } },
    })
    expect((await st.stored(b, 'f1'))?.version).toBe(v)
    // a rev-12 tab's own write without the minutes is what it means: the stepper's "No time planned"
    await fac.untilClock(old.clock)
    expect(await fac.patch('f1', { c: { present: { index: 1 } } })).toMatchObject({ ok: true })
    expect(await storedLobby(st, b, 'f1')).toEqual({ present: { index: 1 } })
    await old.untilClock(fac.clock)
    expect(old.schemaErrors).toEqual([])
    await st.converged(b, [old, fac])
  })

  it('its create over a tombstone (bringing a deleted frame back whole) keeps the minutes the tombstone had', async () => {
    const st = shared.get()
    const b = newBoardId()
    const fac = await rev12Tab(st, b, 'fac')
    const f1 = frame('f1', { name: 'Warm-up', customData: { lobby: { present: { index: 0, mins: 9 } } } })
    await fac.create([f1])
    const old = await rev11Tab(st, b, 'old-web')
    const held = structuredClone(old.confirmed.get('f1') as El)
    expect((await old.patch('f1', { g: { life: { isDeleted: true } } })).ok).toBe(true)
    // the deployed web's own copy of the frame, as it knew it (its Frames panel never wrote mins): back whole
    const copy = { ...held, version: held.version + 2, customData: { lobby: { present: { index: 0 } } } }
    const back = await old.one({ k: 'c', el: copy })
    expect(back).toMatchObject({ ok: true, fix: { 'c:present': { index: 0, mins: 9 } } })
    expect(await storedLobby(st, b, 'f1')).toEqual({ present: { index: 0, mins: 9 } })
    // a rev-12 tab's own create over a tombstone writes what it says
    expect(
      (await fac.patch('f1', { g: { life: { isDeleted: true } }, pv: (await st.stored(b, 'f1'))?.version }))
        .ok,
    ).toBe(true)
    const again = { ...copy, version: copy.version + 4 }
    expect((await fac.one({ k: 'c', el: again })).ok).toBe(true)
    expect(await storedLobby(st, b, 'f1')).toEqual({ present: { index: 0 } })
    await old.untilClock(fac.clock)
    expect(old.schemaErrors).toEqual([])
    await st.converged(b, [old, fac])
  })

  it('a socket that names no revision but sends `t` reads and writes as rev 12 from then on', async () => {
    const st = shared.get()
    const b = newBoardId()
    const fac = await rev12Tab(st, b, 'fac')
    await fac.create([
      frame('f1', { name: 'Warm-up', customData: { lobby: { present: { index: 0, mins: 7 } } } }),
    ])
    // a rev-12 client whose connect URL lacks the revision (no rev-12 web sends none; the fallback)
    const quiet = await st.client({ boardId: b, user: 'quiet' })
    expect((await quiet.patch('f1', { c: { present: { index: 1 } } })).ok).toBe(true)
    expect(await storedLobby(st, b, 'f1')).toEqual({ present: { index: 1, mins: 7 } })
    quiet.send({ ...laserPresence(10), button: 'up', t: null, trail: undefined })
    await sleep(150)
    // now its minutes-less write clears them, and the room's patches with minutes reach it as patches
    expect((await quiet.patch('f1', { c: { present: { index: 1 } } })).ok).toBe(true)
    expect(await storedLobby(st, b, 'f1')).toEqual({ present: { index: 1 } })
    const before = quiet.rawFrames.length
    await fac.untilClock(quiet.clock)
    await fac.push([fac.patchOp('f1', { c: { present: { index: 1, mins: 9 } } })])
    await quiet.untilClock(fac.clock)
    const got = quiet.rawFrames.slice(before).filter((f) => f.startsWith('{"type":"changes"'))
    expect(got.some((f) => f.includes('"k":"p"') && f.includes('"mins":9'))).toBe(true)
    expect(PRESENCE_LASER_REV).toBe(12)
  })

  it('its edits of AI-made elements keep the provenance and run id; it cannot rewrite them (create-only, as before)', async () => {
    const st = shared.get()
    const b = newBoardId()
    const fac = await rev12Tab(st, b, 'fac')
    const [n1, n1t] = noteWithLabel('n1', 'idea', {
      customData: { lobby: { ai: { by: 'fac', run: RUN }, kind: 'ai-idea' } },
    })
    await fac.create([n1, n1t])
    const old = await rev11Tab(st, b, 'old-web')
    expect((await old.patch('n1', { g: { pos: { x: 500, y: 500 } } })).ok).toBe(true)
    expect(
      (await old.patch('n1', { g: { style: { backgroundColor: '#b2f2bb' } }, c: { 'tag:x': null } })).ok,
    ).toBe(true)
    expect(await storedLobby(st, b, 'n1')).toEqual({ ai: { by: 'fac', run: RUN }, kind: 'ai-idea' })
    // the deployed web's own AI writes carry `{by}` only; an edit that tries to change the provenance is refused
    expect(await old.patch('n1', { c: { ai: { by: 'old-web' } } })).toMatchObject({
      ok: false,
      code: 'INVALID',
    })
    expect(await storedLobby(st, b, 'n1')).toEqual({ ai: { by: 'fac', run: RUN }, kind: 'ai-idea' })
    await fac.untilClock(old.clock)
    expect(old.schemaErrors).toEqual([])
    await st.converged(b, [old, fac])
  })
})
