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
import type { ClientFactory, SessionPlan } from './session.ts'
import { loadUser, mintTicket, type RunSecrets } from './tickets.ts'

export interface LoadRunOptions {
  readonly profile: Profile
  readonly syncHttpUrl: string
  readonly secrets: RunSecrets
  readonly apiListen?: { host: string; port: number }
  readonly seed: 'file' | 'push' | 'none'
  readonly threads: number
  readonly durationMs?: number
  readonly tag: string
  readonly out: string | null
  readonly hostSamples?: string
  /** an in-memory room instead of sync (the plumbing dry run) */
  readonly fake?: boolean
  readonly log?: (line: string) => void
  readonly stopped?: () => boolean
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
      i++
    }
    log(`fake api on ${api.url}`)
    await waitHealthy(o.syncHttpUrl)
    if (o.seed !== 'none') await prepareBoards(o, boards, log)
    createClient = await loadHeadlessFactory()
  }

  const scraper = o.fake
    ? null
    : startScraper(o.syncHttpUrl, o.secrets.internalSecret, profile.metricsEveryMs)
  const t0 = Date.now() + 2_000
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
  }
  let results: ThreadResult[]
  if (o.threads > 0 && !o.fake)
    results = await runInWorkers(
      { ...run, profileName: profile.name, probeSids: [...probes.entries()], plans: plans as SessionPlan[] },
      o.threads,
    )
  else results = [await runInThread(run, createClient)]
  const endedAt = Date.now()
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
      killAt: profile.killAtMs === null ? null : t0 + profile.killAtMs,
      notes: [
        ...(o.fake ? ['PLUMBING DRY RUN on an in-memory room: no number here is a measurement of sync'] : []),
        ...(api ? [`fake api calls: ${JSON.stringify(api.counts)}`] : []),
      ],
      clientLoopDelayP99Ms: results.map((r) => r.loopDelayP99Ms),
    },
    results.flatMap((r) => r.reports),
    scrapes,
    readHostSamples(o.hostSamples, t0),
    final,
  )
  if (o.out) {
    mkdirSync(o.out, { recursive: true })
    const base = join(o.out, `${profile.name}-${o.tag}`)
    writeFileSync(`${base}.json`, JSON.stringify({ report, scrapes }, null, 1))
    writeFileSync(`${base}.md`, reportMarkdown(report))
    log(`report: ${base}.json / .md`)
  }
  return report
}
