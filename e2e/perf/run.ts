// Lobby performance harness (docs/WAVE4-CONTRACTS.md §2 perf; checklist WRK-01, PRF-02, PRF-03).
//
//   pnpm --filter @draftroom/e2e perf                 # full run + budget check (non-zero exit on a regression)
//   node e2e/perf/run.ts --only latency --edits 300   # one part, more edits
//   node e2e/perf/run.ts --readable --profile         # unminified build + CPU profiles (hot spots)
//   node e2e/perf/run.ts --hold                        # seed, then keep the stack up (stop: create <out>/stop)
//   node e2e/perf/run.ts --attach <out>/state.json --rebuild   # measure a held stack with a fresh build
//
// What it does, all on this machine and over loopback:
//  1. builds the web app like the browser suites (vite build + vite preview, dev sign-in) and starts
//     the real api + sync + preview worker (e2e/tests/support/stack.ts) on E2E_PORT_BASE ports;
//  2. seeds the heavy board through the client: 20 frames, 4,500 sticky notes, 200 uploaded images
//     with their previews, tags on every 8th note and 40 comment threads (seed.ts);
//  3. edit visibility between two browser tabs, alice writing and bob watching, >= 200 edits per view,
//     at fit and at 100% (latency.ts), optionally with a third tab keeping the board busy;
//  4. pan frame rate in a fresh tab at fit and at 100%: rAF timing, a Chrome trace, optionally a CPU
//     profile (fps.ts); the review's 600 px sweep, plus a gentle 60 px pan at fit;
//  5. prints the WRK-01 / PRF-02 gates (pass/FAIL, informational), writes
//     e2e/test-results/perf-web-<port>/perf-<time>.json (+ .cpuprofile files with --profile, which
//     DevTools opens) and, with --budget, compares with e2e/perf/budget.json: exit 1 on a clear
//     regression, 2 when a miss was measured on a busy machine (inconclusive), 0 otherwise.
// Browser: branded Chrome, new headless mode, hardware GPU (the review's setup); --browser shell for
// Playwright's headless shell (software rendering: much lower frame rates, not comparable).
// The budgets hold for this PC (Threadripper 9970X, RTX 5090, Windows 11); set them again elsewhere.
// A run takes about 5 minutes (a minute and a half of it seeding: the api allows 120 uploads a minute).
//
// Options: --port-base N (default $E2E_PORT_BASE or 10900) --only latency|fps --edits N (default 240)
//   --reps N (default 3) --views fit,100 --busy N (updates/s from a third tab; default 0)
//   --pan-px 600[,..] --fit-pans 60[,..] ('' for none) --notes N --images N --frames N --comments N
//   --reuse-build --readable --profile --no-trace --budget --browser chrome|shell --hold
//   --attach <state.json> --rebuild
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { request } from '@playwright/test'
import { type FpsResult, type FpsView, fpsKey, measureFps, STANDARD_PAN_PX } from './fps.ts'
import { type LatencyResult, measureLatency, type View } from './latency.ts'
import { type BrowserKind, launchBrowser, openBoard, signedInContext, sleep } from './lib.ts'
import { HEAVY, type HeavyBoard, type HeavySpec, seedHeavyBoard } from './seed.ts'

const { values: args } = parseArgs({
  options: {
    'port-base': { type: 'string' },
    only: { type: 'string' },
    edits: { type: 'string', default: '240' },
    reps: { type: 'string', default: '3' },
    views: { type: 'string', default: 'fit,100' },
    busy: { type: 'string', default: '0' },
    notes: { type: 'string' },
    images: { type: 'string' },
    frames: { type: 'string' },
    comments: { type: 'string' },
    'reuse-build': { type: 'boolean', default: false },
    readable: { type: 'boolean', default: false },
    profile: { type: 'boolean', default: false },
    'no-trace': { type: 'boolean', default: false },
    'pan-px': { type: 'string' },
    'fit-pans': { type: 'string' },
    budget: { type: 'boolean', default: false },
    browser: { type: 'string', default: 'chrome' },
    hold: { type: 'boolean', default: false },
    attach: { type: 'string' },
    rebuild: { type: 'boolean', default: false },
  },
})

interface HeldState {
  portBase: string
  web: string
  outDir: string
  readable: boolean
  board: HeavyBoard
}

const attached: HeldState | null = args.attach ? JSON.parse(readFileSync(args.attach, 'utf8')) : null
process.env.E2E_PORT_BASE = attached?.portBase ?? args['port-base'] ?? process.env.E2E_PORT_BASE ?? '10900'
const { buildWeb, startPerfStack } = await import('./stack.ts')
const { Api } = await import('../tests/support/api.ts')
const { RUN_TAG } = await import('../tests/support/ports.ts')

const started = Date.now()
const log = (s: string) =>
  console.log(`[perf ${((Date.now() - started) / 1000).toFixed(0).padStart(4)} s] ${s}`)
const num = (v: string | undefined, fallback: number) => (v === undefined ? fallback : Number(v))
const spec: HeavySpec = {
  frames: num(args.frames, HEAVY.frames),
  notes: num(args.notes, HEAVY.notes),
  images: num(args.images, HEAVY.images),
  comments: num(args.comments, HEAVY.comments),
}
const views = (args.views ?? 'fit,100').split(',') as View[]
const only = args.only
const OUT_DIR = join(import.meta.dirname, '..', 'test-results', `perf-${RUN_TAG}`)
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
mkdirSync(OUT_DIR, { recursive: true })

if (attached && args.rebuild) buildWeb(attached.outDir, attached.readable, log)
const perf = attached
  ? { web: attached.web, outDir: attached.outDir, stop: async () => {} }
  : await startPerfStack({ reuseBuild: args['reuse-build'] ?? false, readable: args.readable ?? false, log })
const browser = await launchBrowser((args.browser ?? 'chrome') as BrowserKind)
const disposers: (() => Promise<unknown>)[] = []
let exitCode = 0
const shutdown = async () => {
  for (const d of disposers.splice(0).reverse()) await d().catch(() => {})
  await browser.close().catch(() => {})
  await perf.stop().catch(() => {})
}
process.once('SIGINT', () => void shutdown().then(() => process.exit(130)))

async function seed(web: string): Promise<HeavyBoard> {
  // alice signs in first: she owns Dev Studio (tests/support/users.ts); bob and carol edit the board.
  const alice = await Api.signIn({ request }, 'alice', 'Alice Park')
  disposers.push(() => alice.api.dispose())
  const bob = await Api.signIn({ request }, 'bob', 'Bob Chen')
  disposers.push(() => bob.api.dispose())
  const carol = await Api.signIn({ request }, 'carol', 'Carol Diaz')
  disposers.push(() => carol.api.dispose())
  const studio = alice.me.workspaces.find((w) => w.name === 'Dev Studio')
  if (studio?.role !== 'owner') throw new Error('alice must be the first user of a fresh stack')
  const created = await alice.api.createBoard(studio.id, 'Perf heavy board')
  await alice.api.putMember(created.id, bob.me.user.id, 'editor')
  await alice.api.putMember(created.id, carol.me.user.id, 'editor')
  const seedCtx = await signedInContext(browser, web, 'alice', 'Alice Park')
  const seedPage = await seedCtx.newPage()
  await openBoard(seedPage, web, created.id)
  const board = await seedHeavyBoard(seedPage, created.id, spec, log)
  await seedCtx.close()
  return board
}

try {
  const web = perf.web
  const board: HeavyBoard = attached?.board ?? (await seed(web))

  if (args.hold && !attached) {
    const stateFile = join(OUT_DIR, 'state.json')
    const stopFile = join(OUT_DIR, 'stop')
    rmSync(stopFile, { force: true })
    const state: HeldState = {
      portBase: process.env.E2E_PORT_BASE ?? '',
      web,
      outDir: perf.outDir,
      readable: args.readable ?? false,
      board,
    }
    writeFileSync(stateFile, JSON.stringify(state, null, 2))
    log(
      `holding: board ${web}/b/${board.boardId}; attach with --attach ${stateFile}; stop by creating ${stopFile}`,
    )
    while (!existsSync(stopFile)) await sleep(1000)
    rmSync(stopFile, { force: true })
    log('stop file seen')
  } else {
    const report: {
      at: string
      machine: Record<string, string | undefined>
      board: HeavyBoard
      open?: { ms: number }
      latency: LatencyResult[]
      fps: FpsResult[]
    } = {
      at: new Date().toISOString(),
      machine: { browser: args.browser, viewport: '1536x864 @1.25', node: process.version },
      board,
      latency: [],
      fps: [],
    }

    // ---- latency ---------------------------------------------------------------------------------
    if (!only || only === 'latency') {
      const { instrument } = await import('./latency.ts')
      const wCtx = await signedInContext(browser, web, 'alice', 'Alice Park')
      const oCtx = await signedInContext(browser, web, 'bob', 'Bob Chen')
      await instrument(wCtx)
      await instrument(oCtx)
      const writerPage = await wCtx.newPage()
      const observerPage = await oCtx.newPage()
      await openBoard(writerPage, web, board.boardId)
      await openBoard(observerPage, web, board.boardId)
      const busy = num(args.busy, 0)
      let busyPage: typeof writerPage | undefined
      if (busy > 0) {
        const bCtx = await signedInContext(browser, web, 'carol', 'Carol Diaz')
        busyPage = await bCtx.newPage()
        await openBoard(busyPage, web, board.boardId)
        disposers.push(() => bCtx.close())
      }
      const profile = args.profile
        ? { writer: await wCtx.newCDPSession(writerPage), observer: await oCtx.newCDPSession(observerPage) }
        : undefined
      for (const view of views) {
        report.latency.push(
          await measureLatency({
            writerPage,
            observerPage,
            writerName: 'alice',
            view,
            edits: num(args.edits, 240),
            busyPage,
            busyPerSecond: busy,
            profile,
            profileOut: (name) => join(OUT_DIR, `${stamp}-latency-${view}-${name}.cpuprofile`),
            log,
          }),
        )
      }
      await wCtx.close()
      await oCtx.close()
    }

    // ---- frame rate ------------------------------------------------------------------------------
    if (!only || only === 'fps') {
      const ctx = await signedInContext(browser, web, 'alice', 'Alice Park')
      const page = await ctx.newPage()
      const cdp = await ctx.newCDPSession(page)
      const openMs = await openBoard(page, web, board.boardId)
      report.open = { ms: openMs }
      log(`heavy board open (warm server, fresh tab): ${openMs} ms`)
      await page.waitForTimeout(3000)
      report.fps = await measureFps({
        page,
        cdp,
        views: views as FpsView[],
        reps: num(args.reps, 3),
        durationMs: 3000,
        panPx: (args['pan-px'] ?? String(STANDARD_PAN_PX)).split(',').map(Number),
        // a gentle pan at fit too: the board's edges stay in view (no culling churn), what a composited
        // shapes layer is for (apps/web/src/board/pan-layer.ts)
        fitPans: args['fit-pans'] === '' ? [] : (args['fit-pans'] ?? '60').split(',').map(Number),
        trace: !args['no-trace'],
        profile: args.profile ?? false,
        profileOut: (view) => join(OUT_DIR, `${stamp}-pan-${view}.cpuprofile`),
        log,
      })
      await ctx.close()
    }

    const file = join(OUT_DIR, `perf-${stamp}.json`)
    writeFileSync(file, JSON.stringify(report, null, 2))
    log(`results: ${file}`)

    // ---- the gates (informational) and the budget (--budget) --------------------------------------
    for (const l of report.latency)
      log(
        `gate WRK-01 (edit visible p95 <= 250 ms), ${l.view}: ${l.visible.p95} ms ${l.visible.p95 <= 250 ? 'pass' : 'FAIL'}`,
      )
    for (const f of report.fps.filter((r) => r.view === 'fit' && r.panPx === STANDARD_PAN_PX))
      log(`gate PRF-02 (>= 30 fps panning at fit): ${f.medianFps} fps ${f.medianFps >= 30 ? 'pass' : 'FAIL'}`)
    if (args.budget) {
      const outcome = checkBudget(report.latency, report.fps)
      if (outcome !== 'ok') exitCode = outcome === 'regression' ? 1 : 2
    }
  }
} catch (e) {
  exitCode = 1
  console.error(e)
} finally {
  await shutdown()
}
process.exit(exitCode)

/**
 * Compares the run with e2e/perf/budget.json. Budgets sit near the measured numbers of the committed
 * code on this PC; a result fails only beyond the margin (a clear regression, not noise). A failure
 * measured while the whole machine was busier than `maxMachineBusyPct` (other programs) is reported as
 * inconclusive instead (exit 2): run again on a quieter machine.
 */
function checkBudget(latency: LatencyResult[], fps: FpsResult[]): 'ok' | 'regression' | 'inconclusive' {
  const budget = JSON.parse(readFileSync(join(import.meta.dirname, 'budget.json'), 'utf8')) as {
    margin: number
    maxMachineBusyPct: number
    latencyVisibleP95Ms: Record<string, number>
    editingTabMinFps: Record<string, number>
    panMedianFps: Record<string, number>
  }
  const failures: { what: string; busy: boolean }[] = []
  const check = (
    what: string,
    value: number,
    limit: number | undefined,
    kind: 'max' | 'min',
    busyPct: number,
  ) => {
    if (limit === undefined) return
    const allowed = kind === 'max' ? limit * (1 + budget.margin) : limit * (1 - budget.margin)
    const ok = kind === 'max' ? value <= allowed : value >= allowed
    const busy = busyPct > budget.maxMachineBusyPct
    log(
      `budget ${what}: ${value} (budget ${limit}, fails ${kind === 'max' ? 'above' : 'below'} ${Math.round(allowed * 10) / 10}; machine ${busyPct}% busy) ${ok ? 'ok' : busy ? 'FAIL (machine busy: inconclusive)' : 'FAIL'}`,
    )
    if (!ok) failures.push({ what: `${what} ${value}`, busy })
  }
  for (const l of latency) {
    if (l.seen < l.edits * 0.98)
      failures.push({ what: `latency ${l.view}: only ${l.seen}/${l.edits} edits seen`, busy: false })
    check(
      `latency ${l.view} visible p95 ms`,
      l.visible.p95,
      budget.latencyVisibleP95Ms[l.view],
      'max',
      l.machineBusyPct,
    )
    check(`editing tab ${l.view} fps`, l.writerFps, budget.editingTabMinFps[l.view], 'min', l.machineBusyPct)
  }
  for (const f of fps)
    check(`pan ${fpsKey(f)} median fps`, f.medianFps, budget.panMedianFps[fpsKey(f)], 'min', f.machineBusyPct)
  if (!failures.length) {
    log('perf budget: all within budget')
    return 'ok'
  }
  const clear = failures.filter((f) => !f.busy)
  log(
    `PERF BUDGET ${clear.length ? 'FAILED' : 'INCONCLUSIVE (machine busy)'}: ${failures.map((f) => f.what).join('; ')}`,
  )
  return clear.length ? 'regression' : 'inconclusive'
}
