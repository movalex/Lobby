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
import { type ChildProcess, spawn } from 'node:child_process'
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
import { frameCounts, type WireTap, wiretap } from '../support/wiretap.ts'

test.skip(
  !process.env.SPIKE_B9_WS,
  "set SPIKE_B9_WS=1 (quiet window, SPIKE_B_PORT_BASE=7895) to run B9's workstation half",
)
test.setTimeout(45 * 60_000)

const EDITS = Number(process.env.SPIKE_B9_EDITS ?? 30)
const LOAD_MS = Number(process.env.SPIKE_B9_LOAD_MS ?? 5 * 60_000)
/** 200 as the check is written (A14's heavy board); fewer only for a diagnostic run, which is never evidence */
const IMAGES = Number(process.env.SPIKE_B9_IMAGES ?? 200)
/** SPIKE_B9_LOAD=0: the same two browsers with no L2 running (a diagnostic control, never evidence) */
const WITH_LOAD = process.env.SPIKE_B9_LOAD !== '0'
const REPO = join(import.meta.dirname, '..', '..', '..')

let stack: O3Stack
let owner: DevUser
let A: O3BrowserProcess
let B: O3BrowserProcess
let heavy: SeededBoard
let tapA: WireTap
let tapB: WireTap
/** the L2 load process while it runs (killed in afterAll if the test stops early: nothing is left running) */
let child: ChildProcess | null = null
let loadOut: string | null = null

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
  // a passive tap on both board sockets (no hop, no timing change): what a missed edit is diagnosed from
  tapA = await wiretap(A.page)
  tapB = await wiretap(B.page)
  heavy = await seedHeavy(stack, owner, {
    images: IMAGES,
    members: [
      { user: A.user, role: 'editor' },
      { user: B.user, role: 'editor' },
    ],
    log: (s) => console.log(`[B9 ws] ${s}`),
  })
})
test.afterAll(async () => {
  if (child && child.exitCode === null) child.kill()
  child = null
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

/** Everything both pages and the server know about `target` after A's write of `x` at `sentAt` (ids, numbers). */
async function diagnose(boardId: string, target: string, x: number, sentAt: number) {
  const snap = await harness.readSnapshot(stack, boardId)
  const stored = snap.elements.find((e) => e.id === target) as { x?: number; version?: number } | undefined
  const side = async (p: O3BrowserProcess, tap: WireTap) => ({
    page: await p.page
      .evaluate((id) => {
        // O2's debug handle (the spike board page, behind the dev-auth guard) and O3's facade
        const b = (window as unknown as { __lobbyBoard?: unknown }).__lobbyBoard as
          | {
              core?: {
                clock: number
                confirmed(id: string): { x?: number; version?: number } | undefined
                dirtyIds?(): string[]
                unsentIds?(): string[]
              }
              session?: { snapshot?: { phase?: string } }
            }
          | undefined
        const core = b?.core
        const local = window.lobbyCanvas?.get(id) as { x?: number; version?: number } | null | undefined
        return {
          phase: b?.session?.snapshot?.phase ?? null,
          clock: core?.clock ?? null,
          confirmed: { x: core?.confirmed(id)?.x ?? null, version: core?.confirmed(id)?.version ?? null },
          local: { x: local?.x ?? null, version: local?.version ?? null },
          dirty: core?.dirtyIds?.().includes(id) ?? null,
          unsent: core?.unsentIds?.().includes(id) ?? null,
          dirtyCount: core?.dirtyIds?.().length ?? null,
          save: window.lobbyCanvas?.saveState() ?? null,
        }
      }, target)
      .catch((e) => ({ error: String(e).slice(0, 200) })),
    sockets: tap.sockets(),
    framesSinceWrite: frameCounts(tap.frames({ after: sentAt })),
    mentioningTarget: tap.frames({ after: sentAt - 2_000, mentions: target }),
    lastFrameIn: tap.frames({ dir: 'in' }).at(-1) ?? null,
    boardLog: (await tap.boardLog()).filter((e) => e.at >= sentAt - 120_000).slice(-40),
  })
  return {
    x,
    sentAt,
    at: Date.now(),
    server: {
      clock: snap.clock,
      horizon: snap.horizon,
      x: stored?.x ?? null,
      version: stored?.version ?? null,
    },
    A: await side(A, tapA),
    B: await side(B, tapB),
  }
}

/**
 * Where one edit's time went, ms after A's `update` (A's page clock): A's push leaving (the core's
 * coalescing), A's ack, the `changes` frame reaching B, B's apply (the facade's `changed` with the value)
 * and B's paint (two frames later). The frame times are when the test process got the CDP WebSocket
 * events for them, so they carry that event path's lag: an upper bound for each stage, not an exact one.
 */
interface Timeline {
  readonly aPushMs: number | null
  readonly aAckMs: number | null
  readonly bChangesMs: number | null
  readonly appliedMs: number
  readonly paintedMs: number
}
interface ViewResult {
  samples: number[]
  discarded: number
  zoom: number
  timelines: Timeline[]
  lostLocal: { edit: number; diag: unknown }[]
}

function timeline(target: string, sentAt: number, w: { appliedAt: number; paintedAt: number }): Timeline {
  const push = tapA.frames({ after: sentAt, dir: 'out', type: 'push', mentions: target })[0]
  const ack =
    push?.seq === undefined
      ? undefined
      : tapA.frames({ after: sentAt, dir: 'in', type: 'ack' }).find((f) => f.seq === push.seq)
  const bIn = tapB.frames({ after: sentAt, dir: 'in', type: 'changes', mentions: target })[0]
  const rel = (t: number | undefined) => (t === undefined ? null : t - sentAt)
  return {
    aPushMs: rel(push?.at),
    aAckMs: rel(ack?.at),
    bChangesMs: rel(bIn?.at),
    appliedMs: w.appliedAt - sentAt,
    paintedMs: w.paintedAt - sentAt,
  }
}

function stageSummary(ts: readonly Timeline[]) {
  const keys = ['aPushMs', 'aAckMs', 'bChangesMs', 'appliedMs', 'paintedMs'] as const
  return Object.fromEntries(
    keys.map((k) => [k, summarize(ts.map((t) => t[k]).filter((v): v is number => v !== null))]),
  )
}

test('B9 workstation: A→B edit visibility at 100% and at fit while a local L2 runs', async () => {
  const testInfo = test.info()
  const boardId = heavy.boardId
  let childLog = ''
  let childDone: Promise<number | null> = Promise.resolve(null)
  if (WITH_LOAD) {
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
    loadOut = outFile
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
    const c = spawn(
      process.execPath,
      [join(REPO, 'e2e/load/run-plans.ts'), '--job', jobFile, '--out', outFile],
      {
        cwd: REPO,
        env: { ...process.env, O3_INTERNAL_SECRET: stack.internalSecret },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    child = c
    c.stdout?.on('data', (d) => {
      childLog += String(d)
    })
    c.stderr?.on('data', (d) => {
      childLog += String(d)
    })
    childDone = new Promise<number | null>((r) => c.once('exit', (code) => r(code)))
  }

  // the two browsers; the note A moves is in frame 0, which no load editor owns (plan.ts)
  await A.openBoard(boardId)
  await B.openBoard(boardId)
  const target = heavy.board.frame0Notes[0] as string
  await sleep(20_000) // the load's join ramp and first edits
  const results: Record<string, ViewResult> = {}
  const evidence = (extra: Record<string, unknown>) =>
    writeEvidence(testInfo, WITH_LOAD ? 'B9-workstation' : 'B9-workstation-noload', {
      boardId,
      elements: heavy.board.elements.length,
      images: IMAGES,
      withLoad: WITH_LOAD,
      seed: heavy.seed,
      uploadMs: heavy.uploadMs,
      samples: results,
      ...extra,
    })
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
    const r: ViewResult = { samples: [], discarded: 0, zoom: 0, timelines: [], lostLocal: [] }
    results[view] = r
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
      let w: Awaited<typeof watch>
      try {
        w = await watch
      } catch (e) {
        // B never showed A's write: record what each side and the server hold
        const diag = await diagnose(boardId, target, x, sentAt)
        const aPushed = tapA.frames({ after: sentAt, dir: 'out', type: 'push', mentions: target }).length > 0
        if (!aPushed && diag.A.page && 'local' in diag.A.page && diag.A.page.local.x !== x) {
          // A's own scene lost the edit before anything was pushed (the core's apply of a remote
          // `changes` overwrote it before Excalidraw reported it: b9-probe-lost-edit.spec.ts). A real
          // engine failure, counted and reported; the measurement goes on with the next edit.
          r.lostLocal.push({ edit: i, diag })
          console.log(
            `[B9 ws] edit ${i} at ${view}: LOST in A before any push (A's x ${diag.A.page.local.x}, not ${x})`,
          )
          continue
        }
        const file = evidence({ missed: { view, edit: i, diag }, loadLog: childLog.slice(-4_000) })
        throw new Error(
          `B never showed A's edit ${i} at ${view} within 20 s (${String(e).slice(0, 120)}); diagnosis in ${file}: ${JSON.stringify(
            { server: diag.server, A: diag.A.page, B: diag.B.page, Bframes: diag.B.framesSinceWrite },
          ).slice(0, 1_500)}`,
        )
      }
      if (w.already) r.discarded++
      else r.samples.push(w.paintedAt - sentAt)
      r.timelines.push(timeline(target, sentAt, w))
      await sleep(500)
    }
    r.zoom = (await canvasOf(B.page).viewport()).zoom
  }
  const code = WITH_LOAD ? await Promise.race([childDone, sleep(LOAD_MS + 120_000).then(() => null)]) : 0
  if (code === null) child?.kill()
  child = null
  const load =
    WITH_LOAD && code === 0 && loadOut
      ? (JSON.parse(readFileSync(loadOut, 'utf8')) as { report: unknown }).report
      : null
  const summary = Object.fromEntries(
    Object.entries(results).map(([v, r]) => [
      v,
      {
        ...summarize(r.samples),
        discarded: r.discarded,
        lostLocal: r.lostLocal.length,
        zoom: r.zoom,
        stages: stageSummary(r.timelines),
      },
    ]),
  )
  const lost = Object.values(results).reduce((n, r) => n + r.lostLocal.length, 0)
  evidence({
    visibility: summary,
    lostLocal: lost,
    frames: { A: frameCounts(tapA.frames()), B: frameCounts(tapB.frames()) },
    loadExit: code,
    loadReport: load,
    loadLog: childLog.slice(-4_000),
  })
  console.log(`[B9 ws] visibility ${JSON.stringify(summary)}`)
  expect(code, `the L2 load process: ${childLog.slice(-800)}`).toBe(0)
  expect(lost, "A's local edits lost before any push (O2's engine core; b9-probe-lost-edit)").toBe(0)
  const p95 = (summary['100%'] as { p95: number }).p95
  expect(p95, 'A→B visibility p95 at 100% zoom with L2 running (§8.5 gate)').toBeLessThanOrEqual(250)
})
