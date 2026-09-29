// B9, the workstation half (docs/EXCALIDRAW-MIGRATION.md §8.3 B9, §8.5 "edit visibility p95 ≤ 250 ms at
// 100% zoom in two browsers with L2 running"): a local stack at 7895, the heavy board seeded through the
// real protocol (200 real uploads, 9,220 elements), e2e/load's L2 profile against it from the
// workstation in its own Node process (30 headless sessions on O2's engine core with real api tickets,
// 10 editors at 20 remote edits/s in total), and two separate Chromium processes measuring A→B edit
// visibility: A moves a note through the facade, B's paint watch (the second animation frame after the
// change is applied) gives the time, 30 edits at 100% zoom and 30 at Lobby's whole-board fit. The local
// sync is not CPU-limited, so this is the client-side number; the NAS's headless visibility under L2 is
// reported next to it (B9.md).
//
// Opt-in and timing-gated: SPIKE_B9_WS=1, SPIKE_B_PORT_BASE=7895, only in the lead's quiet window; 3 runs
// (SPIKE_B_RUN=1..3). Browsers: spike A14's headless shell with its GPU flags, 1536x864 at DPR 1.25, no
// socket relay (it would add a hop). Needs M2 (O2's headless client, O1's room, O5's A1 file-refs).
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { buildPlans, probeSids } from '../../load/plan.ts'
import { L2 } from '../../load/profiles.ts'
import { summarize } from '../../load/stats.ts'
import type { LoadUser } from '../../load/tickets.ts'
import { DPR, GPU_ARGS, VIEWPORT } from '../../spike/fixtures/perf-kit.ts'
import type { O3BrowserProcess } from '../support/browsers.ts'
import { RUN, writeEvidence } from '../support/checks.ts'
import { canvasOf, closeAllBrowsers, harness } from '../support/harness.ts'
import { apiTicket, type SeededBoard, seedHeavy } from '../support/seed.ts'
import type { O3Stack } from '../support/stack.ts'
import type { DevUser } from '../support/types.ts'

test.skip(
  !process.env.SPIKE_B9_WS,
  "set SPIKE_B9_WS=1 (quiet window, SPIKE_B_PORT_BASE=7895) to run B9's workstation half",
)
test.setTimeout(45 * 60_000)

const EDITS = Number(process.env.SPIKE_B9_EDITS ?? 30)
const LOAD_MS = Number(process.env.SPIKE_B9_LOAD_MS ?? 5 * 60_000)
const REPO = join(import.meta.dirname, '..', '..', '..')

let stack: O3Stack
let owner: DevUser
let A: O3BrowserProcess
let B: O3BrowserProcess
let heavy: SeededBoard

const opts = (name: string) => ({
  name,
  relay: false,
  args: [...GPU_ARGS],
  viewport: VIEWPORT,
  deviceScaleFactor: DPR,
})
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

test.beforeAll(async () => {
  stack = await harness.startStack()
  owner = harness.devUser('Owner')
  A = await harness.launchBrowser(stack, harness.devUser('A'), opts('A'))
  B = await harness.launchBrowser(stack, harness.devUser('B'), opts('B'))
  heavy = await seedHeavy(stack, owner, {
    members: [
      { user: A.user, role: 'editor' },
      { user: B.user, role: 'editor' },
    ],
    log: (s) => console.log(`[B9 ws] ${s}`),
  })
})
test.afterAll(async () => {
  await closeAllBrowsers()
  await stack?.stop()
})

/**
 * L2's 30 sessions as real dev users, in plan order: each signs in, the board's owner grants its role, and
 * its api ticket is fetched last (tickets are valid 60 s; the sessions join within the 10 s ramp).
 */
async function loadUsers(boardId: string): Promise<{ order: LoadUser[]; tickets: Map<string, string> }> {
  const board = L2.boards[0]
  if (!board) throw new Error('L2 has no board')
  const ownerApi = (await stack.api(owner)).api
  const devs: { dev: DevUser; user: LoadUser }[] = []
  let n = 0
  for (const g of board.groups)
    for (let i = 0; i < g.count; i++, n++) {
      const dev = harness.devUser(`l2${g.role[0]}${n}`)
      const { me } = await stack.api(dev)
      await ownerApi.putMember(boardId, me.user.id, g.role)
      devs.push({ dev, user: { uid: me.user.id, name: dev.name, color: '#1971c2', role: g.role } })
    }
  const tickets = new Map<string, string>()
  for (const d of devs) tickets.set(d.user.uid, (await apiTicket(stack, d.dev, boardId)).ticket)
  return { order: devs.map((d) => d.user), tickets }
}

test('B9 workstation: A→B edit visibility at 100% and at fit while a local L2 runs', async () => {
  const testInfo = test.info()
  const boardId = heavy.boardId
  const { order, tickets } = await loadUsers(boardId)
  let k = 0
  const plans = buildPlans(
    { ...L2, joinRampMs: 10_000 },
    new Map([[boardId, heavy.board]]),
    { ticket: (_b, user) => tickets.get(user.uid) as string },
    {
      idsOf: [{ load: L2.boards[0] as (typeof L2.boards)[number], ids: [boardId] }],
      userFor: () => order[k++] as LoadUser,
    },
  )
  const dir = join(testInfo.project.outputDir, 'o3', 'b9-ws')
  mkdirSync(dir, { recursive: true })
  const jobFile = join(dir, `job-${RUN}.json`)
  const outFile = join(dir, `load-${RUN}.json`)
  writeFileSync(
    jobFile,
    JSON.stringify({
      profileName: 'L2',
      syncHttpUrl: stack.ports.syncUrl,
      boardSpecs: [heavy.board.spec],
      plans,
      probeSids: [...probeSids(plans).entries()],
      durationMs: LOAD_MS,
    }),
  )
  // the L2 load in its own Node process (it never shares a thread with the test runner)
  const child = spawn(
    process.execPath,
    [join(REPO, 'e2e/load/run-plans.ts'), '--job', jobFile, '--out', outFile],
    {
      cwd: REPO,
      env: { ...process.env, O3_INTERNAL_SECRET: stack.internalSecret },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let childLog = ''
  child.stdout?.on('data', (d) => {
    childLog += String(d)
  })
  child.stderr?.on('data', (d) => {
    childLog += String(d)
  })
  const childDone = new Promise<number | null>((r) => child.once('exit', (code) => r(code)))

  // the two browsers; the note A moves is in frame 0, which no load editor owns (plan.ts)
  await A.openBoard(boardId)
  await B.openBoard(boardId)
  const target = heavy.board.frame0Notes[0] as string
  await sleep(20_000) // the load's join ramp and first edits
  const results: Record<string, { samples: number[]; discarded: number; zoom: number }> = {}
  for (const view of ['100%', 'fit'] as const) {
    for (const p of [A, B]) {
      const c = canvasOf(p.page)
      if (view === 'fit') await c.fit()
      else {
        const el = await c.get(target)
        await c.setViewport({ x: (el?.x as number) - 300, y: (el?.y as number) - 200, zoom: 1 })
      }
    }
    await sleep(2_000)
    const base = (await canvasOf(A.page).get(target))?.x as number
    const samples: number[] = []
    let discarded = 0
    for (let i = 0; i < EDITS; i++) {
      const x = base + (i % 2 === 0 ? 7 + i : -(7 + i))
      const watch = canvasOf(B.page).watch({ id: target, field: 'x', value: x }, 20_000)
      await sleep(50) // B's watch is armed before A writes
      const sentAt = await A.page.evaluate(
        ({ id, x }) => {
          const t = Date.now()
          window.lobbyCanvas?.update(id, { x })
          return t
        },
        { id: target, x },
      )
      const w = await watch
      if (w.already) discarded++
      else samples.push(w.paintedAt - sentAt)
      await sleep(500)
    }
    results[view] = { samples, discarded, zoom: (await canvasOf(B.page).viewport()).zoom }
  }
  const code = await Promise.race([childDone, sleep(LOAD_MS + 120_000).then(() => null)])
  if (code === null) child.kill()
  const load = code === 0 ? (JSON.parse(readFileSync(outFile, 'utf8')) as { report: unknown }).report : null
  const summary = Object.fromEntries(
    Object.entries(results).map(([v, r]) => [
      v,
      { ...summarize(r.samples), discarded: r.discarded, zoom: r.zoom },
    ]),
  )
  writeEvidence(testInfo, 'B9-workstation', {
    boardId,
    elements: heavy.board.elements.length,
    seed: heavy.seed,
    uploadMs: heavy.uploadMs,
    visibility: summary,
    samples: results,
    loadExit: code,
    loadReport: load,
    loadLog: childLog.slice(-4_000),
  })
  expect(code, `the L2 load process: ${childLog.slice(-800)}`).toBe(0)
  const p95 = (summary['100%'] as { p95: number }).p95
  expect(p95, 'A→B visibility p95 at 100% zoom with L2 running (§8.5 gate)').toBeLessThanOrEqual(250)
})
