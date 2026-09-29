// O3's probe for the B9 workstation failure (not a §8.3 check; opt-in SPIKE_B_PROBES=1): a LOCAL edit made
// in the Excalidraw scene is lost, with nothing pushed, when a remote `changes` frame is applied before
// Excalidraw has reported the edit through `onChange`.
//
// Found with the wiretap on B9's run (e2e/spike-b/tests/b9-visibility.spec.ts, SPIKE_B_RUN=diag1): A's
// facade `update(N, {x})` under L2 was followed by no push at all, A's scene held the old `x` again, the
// core had nothing dirty, and B (rightly) never saw the edit. The mechanism, as the core reads (O2's
// apps/web/src/canvas/sync/core/engine.ts): `onChanges` → `applyScene` builds the WHOLE element array
// from `this.currentOrder`, the scene as the core last scanned it, and installs it with `scene.apply`
// (updateScene). Excalidraw calls `onChange` after React commits the update (componentDidUpdate), not
// inside `updateScene`, so a WebSocket message that lands in between makes the core overwrite the
// un-scanned local edit with its stale copy; the scan that follows sees its own apply and finds nothing.
//
// The probe: A (one editor) moves note N through the facade 40 times, (1) with no other writer (control),
// (2) while a remote writer moves another note R at 50 Hz (its own session, raw socket). For every edit it
// records, inside A's page: N's x right after `update` and 1.5 s later, whether a push carried the edit,
// and whether a remote apply (the core's `applied` event) ran between the `update` and the core's next
// scan (`onSceneChange`). Pass: no edit lost in either phase. Each lost edit names the race it hit.
import { expect, test } from '@playwright/test'
import type { O3BrowserProcess } from '../support/browsers.ts'
import { writeEvidence } from '../support/checks.ts'
import { canvasOf, closeAllBrowsers, harness, waitSaved } from '../support/harness.ts'
import { remoteWriter } from '../support/perf.ts'
import type { O3Stack } from '../support/stack.ts'

test.skip(!process.env.SPIKE_B_PROBES, 'set SPIKE_B_PROBES=1 to run O3 probes')
test.setTimeout(10 * 60_000)

const EDITS = Number(process.env.SPIKE_B_PROBE_EDITS ?? 40)
let stack: O3Stack
let A: O3BrowserProcess
let boardId: string

test.beforeAll(async () => {
  stack = await harness.startStack()
  const owner = harness.devUser('A')
  ;({ boardId } = await stack.createBoard({ owner, title: 'O3 lost-edit probe' }))
  A = await harness.launchBrowser(stack, owner, { name: 'A', relay: false })
  await A.openBoard(boardId)
})
test.afterAll(async () => {
  await closeAllBrowsers()
  await stack?.stop()
})

interface EditResult {
  readonly x: number
  readonly localNow: number | null
  readonly localLater: number | null
  readonly pushed: boolean
  /** remote applies between the `update` and the core's next scan */
  readonly appliesBeforeScan: number
  /** ms from the `update` to the core's next scan (Excalidraw's onChange) */
  readonly scanAfterMs: number | null
}

/** One facade edit of `id` to `x` in A's page, observed there (see the header). */
async function edit(id: string, x: number): Promise<EditResult> {
  return A.page.evaluate(
    async ({ id, x }) => {
      const core = (
        window as unknown as {
          __lobbyBoard: {
            core: {
              onSceneChange(s: unknown): void
              on(l: (e: { kind: string }) => void): () => void
            }
          }
        }
      ).__lobbyBoard.core
      let applies = 0
      let scanned: number | null = null
      const t0 = performance.now()
      const off = core.on((e) => {
        if (e.kind === 'applied' && scanned === null) applies++
      })
      const orig = core.onSceneChange
      core.onSceneChange = function (this: unknown, s: unknown) {
        if (scanned === null) scanned = performance.now() - t0
        return orig.call(this, s)
      }
      try {
        window.lobbyCanvas?.update(id, { x })
        const localNow = (window.lobbyCanvas?.get(id)?.x as number | undefined) ?? null
        await new Promise((r) => setTimeout(r, 1_500))
        const localLater = (window.lobbyCanvas?.get(id)?.x as number | undefined) ?? null
        const pushed = (window.lobbyCanvas?.pushedOps() ?? []).some((p) =>
          p.ops.some(
            (o) => o.k === 'p' && o.id === id && (o as { g?: { pos?: { x?: number } } }).g?.pos?.x === x,
          ),
        )
        return {
          x,
          localNow,
          localLater,
          pushed,
          appliesBeforeScan: applies,
          scanAfterMs: scanned === null ? null : Math.round(scanned * 10) / 10,
        }
      } finally {
        off()
        core.onSceneChange = orig
      }
    },
    { id, x },
  )
}

test('probe: a local edit survives a remote apply that lands before Excalidraw reports it', async () => {
  const testInfo = test.info()
  const c = canvasOf(A.page)
  const N = await c.create('note', { x: 0, y: 0, text: 'N' })
  const R = await c.create('note', { x: 600, y: 0, text: 'R' })
  await waitSaved(A.page)
  const phases: Record<string, EditResult[]> = {}
  for (const phase of ['control', 'remote writer 50 Hz'] as const) {
    const w = phase === 'control' ? null : await remoteWriter(stack, A.user, boardId, R, 50)
    const out: EditResult[] = []
    for (let i = 0; i < EDITS; i++) {
      out.push(await edit(N, 100 + (phase === 'control' ? 0 : 1000) + i * 3))
      await waitSaved(A.page).catch(() => undefined)
    }
    const ws = await w?.stop()
    phases[phase] = out
    const lost = out.filter((r) => r.localNow === r.x && r.localLater !== r.x && !r.pushed)
    console.log(
      `[probe lost-edit] ${phase}: ${lost.length}/${out.length} lost; applies before the scan in ${out.filter((r) => r.appliesBeforeScan > 0).length} edits (${lost.filter((r) => r.appliesBeforeScan > 0).length} of the lost); writer ${ws ? `${ws.acked} acked` : 'none'}`,
    )
  }
  const summary = Object.fromEntries(
    Object.entries(phases).map(([p, out]) => {
      const lost = out.filter((r) => r.localNow === r.x && r.localLater !== r.x && !r.pushed)
      return [
        p,
        {
          edits: out.length,
          lost: lost.length,
          raced: out.filter((r) => r.appliesBeforeScan > 0).length,
          lostRaced: lost.filter((r) => r.appliesBeforeScan > 0).length,
          scanAfterMs: out.map((r) => r.scanAfterMs),
        },
      ]
    }),
  )
  writeEvidence(testInfo, 'B9-probe-lost-edit', { summary, phases })
  for (const [p, s] of Object.entries(summary))
    expect(s.lost, `${p}: local edits lost with nothing pushed (${JSON.stringify(s)})`).toBe(0)
})
