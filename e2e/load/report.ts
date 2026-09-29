// The B9 report of one load run (docs/EXCALIDRAW-MIGRATION.md §8.3 B9 "Numbers the spike must report",
// §2.13 targets): the sessions' reports merged, the server's scrapes, the host's samples (docker stats,
// fsync and du from the NAS script), and each target marked met, missed or not measured. Never a
// target argued away: a number that is missing is `null` and its verdict "not measured".

import { type Scrape, series } from './metrics.ts'
import type { SessionReport } from './session.ts'
import { percentile, type Summary, summarize } from './stats.ts'

export interface HostSample {
  /** ms since the run start */
  readonly t: number
  readonly cpuPct?: number
  readonly memMB?: number
  readonly folderMB?: number
}

export interface RunMeta {
  readonly profile: string
  readonly startedAt: number
  readonly endedAt: number
  readonly sync: string
  readonly sessions: number
  readonly node: string
  readonly cpus: number
  readonly threads: number
  readonly commit?: string
  readonly killAt?: number | null
  readonly notes?: readonly string[]
  /** the client side's own event-loop delay per worker (a client-bound run makes the numbers suspect) */
  readonly clientLoopDelayP99Ms?: readonly number[]
}

export type Verdict = 'met' | 'missed' | 'not measured'

export interface Target {
  readonly name: string
  readonly limit: string
  readonly value: number | null
  readonly verdict: Verdict
}

export interface RunReport {
  readonly meta: RunMeta
  readonly latency: { readonly ack: Summary; readonly visibility: Summary; readonly presence: Summary }
  readonly protocol: {
    readonly pushes: number
    readonly ops: number
    readonly pushesPerSec: number
    readonly opsPerSec: number
    readonly rejects: Record<string, number>
    readonly denied: Record<string, number>
    readonly fitDropped: number
    readonly notices: Record<string, number>
    readonly closesByCode: Record<string, number>
    readonly leaseGrants: number
    readonly leaseDenies: number
  }
  readonly network: {
    /** bytes/s the clients received, total and per receiving session, by message type */
    readonly inPerSec: number
    readonly inPerSessionPerSec: number
    readonly byType: Record<string, { bytesPerSec: number; framesPerSec: number }>
    /** from the sessions that parse presence: per such session, bytes/s */
    readonly sampledSessions: number
    readonly dragIdsBytesPerSessionPerSec: number
    readonly dragDeltaBytesPerSessionPerSec: number
    readonly cursorBytesPerSessionPerSec: number
    readonly outPerSec: number
  }
  readonly welcome: { readonly jsonBytes: Summary; readonly snapshotBytes: Summary; readonly count: number }
  readonly drag: { readonly starts: number; readonly startsPerSec: number; readonly idsPerStart: Summary }
  readonly joins: { readonly joined: number; readonly failed: number; readonly joinMs: Summary }
  readonly restart: {
    readonly killSeenAt: number | null
    readonly sessionsAffected: number
    readonly sessionsBack: number
    readonly allBackMs: number | null
    readonly backMs: Summary
    readonly harnessReconnects: number
  }
  readonly ackedButMissing: { readonly checked: number; readonly missing: number; readonly method: string }
  readonly echo: {
    readonly receivers: number
    readonly receiversThatPushed: number
    readonly receiverOps: number
  }
  readonly server: { readonly scrapes: number; readonly okScrapes: number; readonly names: string[] }
  readonly host: readonly HostSample[]
  readonly targets: readonly Target[]
  readonly errors: readonly string[]
}

const add = (a: Record<string, number>, b: Record<string, number>) => {
  for (const [k, v] of Object.entries(b)) a[k] = (a[k] ?? 0) + v
  return a
}

/** Joins every editor's acked edits with the measuring sessions' arrivals on the same board. */
export function visibilitySamples(sessions: readonly SessionReport[]): number[] {
  const out: number[] = []
  const measuring = sessions.filter((s) => Object.keys(s.arrivals).length > 0)
  for (const s of sessions) {
    if (s.edits.length === 0) continue
    for (const m of measuring) {
      if (m.boardId !== s.boardId || m.key === s.key) continue
      for (const e of s.edits) {
        const at = m.arrivals[`${e.id}:${e.v}`]
        if (at !== undefined) out.push(at - e.sentAt)
      }
    }
  }
  return out
}

export interface FinalCheck {
  /** id → the stored element (test snapshot or a fresh reader's map); null when no readback was possible */
  readonly stored: ReadonlyMap<string, Record<string, unknown>> | null
  readonly method: string
}

/** acked-but-missing: every editor's last acked value of each of its own notes must be what is stored. */
export function ackedButMissing(sessions: readonly SessionReport[], final: FinalCheck) {
  let checked = 0
  let missing = 0
  const ids: string[] = []
  if (!final.stored) return { checked, missing, method: `${final.method} (no readback: UNVERIFIED)`, ids }
  for (const s of sessions)
    for (const [id, fields] of Object.entries(s.acked)) {
      const el = final.stored.get(id)
      checked++
      const same = el && Object.entries(fields).every(([k, v]) => JSON.stringify(el[k]) === JSON.stringify(v))
      if (!same) {
        missing++
        if (ids.length < 20) ids.push(id)
      }
    }
  return { checked, missing, method: final.method, ids }
}

export const SERVER_METRICS = {
  eventLoopP99: ['lobby_event_loop_delay_p99_ms', 'event_loop_delay_p99_ms'],
  rssBytes: ['process_resident_memory_bytes', 'lobby_rss_bytes'],
} as const

function lastOf(scrapes: readonly Scrape[], names: readonly string[], t0: number): number | null {
  for (const n of names) {
    const s = series(scrapes, n, t0)
    if (s.length) return Math.max(...s.map(([, v]) => v))
  }
  return null
}

const verdict = (value: number | null, ok: (v: number) => boolean): Verdict =>
  value === null || !Number.isFinite(value) ? 'not measured' : ok(value) ? 'met' : 'missed'

export function buildReport(
  meta: RunMeta,
  sessions: readonly SessionReport[],
  scrapes: readonly Scrape[],
  host: readonly HostSample[],
  final: FinalCheck,
): RunReport {
  const secs = Math.max(1, (meta.endedAt - meta.startedAt) / 1000)
  const ack = summarize(sessions.flatMap((s) => s.ackSamples))
  const visibility = summarize(visibilitySamples(sessions))
  const presence = summarize(sessions.flatMap((s) => s.presenceDelaySamples))
  const rejects: Record<string, number> = {}
  const denied: Record<string, number> = {}
  const notices: Record<string, number> = {}
  const closesByCode: Record<string, number> = {}
  const byTypeBytes: Record<string, number> = {}
  const byTypeFrames: Record<string, number> = {}
  let outBytes = 0
  for (const s of sessions) {
    add(rejects, s.rejects)
    add(denied, s.denied)
    add(notices, s.notices)
    for (const c of s.closes) closesByCode[String(c.code)] = (closesByCode[String(c.code)] ?? 0) + 1
    for (const [t, c] of Object.entries(s.bytes.in)) {
      byTypeBytes[t] = (byTypeBytes[t] ?? 0) + c.bytes
      byTypeFrames[t] = (byTypeFrames[t] ?? 0) + c.frames
    }
    for (const c of Object.values(s.bytes.out)) outBytes += c.bytes
  }
  const inTotal = Object.values(byTypeBytes).reduce((a, b) => a + b, 0)
  const joined = sessions.filter((s) => s.joinedAt !== null)
  const sampled = sessions.filter(
    (s) => s.bytes.dragIdsBytes + s.bytes.dragDeltaBytes + s.bytes.cursorBytes > 0,
  )
  const perSampled = (f: (s: SessionReport) => number) =>
    sampled.length ? sampled.reduce((n, s) => n + f(s), 0) / sampled.length / secs : 0
  const killSeenAt = Math.min(
    ...sessions.flatMap((s) =>
      (meta.killAt ? s.closes.filter((c) => c.at >= (meta.killAt as number) - 5_000) : s.closes).map(
        (c) => c.at,
      ),
    ),
  )
  const affected = sessions.filter((s) => s.closes.length > 0)
  const back = affected.filter((s) => s.backAt !== null)
  const backMs = back.map((s) => (s.backAt as number) - (Number.isFinite(killSeenAt) ? killSeenAt : 0))
  const receivers = sessions.filter((s) => s.kind === 'watcher')
  const abm = ackedButMissing(sessions, final)
  const eventLoopP99 = lastOf(scrapes, SERVER_METRICS.eventLoopP99, meta.startedAt)
  const rssMax = host.some((h) => h.memMB !== undefined) ? Math.max(...host.map((h) => h.memMB ?? 0)) : null
  const cpuMax = host.some((h) => h.cpuPct !== undefined) ? Math.max(...host.map((h) => h.cpuPct ?? 0)) : null
  const allBackMs = affected.length && back.length === affected.length ? Math.max(...backMs) : null
  const steadyBackpressure = sessions.reduce(
    (n, s) =>
      n + s.closes.filter((c) => c.code === 4000 && (!meta.killAt || c.at < meta.killAt - 5_000)).length,
    0,
  )
  const targets: Target[] = [
    { name: 'ack p95', limit: '≤ 150 ms', value: ack.p95, verdict: verdict(ack.p95, (v) => v <= 150) },
    { name: 'ack p99', limit: '≤ 400 ms', value: ack.p99, verdict: verdict(ack.p99, (v) => v <= 400) },
    {
      name: 'event-loop delay p99 (server)',
      limit: '≤ 50 ms',
      value: eventLoopP99,
      verdict: verdict(eventLoopP99, (v) => v <= 50),
    },
    {
      name: 'RSS peak (docker stats)',
      limit: '≤ 400 MB',
      value: rssMax,
      verdict: verdict(rssMax, (v) => v <= 400),
    },
    {
      name: 'CPU peak, % of the 0.5 CPU quota (10 s windows)',
      limit: '≤ 80 %',
      value: cpuMax,
      verdict: verdict(cpuMax, (v) => v <= 80),
    },
    {
      name: 'presence delay p95',
      limit: '≤ 200 ms',
      value: presence.p95,
      verdict: verdict(presence.p95, (v) => v <= 200),
    },
    {
      name: 'backpressure closes at steady state',
      limit: '0',
      value: steadyBackpressure,
      verdict: verdict(steadyBackpressure, (v) => v === 0),
    },
    {
      name: 'all sessions back after the SIGKILL',
      limit: '≤ 30 s',
      value: meta.killAt ? allBackMs : null,
      verdict: meta.killAt ? verdict(allBackMs, (v) => v <= 30_000) : 'not measured',
    },
    {
      name: 'acked-but-missing',
      limit: '0',
      value: final.stored ? abm.missing : null,
      verdict: final.stored ? verdict(abm.missing, (v) => v === 0) : 'not measured',
    },
    {
      name: 'receiving-only sessions that pushed (B10)',
      limit: '0',
      value: receivers.filter((s) => s.ops > 0).length,
      verdict: verdict(receivers.filter((s) => s.ops > 0).length, (v) => v === 0),
    },
  ]
  return {
    meta,
    latency: { ack, visibility, presence },
    protocol: {
      pushes: sessions.reduce((n, s) => n + s.pushes, 0),
      ops: sessions.reduce((n, s) => n + s.ops, 0),
      pushesPerSec: sessions.reduce((n, s) => n + s.pushes, 0) / secs,
      opsPerSec: sessions.reduce((n, s) => n + s.ops, 0) / secs,
      rejects,
      denied,
      fitDropped: sessions.reduce((n, s) => n + s.fitDropped, 0),
      notices,
      closesByCode,
      leaseGrants: sessions.reduce((n, s) => n + s.leaseGrants, 0),
      leaseDenies: sessions.reduce((n, s) => n + s.leaseDenies, 0),
    },
    network: {
      inPerSec: inTotal / secs,
      inPerSessionPerSec: joined.length ? inTotal / secs / joined.length : 0,
      byType: Object.fromEntries(
        Object.keys(byTypeBytes).map((t) => [
          t,
          { bytesPerSec: (byTypeBytes[t] ?? 0) / secs, framesPerSec: (byTypeFrames[t] ?? 0) / secs },
        ]),
      ),
      sampledSessions: sampled.length,
      dragIdsBytesPerSessionPerSec: perSampled((s) => s.bytes.dragIdsBytes),
      dragDeltaBytesPerSessionPerSec: perSampled((s) => s.bytes.dragDeltaBytes),
      cursorBytesPerSessionPerSec: perSampled((s) => s.bytes.cursorBytes),
      outPerSec: outBytes / secs,
    },
    welcome: {
      jsonBytes: summarize(sessions.flatMap((s) => s.welcomeBytes.map((w) => w.jsonBytes))),
      snapshotBytes: summarize(
        sessions.flatMap((s) => s.welcomeBytes.map((w) => w.snapshotBytes)).filter((b) => b > 0),
      ),
      count: sessions.reduce((n, s) => n + s.welcomeBytes.length, 0),
    },
    drag: {
      starts: sessions.reduce((n, s) => n + s.dragStarts, 0),
      startsPerSec: sessions.reduce((n, s) => n + s.dragStarts, 0) / secs,
      idsPerStart: summarize(sessions.flatMap((s) => s.dragIds)),
    },
    joins: {
      joined: joined.length,
      failed: sessions.length - joined.length,
      joinMs: summarize(joined.map((s) => s.joinMs as number)),
    },
    restart: {
      killSeenAt: Number.isFinite(killSeenAt) ? killSeenAt : null,
      sessionsAffected: affected.length,
      sessionsBack: back.length,
      allBackMs,
      backMs: summarize(backMs),
      harnessReconnects: sessions.reduce((n, s) => n + s.reconnectsByHarness, 0),
    },
    ackedButMissing: { checked: abm.checked, missing: abm.missing, method: abm.method },
    echo: {
      receivers: receivers.length,
      receiversThatPushed: receivers.filter((s) => s.ops > 0).length,
      receiverOps: receivers.reduce((n, s) => n + s.ops, 0),
    },
    server: {
      scrapes: scrapes.length,
      okScrapes: scrapes.filter((s) => s.ok).length,
      names: [...new Set(scrapes.flatMap((s) => s.samples.map((m) => m.name)))].sort(),
    },
    host,
    targets,
    errors: sessions.flatMap((s) => s.errors.map((e) => `${s.key}: ${e}`)).slice(0, 50),
  }
}

const fmt = (v: number | null | undefined, unit = '') =>
  v === null || v === undefined || Number.isNaN(v) ? '—' : `${Math.round(v * 10) / 10}${unit}`

/** The report as the B9 evidence table (markdown; numbers only, no board content). */
export function reportMarkdown(r: RunReport): string {
  const s = (x: Summary) =>
    `p50 ${fmt(x.p50)} / p95 ${fmt(x.p95)} / p99 ${fmt(x.p99)} / max ${fmt(x.max)} (n ${x.n})`
  const lines = [
    `### ${r.meta.profile}, ${new Date(r.meta.startedAt).toISOString()} (${Math.round((r.meta.endedAt - r.meta.startedAt) / 1000)} s, ${r.meta.sessions} sessions, ${r.meta.threads} client threads)`,
    ...(r.meta.notes?.length ? ['', ...r.meta.notes.map((n) => `> ${n}`)] : []),
    '',
    '| Area | Number |',
    '|---|---|',
    `| ack (ms) | ${s(r.latency.ack)} |`,
    `| A→B visibility through the server (ms) | ${s(r.latency.visibility)} |`,
    `| presence delay (ms) | ${s(r.latency.presence)} |`,
    `| pushes/s, ops/s | ${fmt(r.protocol.pushesPerSec)} / ${fmt(r.protocol.opsPerSec)} |`,
    `| rejects by code | ${JSON.stringify(r.protocol.rejects)} |`,
    `| notices | ${JSON.stringify(r.protocol.notices)} |`,
    `| closes by code | ${JSON.stringify(r.protocol.closesByCode)} |`,
    `| bytes/s to clients (total, per session) | ${fmt(r.network.inPerSec)} / ${fmt(r.network.inPerSessionPerSec)} |`,
    `| by type (bytes/s) | ${Object.entries(r.network.byType)
      .map(([t, v]) => `${t} ${fmt(v.bytesPerSec)}`)
      .join(', ')} |`,
    `| per sampled session (bytes/s): drag ids / drag deltas / cursors | ${fmt(r.network.dragIdsBytesPerSessionPerSec)} / ${fmt(r.network.dragDeltaBytesPerSessionPerSec)} / ${fmt(r.network.cursorBytesPerSessionPerSec)} (${r.network.sampledSessions} sessions) |`,
    `| drag starts/s, ids per start | ${fmt(r.drag.startsPerSec)}; ${s(r.drag.idsPerStart)} |`,
    `| welcome JSON / snapshot bytes | ${s(r.welcome.jsonBytes)}; ${s(r.welcome.snapshotBytes)} |`,
    `| joins | ${r.joins.joined} joined, ${r.joins.failed} failed; ${s(r.joins.joinMs)} |`,
    `| restart | ${r.restart.sessionsBack}/${r.restart.sessionsAffected} back, all back in ${fmt(r.restart.allBackMs, ' ms')}; harness reconnects ${r.restart.harnessReconnects} |`,
    `| acked-but-missing | ${r.ackedButMissing.missing} of ${r.ackedButMissing.checked} (${r.ackedButMissing.method}) |`,
    `| echo (B10) | ${r.echo.receiversThatPushed} of ${r.echo.receivers} receivers pushed (${r.echo.receiverOps} ops) |`,
    `| server scrapes | ${r.server.okScrapes}/${r.server.scrapes} |`,
    '',
    '| Target (§2.13) | Limit | Value | Verdict |',
    '|---|---|---|---|',
    ...r.targets.map((t) => `| ${t.name} | ${t.limit} | ${fmt(t.value)} | ${t.verdict} |`),
  ]
  if (r.meta.clientLoopDelayP99Ms?.length)
    lines.push(
      '',
      `Client event-loop delay p99 per thread (ms): ${r.meta.clientLoopDelayP99Ms.map((x) => fmt(x)).join(', ')}`,
    )
  return `${lines.join('\n')}\n`
}

export { percentile }
