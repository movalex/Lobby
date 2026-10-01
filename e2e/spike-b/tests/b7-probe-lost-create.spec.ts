// O5's probe behind B7's mood-board failure (docs/research/excalidraw/spike-b/B7.md, "Lost creates"): a
// create made through CanvasPort.transact (the facade's `create`, O5's `placeFile`, tags, +1, mind maps)
// must never vanish. It is installed with `api.updateScene`; the engine core learns of it only from
// Excalidraw's next `onChange` (a React commit, scheduled). A server message (an ack of an earlier push,
// or `changes`) handled in that window makes the core install `applyScene`'s array, built from the scene
// as of its LAST scan (`currentOrder`), so the new element is dropped from the scene before any scan saw
// it: never pushed, never stored, and the tab still says Saved (sync/core/engine.ts applyScene, onAck,
// onChanges; O2's).
//
// One Chromium process, one editor, no other writer: 400 rectangles through the facade with 0-25 ms gaps,
// so acks of earlier pushes interleave with later creates. Pass: every create is still in the scene, every
// one was pushed, every one is stored, and the tab is Saved with no reject.
// Evidence: B7.md. Not a B-check of its own; the owner of the fix is O2.
import { expect, test } from '@playwright/test'
import { harness } from '../support/harness.ts'
import { stackFromEnv } from '../support/ports.ts'
import type { BrowserProcess, SpikeBStack } from '../support/types.ts'
import { featuresReady, saved } from './b7-b12-kit.ts'

const CREATES = Number(process.env.SPIKE_B7_PROBE_CREATES ?? 400)
let stack: SpikeBStack
let A: BrowserProcess
let boardId: string

test.afterAll(async () => {
  await A?.close()
  await stack?.stop()
})

test(`${CREATES} creates through CanvasPort.transact, acks interleaved: none is lost`, async () => {
  test.setTimeout(5 * 60_000)
  stack = await harness.startStack({ base: stackFromEnv().base })
  const alice = harness.devUser('b7p-alice')
  ;({ boardId } = await stack.createBoard({ owner: alice, members: [] }))
  A = await harness.launchBrowser(stack, alice, { name: 'A' })
  // time every inbound frame of the board socket (the window the probe reports)
  await A.page.addInitScript(() => {
    const w = window as unknown as { __wsIn: number[] }
    w.__wsIn = []
    const Orig = window.WebSocket
    class Traced extends Orig {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        this.addEventListener('message', () => w.__wsIn.push(performance.now()))
      }
    }
    window.WebSocket = Traced as typeof WebSocket
  })
  await A.openBoard(boardId)
  await featuresReady(A.page)
  const pushes = await harness.recordPushes(A.page)
  const made = await A.page.evaluate(async (n) => {
    const f = window.lobbyCanvas
    if (!f) throw new Error('no facade')
    const out: { id: string; t: number }[] = []
    for (let i = 0; i < n; i++) {
      const t = performance.now()
      const id = f.create('rectangle', {
        x: (i % 20) * 60,
        y: 900 + Math.floor(i / 20) * 60,
        width: 40,
        height: 40,
      })
      out.push({ id, t })
      await new Promise((r) => setTimeout(r, Math.random() * 25))
    }
    await new Promise((r) => setTimeout(r, 1500))
    const inbound = (window as unknown as { __wsIn: number[] }).__wsIn
    return out.map((m, i) => {
      const next = out[i + 1]?.t ?? m.t + 100
      return {
        id: m.id,
        present: !!f.get(m.id),
        framesBeforeNext: inbound.filter((x) => x >= m.t && x < next).length,
        gapMs: Math.round(next - m.t),
      }
    })
  }, CREATES)
  await saved(A.page)
  const save = await A.page.evaluate(() => window.lobbyCanvas?.saveState())
  const stored = new Set((await harness.readSnapshot(stack, boardId)).elements.map((e) => e.id))
  const vanished = made.filter((m) => !m.present)
  const neverPushed: string[] = []
  for (const m of made) if ((await pushes.byElement(m.id)).length === 0) neverPushed.push(m.id)
  const notStored = made.filter((m) => !stored.has(m.id)).map((m) => m.id)
  console.log(
    'B7-PROBE lost-create',
    JSON.stringify({
      creates: made.length,
      withInboundFrameBeforeNextCreate: made.filter((m) => m.framesBeforeNext > 0).length,
      vanished: vanished.length,
      vanishedDetail: vanished.slice(0, 10),
      neverPushed: neverPushed.length,
      notStored: notStored.length,
      save,
    }),
  )
  expect
    .soft(
      vanished.map((m) => m.id),
      'creates gone from the scene',
    )
    .toEqual([])
  expect.soft(neverPushed, 'creates never pushed').toEqual([])
  expect.soft(notStored, 'creates not stored').toEqual([])
  expect(save?.state).toBe('saved')
})
