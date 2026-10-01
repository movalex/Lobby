// The load generator's run (docs/EXCALIDRAW-MIGRATION.md §8.3 B9, §2.13): the fake api, the boards, the
// sessions, the scrapes, the readback and the report. The CLI is run.ts; specs (B9's workstation half,
// B11) call runLoad directly.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { join } from 'node:path'
import { TEST_HOOK_PATHS, TestSnapshot } from '../../packages/canvas-schema/src/protocol.ts'
import type { GeneratedBoard } from './boards.ts'
import { type FakeApi, startFakeApi } from './fake-api.ts'
import { FakeRoom, fakeClient } from './fakes/fake-room.ts'
import { loadHeadlessFactory } from './headless.ts'
import { startScraper } from './metrics.ts'
import { boardsOf, buildPlans, membersOf, probeSids, signedTickets } from './plan.ts'
import { type Profile, sessionCount } from './profiles.ts'
import { buildReport, type FinalCheck, type HostSample, type RunReport, reportMarkdown } from './report.ts'
import { runInThread, runInWorkers, type ThreadResult } from './runner.ts'
import { openNodeSocket, seedElements } from './seed.ts'
import type { ClientFactory, SessionReport } from './session.ts'
import { thinClientFactory } from './thin.ts'
import { loadUser, mintTicket, type RunSecrets } from './tickets.ts'

export interface LoadRunOptions {
  readonly profile: Profile
  readonly syncHttpUrl: string
  readonly secrets: RunSecrets
  readonly apiListen?: { host: string; port: number }
  readonly seed: 'file' | 'push' | 'none'
  readonly threads: number
  /** each load worker's old-generation cap (MB); none by default */
  readonly workerHeapMb?: number
  readonly durationMs?: number
  readonly tag: string
  readonly out: string | null
  readonly hostSamples?: string
  /** an in-memory room instead of sync (the plumbing dry run) */
  readonly fake?: boolean
  readonly log?: (line: string) => void
  readonly stopped?: () => boolean
  /**
   * The conversion-under-load run (§8.3 B9): at `atMs` (default minute 5) a joiner opens each of these
   * unconverted tldraw boards (gen-boards --cul): a lazy conversion, a second that must queue behind it,
   * and the planted over-cap board whose worker must be terminated while every room keeps serving.
   */
  readonly cul?: { readonly atMs?: number; readonly boards?: readonly string[] }
  /** written with the run start (epoch ms) as soon as it is fixed: the NAS script kills sync at t0 + 8 min */
  readonly t0File?: string
  /** the NAS script's kill file (line 1: epoch ms of docker kill, line 2: when docker start returned) */
  readonly killFile?: string
}

/** One poll of sync's GET /internal/migrate/status while the conversion-under-load joiners wait. */
export interface CulStatusSample {
  /** ms since the run start */
  readonly t: number
  readonly running: string | null
  readonly queued: readonly string[]
  readonly boards: readonly {
    boardId: string
    state: string
    reason?: string
    ms?: number
    capMb?: number
    peakHeapUsedMb?: number
  }[]
}

export interface ConversionReport {
  readonly joins: readonly CulJoin[]
  /** the status polls whose content changed (every 500 ms from the joins until they all settle) */
  readonly timeline: readonly CulStatusSample[]
  readonly final: CulStatusSample | null
  readonly runtimeCapMb: number | null
  /** a poll saw the second board queued while the first ran */
  readonly secondQueuedBehindFirst: boolean
  /** ms the second board waited in the queue (from its first queued poll to its first running poll) */
  readonly secondQueueWaitMs: number | null
  /** the conversion window (ms since the run start): from the joins to the last one settled */
  readonly servingWindow: { readonly from: number; readonly to: number } | null
  /** boards with editors that had a 10 s window overlapping the conversion window without any ack */
  readonly boardsWithIdleWindows: readonly { boardId: string; idleWindows: number; windows: number }[]
  /** boards with editors checked, and the 10 s windows overlapping the conversion window */
  readonly servingBoards: number
  readonly servingWindows: number
}

export const CUL_BOARDS = ['cul-heavy', 'cul-second', 'cul-overcap'] as const

export interface CulJoin {
  readonly boardId: string
  readonly startedAt: number
  readonly welcomedAt: number | null
  readonly elements: number | null
  readonly error: string | null
}

let lastRuntimeCapMb: number | null = null

async function pollMigrateStatus(o: LoadRunOptions, t0: number): Promise<CulStatusSample | null> {
  try {
    const res = await fetch(`${o.syncHttpUrl}/internal/migrate/status`, {
      headers: { 'x-draftroom-internal': o.secrets.internalSecret },
      signal: AbortSignal.timeout(5_000),
    })
    if (res.status !== 200) {
      await res.body?.cancel()
      return null
    }
    const b = (await res.json()) as {
      running?: string | null
      queued?: string[]
      boards?: CulStatusSample['boards']
      runtimeCapMb?: number
    }
    lastRuntimeCapMb = b.runtimeCapMb ?? lastRuntimeCapMb
    return {
      t: Date.now() - t0,
      running: b.running ?? null,
      queued: b.queued ?? [],
      boards: (b.boards ?? []).map((x) => ({
        boardId: x.boardId,
        state: x.state,
        ...(x.reason !== undefined ? { reason: x.reason } : {}),
        ...(x.ms !== undefined ? { ms: x.ms } : {}),
        ...(x.capMb !== undefined ? { capMb: x.capMb } : {}),
        ...(x.peakHeapUsedMb !== undefined ? { peakHeapUsedMb: x.peakHeapUsedMb } : {}),
      })),
    }
  } catch {
    return null
  }
}

/** One joiner of a not-yet-converted board: waits (up to 10 min) for its welcome and snapshot. */
async function culJoin(o: LoadRunOptions, boardId: string, i: number): Promise<CulJoin> {
  const startedAt = Date.now()
  try {
    const sock = await openNodeSocket(
      o.syncHttpUrl,
      boardId,
      mintTicket(o.secrets.ticketSecret, boardId, seeder(50 + i)),
      `load-cul-${i}`,
      600_000,
    )
    const snap = sock.welcome.reset ? await sock.snapshot(600_000) : null
    const welcomedAt = Date.now()
    sock.close()
    return {
      boardId,
      startedAt,
      welcomedAt,
      elements: snap?.elements.length ?? sock.welcome.catchUp?.length ?? 0,
      error: null,
    }
  } catch (e) {
    return {
      boardId,
      startedAt,
      welcomedAt: null,
      elements: null,
      error: (e instanceof Error ? e.message : String(e)).slice(0, 200),
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitHealthy(syncHttpUrl: string, timeoutMs = 60_000): Promise<void> {
  const end = Date.now() + timeoutMs
  for (;;) {
    try {
      const r = await fetch(`${syncHttpUrl}/healthz`, { signal: AbortSignal.timeout(2_000) })
      await r.body?.cancel()
      if (r.status === 200) return
    } catch {}
    if (Date.now() > end) throw new Error(`sync at ${syncHttpUrl} is not healthy after ${timeoutMs} ms`)
    await sleep(500)
  }
}

/** The seeder's identity on every board (an editor the fake api knows). */
const seeder = (i: number) => loadUser(900 + i, 0, 'editor')

async function prepareBoards(
  o: LoadRunOptions,
  boards: Map<string, GeneratedBoard>,
  log: (l: string) => void,
) {
  let i = 0
  for (const [id, b] of boards) {
    const s = seeder(i++)
    const ticket = mintTicket(o.secrets.ticketSecret, id, s)
    const sock = await openNodeSocket(o.syncHttpUrl, id, ticket, `load-seed-${i}`)
    try {
      if (o.seed === 'push') {
        const r = await seedElements(sock, b.elements, sock.welcome.clock)
        log(
          `seeded ${id}: ${r.ok}/${r.ops} ops in ${r.pushes} pushes, ${r.ms} ms, rejected ${JSON.stringify(r.rejected)}`,
        )
        if (r.ok !== r.ops)
          throw new Error(`seeding ${id}: ${r.ops - r.ok} ops rejected (${r.rejectedIds.join(', ')})`)
      } else if (o.seed === 'file') {
        const snap = sock.welcome.reset ? await sock.snapshot() : null
        const n = snap ? snap.elements.length : (sock.welcome.catchUp?.length ?? 0)
        if (n !== b.elements.length)
          throw new Error(
            `board ${id}: sync serves ${n} elements, gen-boards wrote ${b.elements.length} (run gen-boards first, or --seed push)`,
          )
        log(`board ${id}: ${n} elements served`)
      }
    } finally {
      sock.close()
    }
  }
}

async function readBack(o: LoadRunOptions, boards: Map<string, GeneratedBoard>): Promise<FinalCheck> {
  const stored = new Map<string, Record<string, unknown>>()
  let method = 'test snapshot'
  for (const id of boards.keys()) {
    const res = await fetch(`${o.syncHttpUrl}${TEST_HOOK_PATHS.snapshot(id)}`, {
      headers: { 'x-draftroom-internal': o.secrets.internalSecret },
      signal: AbortSignal.timeout(30_000),
    }).catch(() => null)
    if (res && res.status === 200) {
      for (const el of TestSnapshot.parse(await res.json()).elements)
        stored.set(el.id, el as Record<string, unknown>)
      continue
    }
    await res?.body?.cancel()
    method = 'a fresh reader (welcome snapshot)'
    try {
      const sock = await openNodeSocket(
        o.syncHttpUrl,
        id,
        mintTicket(o.secrets.ticketSecret, id, seeder(0)),
        `load-read-${id}`,
      )
      const snap = sock.welcome.reset ? await sock.snapshot() : null
      for (const el of snap?.elements ?? []) stored.set(el.id, el as Record<string, unknown>)
      for (const op of sock.welcome.catchUp ?? [])
        if (op.k === 'c') stored.set(op.el.id, op.el as Record<string, unknown>)
      sock.close()
    } catch {
      return { stored: null, method: 'no readback' }
    }
  }
  return { stored, method }
}

function readHostSamples(path: string | undefined, t0: number): HostSample[] {
  if (!path) return []
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as HostSample & { at?: number })
      .map((h) => ({ ...h, t: h.at !== undefined ? h.at - t0 : h.t }))
  } catch {
    return []
  }
}

export async function runLoad(o: LoadRunOptions): Promise<RunReport> {
  const log = o.log ?? ((l: string) => console.log(`[load] ${l}`))
  const profile = { ...o.profile, durationMs: o.durationMs ?? o.profile.durationMs }
  const boards = boardsOf(profile)
  const plans = buildPlans(profile, boards, signedTickets(o.secrets.ticketSecret))
  const probes = probeSids(plans)
  log(
    `${profile.name}: ${boards.size} boards, ${plans.length} sessions (${sessionCount(profile)} planned), ${profile.durationMs / 1000} s`,
  )

  let api: FakeApi | null = null
  let room: FakeRoom | null = null
  let createClient: ClientFactory
  if (o.fake) {
    room = new FakeRoom([...boards.values()].flatMap((b) => b.elements as never[]))
    const r = room
    createClient = (opts) => fakeClient(r, opts)
  } else {
    api = await startFakeApi({ internalSecret: o.secrets.internalSecret, ...o.apiListen })
    const members = membersOf(plans)
    let i = 0
    for (const [id, b] of boards) {
      const m = members.get(id) ?? new Map()
      m.set(seeder(i).uid, 'editor')
      m.set(seeder(0).uid, 'editor')
      api.addBoard(id, m, b.files)
      if (o.cul)
        for (const [k, c] of (o.cul.boards ?? CUL_BOARDS).entries())
          api.addBoard(c, [[seeder(50 + k).uid, 'editor']])
      i++
    }
    log(`fake api on ${api.url}`)
    await waitHealthy(o.syncHttpUrl)
    if (o.seed !== 'none') await prepareBoards(o, boards, log)
    createClient = await loadHeadlessFactory()
  }

  const culAt = o.cul?.atMs ?? Math.min(5 * 60_000, Math.floor((o.durationMs ?? o.profile.durationMs) / 2))
  const timeline: CulStatusSample[] = []
  let culFrom: number | null = null
  let culTo: number | null = null
  const culRuns: Promise<CulJoin[]> =
    o.cul && !o.fake
      ? sleep(2_000 + culAt).then(async () => {
          const t0c = Date.now() - culAt
          culFrom = Date.now()
          let done = false
          const polling = (async () => {
            let last = ''
            while (!done) {
              const p = await pollMigrateStatus(o, t0c)
              if (p) {
                const sig = JSON.stringify([
                  p.running,
                  p.queued,
                  p.boards.map((b) => [b.boardId, b.state, b.reason]),
                ])
                if (sig !== last) timeline.push(p)
                last = sig
              }
              await sleep(500)
            }
            const p = await pollMigrateStatus(o, t0c)
            if (p) timeline.push(p)
          })()
          const joins = await Promise.all((o.cul?.boards ?? CUL_BOARDS).map((b, i) => culJoin(o, b, i)))
          culTo = Date.now()
          done = true
          await polling
          return joins
        })
      : Promise.resolve([])
  const scraper = o.fake
    ? null
    : startScraper(o.syncHttpUrl, o.secrets.internalSecret, profile.metricsEveryMs)
  const t0 = Date.now() + 2_000
  if (o.t0File) writeFileSync(o.t0File, `${t0}\n`)
  const run = {
    profile,
    boards,
    plans,
    syncHttpUrl: o.syncHttpUrl,
    t0,
    durationMs: profile.durationMs,
    probeSids: probes,
    reconnectAfterMs: 5_000,
    stopped: o.stopped,
    ...(o.fake ? {} : { createThinClient: thinClientFactory }),
  }
  let results: ThreadResult[]
  if (o.threads > 0 && !o.fake)
    results = await runInWorkers(
      {
        profileName: profile.name,
        plans,
        syncHttpUrl: o.syncHttpUrl,
        t0,
        durationMs: profile.durationMs,
        probeSids: [...probes.entries()],
        reconnectAfterMs: 5_000,
        stopped: o.stopped,
        workerHeapMb: o.workerHeapMb,
      },
      o.threads,
    )
  else results = [await runInThread(run, createClient)]
  const cul = await culRuns
  const endedAt = Date.now()
  const kill = readKillFile(o.killFile)
  const scrapes = scraper ? await scraper.stop() : []
  const final: FinalCheck = o.fake
    ? {
        stored: new Map([...(room as FakeRoom).elements].map(([k, v]) => [k, v as Record<string, unknown>])),
        method: 'the fake room',
      }
    : await readBack(o, boards)
  await api?.close()
  const report = buildReport(
    {
      profile: profile.name,
      startedAt: t0,
      endedAt,
      sync: o.fake ? 'fake room (in memory)' : o.syncHttpUrl,
      sessions: plans.length,
      node: process.version,
      cpus: availableParallelism(),
      threads: o.fake ? 0 : o.threads,
      killAt: kill ? kill.killAt : profile.killAtMs === null ? null : t0 + profile.killAtMs,
      killMeasured: kill !== null,
      restartedAt: kill?.startedAt ?? null,
      joinRampMs: profile.joinRampMs,
      notes: [
        ...(o.fake ? ['PLUMBING DRY RUN on an in-memory room: no number here is a measurement of sync'] : []),
        ...(api ? [`fake api calls: ${JSON.stringify(api.counts)}`] : []),
        ...cul.map(
          (c) =>
            `conversion under load: ${c.boardId} ${c.welcomedAt ? `served ${c.elements} elements after ${c.welcomedAt - c.startedAt} ms` : `not served: ${c.error}`}`,
        ),
      ],
      clientLoopDelayP99Ms: results.map((r) => r.loopDelayP99Ms),
      clientThreads: results.map((r) => ({
        loopP99Ms: r.loopDelayP99Ms,
        loopMaxMs: r.loopDelayMaxMs,
        rssMB: r.memory?.rssMB,
        heapUsedMB: r.memory?.heapUsedMB,
        heapTotalMB: r.memory?.heapTotalMB,
        sessions: r.sessions ?? r.reports.length,
        fullCores: r.fullCores ?? r.reports.filter((s) => !s.thin).length,
      })),
    },
    results.flatMap((r) => r.reports),
    scrapes,
    readHostSamples(o.hostSamples, t0),
    final,
  )
  const conversion =
    o.cul && !o.fake
      ? conversionReport(
          cul,
          timeline,
          culFrom,
          culTo,
          t0,
          results.flatMap((r) => r.reports),
        )
      : undefined
  const full: RunReport = conversion ? { ...report, conversion } : report
  if (o.out) {
    mkdirSync(o.out, { recursive: true })
    const base = join(o.out, `${profile.name}-${o.tag}`)
    writeFileSync(`${base}.json`, JSON.stringify({ report: full, scrapes }, null, 1))
    writeFileSync(`${base}.md`, reportMarkdown(full))
    log(`report: ${base}.json / .md`)
  }
  return full
}

function readKillFile(path: string | undefined): { killAt: number; startedAt: number | null } | null {
  if (!path) return null
  try {
    const [a, b] = readFileSync(path, 'utf8')
      .split('\n')
      .map((l) => Number(l.trim()))
    return a && Number.isFinite(a) ? { killAt: a, startedAt: b && Number.isFinite(b) ? b : null } : null
  } catch {
    return null
  }
}

function conversionReport(
  joins: readonly CulJoin[],
  timeline: readonly CulStatusSample[],
  from: number | null,
  to: number | null,
  t0: number,
  sessions: readonly SessionReport[],
): ConversionReport {
  const [first, second] = CUL_BOARDS
  const stateOf = (p: CulStatusSample, id: string) => p.boards.find((b) => b.boardId === id)?.state
  const behind = timeline.some((p) => p.running === first && p.queued.includes(second))
  const q = timeline.find((p) => p.queued.includes(second) || stateOf(p, second) === 'queued')
  const r = timeline.find((p) => p.running === second || stateOf(p, second) === 'running')
  // every board with editors must keep getting acks in each 10 s window that overlaps the conversion window
  // (the window the joins open until the last job settles; a fast conversion still covers one window)
  const window = from !== null && to !== null ? { from: from - t0, to: to - t0 } : null
  const idle: { boardId: string; idleWindows: number; windows: number }[] = []
  let windows = 0
  if (window) {
    const lo = Math.floor(window.from / 10_000)
    const hi = Math.floor(window.to / 10_000)
    windows = Math.max(0, hi - lo + 1)
    const byBoard = new Map<string, Record<number, number>>()
    for (const s of sessions) {
      if (s.pushes === 0) continue
      const m = byBoard.get(s.boardId) ?? {}
      for (const [w, n] of Object.entries(s.ackWindows ?? {})) m[Number(w)] = (m[Number(w)] ?? 0) + n
      byBoard.set(s.boardId, m)
    }
    for (const [boardId, m] of byBoard) {
      let n = 0
      for (let w = lo; w <= hi; w++) if (!m[w]) n++
      idle.push({ boardId, idleWindows: n, windows })
    }
  }
  return {
    joins,
    timeline,
    final: timeline.at(-1) ?? null,
    runtimeCapMb: lastRuntimeCapMb,
    secondQueuedBehindFirst: behind,
    secondQueueWaitMs: q && r ? r.t - q.t : null,
    servingWindow: window,
    boardsWithIdleWindows: idle.filter((b) => b.idleWindows > 0),
    servingBoards: idle.length,
    servingWindows: windows,
  }
}
