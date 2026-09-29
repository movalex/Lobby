// §8.4 "Client": `updateScene` ms at 5k and 20k elements, the `onChange` diff at 20k, and the index pre-pass
// on the apply path, each with the board's deleted elements in the scene array (revision 3.4: every
// client holds the server's tombstones), including a run at 20k live plus 10,000 deleted. Each number
// names its live and deleted counts.
//
// How: boards of 2,500 and 10,000 notes (5k and 20k elements, a label each), and the 10,000-note board with
// 10,000 tombstones, seeded through the real protocol; the measuring page opens each; a remote writer
// (its own session) makes 20 edits (the apply path: updateScene with NEVER, the pre-pass) and the page
// makes 20 local edits through the facade (onChange and its diff). The per-call times are O2's adapter
// timings, read as Performance measures named `lobby.updateScene`, `lobby.onChange` and `lobby.prepass`
// (the names O3 asked O2 to emit; O3 cannot time inside the adapter). Without them the spec FAILS and the
// numbers are "not measured" — never estimated. Next to them, O3's own end-to-end numbers: remote push
// sent → the page's `changed` event → the change painted (the facade's change log).
//
// Opt-in, timing-gated: SPIKE_PERF=1, SPIKE_B_PORT_BASE=7885, the quiet window; 3 runs. Needs M1.
import { expect, test } from '@playwright/test'
import { summarize } from '../../load/stats.ts'
import { DPR, GPU_ARGS, VIEWPORT } from '../../spike/fixtures/perf-kit.ts'
import type { O3BrowserProcess } from '../support/browsers.ts'
import { writeEvidence } from '../support/checks.ts'
import { canvasOf, harness } from '../support/harness.ts'
import { remoteWriter } from '../support/perf.ts'
import { type SeededBoard, seedNotes } from '../support/seed.ts'
import type { O3Stack } from '../support/stack.ts'
import type { DevUser } from '../support/types.ts'

test.skip(
  !process.env.SPIKE_PERF,
  'set SPIKE_PERF=1 (quiet window, SPIKE_B_PORT_BASE=7885) for the §8.4 numbers',
)
test.setTimeout(60 * 60_000)
// no Playwright trace or screenshots while measuring (a trace's screencast and snapshots add main-thread work);
// o3-measure.sh runs spike A's tldraw baseline with --trace off too, so both engines are measured the same way
test.use({ trace: 'off', screenshot: 'off' })

const MEASURES = ['lobby.updateScene', 'lobby.onChange', 'lobby.prepass'] as const
let stack: O3Stack
let owner: DevUser
let M: O3BrowserProcess
const boards: { name: string; live: number; deleted: number; seeded: SeededBoard }[] = []

test.beforeAll(async () => {
  stack = await harness.startStack()
  owner = harness.devUser('Perf')
  for (const [name, notes, deleted] of [
    ['5k', 2_500, 0],
    ['20k', 10_000, 0],
    ['20k+10k deleted', 10_000, 10_000],
  ] as const) {
    const seeded = await seedNotes(stack, owner, {
      notes,
      frames: Math.ceil(notes / 225),
      deleted,
      title: `O3 ${name}`,
    })
    boards.push({ name, live: seeded.board.elements.filter((e) => !e.isDeleted).length, deleted, seeded })
  }
  M = await harness.launchBrowser(stack, owner, {
    name: 'M',
    relay: false,
    args: [...GPU_ARGS],
    viewport: VIEWPORT,
    deviceScaleFactor: DPR,
  })
})
test.afterAll(async () => {
  await M?.close()
  await stack?.stop()
})

test('§8.4: updateScene, onChange diff and the pre-pass at 5k / 20k / 20k + 10k deleted', async () => {
  const testInfo = test.info()
  const out = []
  for (const b of boards) {
    await M.openBoard(b.seeded.boardId)
    const c = canvasOf(M.page)
    await c.measures(true)
    // 20 remote edits: the apply path
    const note = b.seeded.board.frame0Notes[3] as string
    const after = (await M.page.evaluate(() => window.__lobbyHarness?.changes().at(-1)?.seq ?? 0)) as number
    const w = await remoteWriter(stack, owner, b.seeded.boardId, note, 2)
    await M.page.waitForTimeout(10_500)
    const ws = await w.stop()
    const log = await M.page.evaluate((after) => window.__lobbyHarness?.changes(after) ?? [], after)
    const e2e: number[] = []
    for (const [s, sent] of ws.sentAt) {
      void s
      const hit = log.find((e) => e.ids.includes(note) && e.at >= sent)
      if (hit?.paintedAt) e2e.push(hit.paintedAt - sent)
    }
    // 20 local edits through the facade: onChange and its diff
    const local = b.seeded.board.frame0Notes[5] as string
    const x0 = (await c.get(local))?.x as number
    for (let i = 0; i < 20; i++) {
      await c.update(local, { x: x0 + (i % 2 ? 9 : -9) })
      await M.page.waitForTimeout(150)
    }
    const measures = await c.measures(true)
    const by = Object.fromEntries(
      MEASURES.map((n) => [n, summarize(measures.filter((m) => m.name === n).map((m) => m.duration))]),
    )
    out.push({
      board: b.name,
      live: b.live,
      deleted: b.deleted,
      lobbyMeasures: by,
      applyEndToEndMs: summarize(e2e),
      writer: { pushes: ws.pushes, acked: ws.acked, ackMs: summarize(ws.ackMs) },
    })
    console.log(
      `[perf-client] ${b.name} (${b.live} live, ${b.deleted} deleted): ${JSON.stringify(by)}; apply end to end ${JSON.stringify(summarize(e2e))}`,
    )
  }
  writeEvidence(testInfo, 'perf-client', { rows: out })
  for (const r of out)
    for (const n of MEASURES)
      expect(
        (r.lobbyMeasures as Record<string, { n: number }>)[n]?.n,
        `${n} measures on ${r.board} (O2's adapter instrumentation; without it the number is not measured)`,
      ).toBeGreaterThan(0)
})
