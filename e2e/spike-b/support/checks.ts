// What every check does around its action (docs/EXCALIDRAW-MIGRATION.md §8.1): read the test snapshot's
// `horizon` at the start; at the end compare every browser's and client's map, tombstones included, with
// the test snapshot through hash.ts, run the invariant checker on the snapshot, and refuse a check whose
// horizon moved (a compaction purge in the window: re-run, never counted). Plus the per-run evidence file
// each check writes (numbers only, never board content) under the run's output folder.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, type TestInfo } from '@playwright/test'
import { canvasOf } from './facade.ts'
import { checkInvariants, converged, explainDivergence, type HashTarget, readSnapshot } from './snapshot.ts'
import type { BrowserProcess, ConvergenceReport, SpikeBStack } from './types.ts'

/** Which of the check's 3 runs this is (SPIKE_B_RUN=1|2|3; each run is its own invocation with a fresh build). */
export const RUN = process.env.SPIKE_B_RUN ?? '0'

export interface CheckWindow {
  readonly horizonAtStart: number
  readonly startedAt: number
}

export async function openWindow(stack: SpikeBStack, boardId: string): Promise<CheckWindow> {
  const snap = await readSnapshot(stack, boardId)
  return { horizonAtStart: snap.horizon, startedAt: Date.now() }
}

export class HorizonMoved extends Error {
  constructor() {
    super('the horizon moved inside the check window (a compaction purge): the check is invalid and re-run')
  }
}

/**
 * Asserts convergence (every target equal to the snapshot, tombstones included) and 0 invariant
 * violations; throws HorizonMoved if the window saw a purge. Returns the report for the evidence.
 */
export async function closeWindow(
  stack: SpikeBStack,
  boardId: string,
  targets: readonly HashTarget[],
  window: CheckWindow,
  opts: { timeoutMs?: number } = {},
): Promise<ConvergenceReport> {
  const report = await converged(stack, boardId, targets, {
    horizonAtStart: window.horizonAtStart,
    timeoutMs: opts.timeoutMs ?? 30_000,
  })
  if (report.horizonMoved) throw new HorizonMoved()
  if (!report.ok) {
    const browsers = targets.filter((t): t is BrowserProcess => 'page' in t)
    const why = await explainDivergence(report, browsers)
    throw new Error(
      `not converged: ${JSON.stringify(report.hashes)} vs snapshot ${report.snapshot.hash}; ${JSON.stringify(why).slice(0, 2_000)}`,
    )
  }
  const inv = checkInvariants(report.snapshot)
  expect(inv.violations, 'invariant violations on the test snapshot').toEqual([])
  return report
}

/** Retries `fn` when it throws HorizonMoved (at most `max` extra attempts); other errors pass through. */
export async function unlessHorizonMoved<T>(fn: () => Promise<T>, max = 2): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn()
    } catch (e) {
      if (!(e instanceof HorizonMoved) || i >= max) throw e
    }
  }
}

/** Writes this run's evidence for a check: <output>/o3/<check>/run-<RUN>-<n>.json (numbers only). */
export function writeEvidence(testInfo: TestInfo, check: string, data: unknown): string {
  const dir = join(testInfo.project.outputDir, 'o3', check)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `run-${RUN}-${Date.now()}.json`)
  writeFileSync(
    file,
    JSON.stringify(
      { check, run: RUN, test: testInfo.titlePath.slice(1).join(' > '), at: new Date().toISOString(), data },
      null,
      1,
    ),
  )
  return file
}

/** Waits until every page shows Saved (§2.5.7). */
export async function allSaved(browsers: readonly BrowserProcess[], timeout = 30_000): Promise<void> {
  await Promise.all(
    browsers.map((b) =>
      b.page.waitForFunction(() => window.lobbyCanvas?.saveState().state === 'saved', undefined, {
        timeout,
        polling: 50,
      }),
    ),
  )
}

/** Waits until `id` exists (live) in every page. */
export async function everywhere(
  browsers: readonly BrowserProcess[],
  id: string,
  timeout = 30_000,
): Promise<void> {
  await Promise.all(
    browsers.map((b) =>
      b.page.waitForFunction((id) => window.lobbyCanvas?.get(id)?.isDeleted === false, id, {
        timeout,
        polling: 50,
      }),
    ),
  )
}

/** The screen point of an element's centre in a page. */
export async function centreOf(b: BrowserProcess, id: string): Promise<{ x: number; y: number }> {
  const c = canvasOf(b.page)
  const bounds = await c.bounds(id)
  if (!bounds) throw new Error(`no bounds for ${id}`)
  return c.sceneToScreen({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 })
}
