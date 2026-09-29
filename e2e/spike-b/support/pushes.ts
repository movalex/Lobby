// The B10 push recorder (docs/EXCALIDRAW-MIGRATION.md §8.3 B10, §8.6.2): `recordPushes(target)` starts a
// log of what a receiving-only browser (through the facade's `pushedOps()`) or headless client (its
// core's `pushLog()`) pushes from now on. Every owner's spec records its receiving-only clients with it
// and writes the result with `writePushEvidence`; O3's `b10-aggregate.ts` collects those files into B10's
// evidence.
//
// `count()` is the number of PUSHES (a doc-only push counts), `ops()` their ops flattened in order,
// `byElement(id)` the ops naming `id` (a create's `el.id` or a patch's `id`). A page that reloads starts a
// new push log: the recorder keeps what it last read from the old page and adds the new page's pushes.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page, TestInfo } from '@playwright/test'
import type { PushRecord } from '../../../apps/web/src/canvas/sync/types.ts'
import type { Op } from '../../../packages/canvas-schema/src/protocol.ts'
import type { PushLog, PushTarget } from './types.ts'

export interface O3PushLog extends PushLog {
  /** the push records themselves (seq, base, at, ops, doc) */
  records(): Promise<readonly PushRecord[]>
  readonly target: string
}

const opId = (op: Op): string => (op.k === 'c' ? op.el.id : op.id)

const isPage = (t: PushTarget): t is Page => typeof (t as Page).evaluate === 'function'

interface PageLogState {
  installedAt: number | null
  records: PushRecord[]
}

async function readPage(page: Page): Promise<PageLogState> {
  return page.evaluate(() => {
    const f = window.lobbyCanvas
    const h = (window as unknown as { __lobbyHarness?: { installedAt: number } }).__lobbyHarness
    return { installedAt: h?.installedAt ?? null, records: f ? f.pushedOps() : [] }
  })
}

/** Starts recording `target`'s pushes (the ones after this call). */
export async function recordPushes(target: PushTarget): Promise<O3PushLog> {
  if (!isPage(target)) {
    const base = target.pushLog().length
    const records = async () => target.pushLog().slice(base)
    return logOf(target.name, records)
  }
  const page = target
  const start = await readPage(page)
  let instance = start.installedAt
  let skip = start.records.length
  const carried: PushRecord[] = [] // what earlier page instances pushed after the start
  let lastSeen: PushRecord[] = []
  const records = async () => {
    const now = await readPage(page)
    if (now.installedAt !== instance) {
      // the page reloaded (or the facade was reinstalled): keep the old instance's pushes as last read
      carried.push(...lastSeen)
      instance = now.installedAt
      skip = 0
    }
    lastSeen = now.records.slice(skip)
    return [...carried, ...lastSeen]
  }
  return logOf(`page ${page.url()}`, records)
}

function logOf(target: string, records: () => Promise<readonly PushRecord[]>): O3PushLog {
  const ops = async () => (await records()).flatMap((r) => r.ops)
  return {
    target,
    records,
    count: async () => (await records()).length,
    ops,
    byElement: async (id) => (await ops()).filter((op) => opId(op) === id),
  }
}

/** One receiving-only client's pushes in one test, as B10 aggregates them. */
export interface PushEvidence {
  readonly spec: string
  readonly test: string
  readonly retry: number
  readonly repeatEachIndex: number
  readonly receiver: string
  readonly pushes: number
  readonly ops: number
  /** op ids and kinds only (never element content) */
  readonly opSummary: { k: string; id: string }[]
  readonly at: string
}

/** The folder B10's evidence files go to: e2e/test-results/<run tag>/b10/ (or SPIKE_B10_DIR). */
export function pushEvidenceDir(testInfo: TestInfo): string {
  return process.env.SPIKE_B10_DIR ?? join(testInfo.project.outputDir, 'b10')
}

/** Writes one receiver's push log for this test (B10); returns the evidence it wrote. */
export async function writePushEvidence(
  testInfo: TestInfo,
  receiver: string,
  log: PushLog,
): Promise<PushEvidence> {
  const ops = await log.ops()
  const evidence: PushEvidence = {
    spec: testInfo.file.split(/[\\/]/).slice(-1)[0] ?? testInfo.file,
    test: testInfo.titlePath.slice(1).join(' > '),
    retry: testInfo.retry,
    repeatEachIndex: testInfo.repeatEachIndex,
    receiver,
    pushes: await log.count(),
    ops: ops.length,
    opSummary: ops.map((op) => ({ k: op.k, id: opId(op) })),
    at: new Date().toISOString(),
  }
  const dir = pushEvidenceDir(testInfo)
  mkdirSync(dir, { recursive: true })
  const safe =
    `${evidence.spec}--${evidence.test}--${receiver}--r${testInfo.retry}-i${testInfo.repeatEachIndex}`
      .replace(/[^A-Za-z0-9._-]+/g, '_')
      .slice(0, 180)
  writeFileSync(join(dir, `${safe}-${Date.now()}.json`), JSON.stringify(evidence, null, 2))
  return evidence
}
