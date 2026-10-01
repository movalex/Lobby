// The B9 report of one load run (docs/EXCALIDRAW-MIGRATION.md §8.3 B9 "Numbers the spike must report",
// §2.13 targets): the sessions' reports merged, the server's scrapes, the host's samples (docker stats,
// fsync and du from the NAS script), and each target marked met, missed or not measured. Never a
// target argued away: a number that is missing is `null` and its verdict "not measured".

import type { ConversionReport } from './load.ts'
import { type Scrape, series } from './metrics.ts'
import type { SessionReport } from './session.ts'
import { percentile, type Summary, summarize } from './stats.ts'

export interface HostSample {
  /** ms since the run start */
  readonly t: number
  readonly cpuPct?: number
  readonly memMB?: number
  readonly folderMB?: number
  /** the sync container's anonymous memory (cgroup memory.stat `anon`), sampled every second, MB */
  readonly anonMB?: number
}

/** One phase of a run (join storm, steady state, reconnect storm, after), from the host samples. */
export interface PhaseSummary {
  readonly name: string
  /** ms since the run start */
  readonly from: number
  readonly to: number
  readonly cpuSamples: number
  readonly cpuMeanPct: number | null
  readonly cpuMaxPct: number | null
  readonly memMaxMB: number | null
  readonly anonMaxMB: number | null
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
  /** the kill: the NAS script's own time of `docker kill` when known (kill file), else the planned time */
  readonly killAt?: number | null
  /** true when `killAt` is the kill command's measured time (the kill file), not the plan */
  readonly killMeasured?: boolean
  /** when `docker start` returned after the kill (the kill file's second line) */
  readonly restartedAt?: number | null
  /** the profile's join ramp (the join-storm phase), ms */
  readonly joinRampMs?: number
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
    /** from the first close the clients saw to the last session's new welcome */
    readonly allBackMs: number | null
    readonly backMs: Summary
    /** from the kill command (the kill file) to the last session's new welcome; null without the file */
    readonly allBackFromKillMs: number | null
    /** from the kill command to `docker start` returning */
    readonly restartCmdMs: number | null
    /** sessions that had joined before the kill */
    readonly joinedBeforeKill: number
    readonly harnessReconnects: number
  }
  readonly phases: readonly PhaseSummary[]
  readonly ackedButMissing: {
    readonly checked: number
    readonly missing: number
    readonly method: string
    /** the first missing ids, and for up to 5 of them the last acked fields next to what is stored */
    readonly ids?: readonly string[]
    readonly samples?: readonly {
      id: string
      acked: Record<string, unknown>
      stored: Record<string, unknown> | null
    }[]
  }
  readonly echo: {
    readonly receivers: number
    readonly receiversThatPushed: number
    readonly receiverOps: number
  }
  readonly server: {
    readonly scrapes: number
    readonly okScrapes: number
    readonly names: string[]
    /** O1's histograms over the run (last scrape minus first): ms from a push arriving to its ack */
    readonly receiveToAckMs?: HistogramSummary | null
    /** ms per group commit (BEGIN to COMMIT) */
    readonly commitMs?: HistogramSummary | null
    /** pushes per group commit */
    readonly pushesPerCommit?: HistogramSummary | null
    /** the largest scraped event-loop delay p99 (O1's gauge: since sync started), ms */
    readonly eventLoopP99Ms?: number | null
    /** the largest scraped p50 and max of the same gauge (since sync started; reset by the restart), ms */
    readonly eventLoopP50Ms?: number | null
    readonly eventLoopMaxMs?: number | null
    /** ms of the COMMIT statement (fsync with synchronous=FULL) */
    readonly fsyncMs?: HistogramSummary | null
    /** group commits per second over the run */
    readonly commitsPerSec?: number | null
    /** sync's own count of bytes written to sockets (lobby_outbound_bytes_total), per second */
    readonly outboundBytesPerSec?: number | null
    readonly presenceInPerSec?: number | null
    readonly presenceOutPerSec?: number | null
    /** RESYNC resets sent (lobby_resets_total) */
    readonly resets?: number | null
    /** closes by `code/reason` (lobby_closes_total) */
    readonly closes?: Record<string, number>
    /** ops by result (lobby_ops_total) */
    readonly ops?: Record<string, number>
  }
  readonly host: readonly HostSample[]
  readonly targets: readonly Target[]
  readonly errors: readonly string[]
  /** the conversion-under-load run only (load.ts) */
  readonly conversion?: ConversionReport
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
  const samples: { id: string; acked: Record<string, unknown>; stored: Record<string, unknown> | null }[] = []
  if (!final.stored)
    return { checked, missing, method: `${final.method} (no readback: UNVERIFIED)`, ids, samples }
  for (const s of sessions)
    for (const [id, fields] of Object.entries(s.acked)) {
      const el = final.stored.get(id)
      checked++
      const same = el && Object.entries(fields).every(([k, v]) => JSON.stringify(el[k]) === JSON.stringify(v))
      if (!same) {
        missing++
        if (ids.length < 20) ids.push(id)
        if (samples.length < 5)
          samples.push({
            id,
            acked: fields,
            stored: el ? Object.fromEntries(Object.keys(fields).map((k) => [k, el[k]])) : null,
          })
      }
    }
  return { checked, missing, method: final.method, ids, samples }
}

/** A metric by name and exact labels (O1's names, apps/sync/src/room/metrics.ts, first). */
interface MetricRef {
  readonly name: string
  readonly labels?: Readonly<Record<string, string>>
}
export const SERVER_METRICS: {
  readonly eventLoopP99: readonly MetricRef[]
  readonly rssBytes: readonly MetricRef[]
} = {
  eventLoopP99: [
    { name: 'lobby_event_loop_delay_ms', labels: { quantile: '0.99' } },
    { name: 'lobby_event_loop_delay_p99_ms' },
  ],
  // O1 exposes no RSS: on the NAS it comes from docker stats (host samples)
  rssBytes: [{ name: 'process_resident_memory_bytes' }, { name: 'lobby_rss_bytes' }],
}

function lastOf(scrapes: readonly Scrape[], refs: readonly MetricRef[], t0: number): number | null {
  for (const r of refs) {
    const s = series(scrapes, r.name, t0, { ...r.labels })
    if (s.length) return Math.max(...s.map(([, v]) => v))
  }
  return null
}

export interface HistogramSummary {
  readonly n: number
  /** upper bucket bounds (`le`) holding the quantile, ms or count */
  readonly p50: number | null
  readonly p95: number | null
  readonly p99: number | null
  readonly mean: number | null
}

/**
 * A Prometheus histogram over the run: the cumulative buckets' increments from the first ok scrape to the
 * last, and the quantiles as the upper bound of the bucket that reaches them (the resolution is the
 * bucket layout). A restart of sync (the SIGKILL at minute 8) resets every counter to 0: a scrape whose
 * count is below the previous one starts a new segment, which counts from 0.
 */
export function histogramOver(scrapes: readonly Scrape[], name: string): HistogramSummary | null {
  const ok = scrapes.filter((s) => s.ok && s.samples.some((m) => m.name === `${name}_bucket`))
  const first = ok[0]
  const last = ok.at(-1)
  if (!first || !last) return null
  const buckets = (sc: Scrape) =>
    new Map(
      sc.samples
        .filter((m) => m.name === `${name}_bucket` && m.labels.le !== undefined)
        .map((m) => [m.labels.le as string, m.value] as const),
    )
  const one = (sc: Scrape, suffix: string) =>
    sc.samples.find((m) => m.name === `${name}_${suffix}`)?.value ?? 0
  const les = [...buckets(last).keys()].sort((x, y) =>
    x === '+Inf' ? 1 : y === '+Inf' ? -1 : Number(x) - Number(y),
  )
  const acc = new Map<string, number>(les.map((le) => [le, 0]))
  let sum = 0
  if (ok.length === 1) {
    const b = buckets(first)
    for (const le of les) acc.set(le, b.get(le) ?? 0)
    sum = one(first, 'sum')
  }
  for (let i = 1; i < ok.length; i++) {
    const prev = ok[i - 1] as Scrape
    const cur = ok[i] as Scrape
    const a = buckets(prev)
    const b = buckets(cur)
    const reset = one(cur, 'count') < one(prev, 'count')
    for (const le of les) acc.set(le, (acc.get(le) ?? 0) + (b.get(le) ?? 0) - (reset ? 0 : (a.get(le) ?? 0)))
    sum += one(cur, 'sum') - (reset ? 0 : one(prev, 'sum'))
  }
  const cum = les.map((le) => [le, acc.get(le) ?? 0] as const)
  const n = cum.at(-1)?.[1] ?? 0
  const q = (p: number) => {
    if (!n) return null
    const hit = cum.find(([, c]) => c >= p * n)
    return hit ? (hit[0] === '+Inf' ? Number.POSITIVE_INFINITY : Number(hit[0])) : null
  }
  return { n, p50: q(0.5), p95: q(0.95), p99: q(0.99), mean: n ? Math.round((sum / n) * 10) / 10 : null }
}

/**
 * A counter's increase over the run, per exact label set (`name{a="x"}` keys; `name` alone without
 * labels): increments between consecutive ok scrapes, a decrease being a restart (the counter counts from
 * 0 again, so the new value is all increase).
 */
export function counterTotals(scrapes: readonly Scrape[], name: string): Record<string, number> {
  const ok = scrapes.filter((s) => s.ok)
  const key = (labels: Readonly<Record<string, string>>) => {
    const ks = Object.keys(labels).sort()
    return ks.length ? ks.map((k) => `${k}=${labels[k]}`).join(',') : name
  }
  const out: Record<string, number> = {}
  let prev = new Map<string, number>()
  ok.forEach((s, i) => {
    const cur = new Map<string, number>()
    for (const m of s.samples) if (m.name === name) cur.set(key(m.labels), m.value)
    if (i > 0)
      for (const [k, v] of cur) {
        const p = prev.get(k) ?? 0
        out[k] = (out[k] ?? 0) + (v >= p ? v - p : v)
      }
    else for (const k of cur.keys()) out[k] = 0
    prev = cur
  })
  return out
}

const sumOf = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0)

/** The run's phases (§8.3 B9 "CPU … per phase: join storm, steady state, reconnect storm") from the host samples. */
export function phasesOf(
  host: readonly HostSample[],
  o: { joinRampMs: number; killAtMs: number | null; endMs: number },
): PhaseSummary[] {
  const cuts: [string, number, number][] = [['join storm', 0, o.joinRampMs]]
  if (o.killAtMs !== null) {
    cuts.push(['steady state', o.joinRampMs, o.killAtMs])
    cuts.push(['reconnect storm (60 s after the kill)', o.killAtMs, o.killAtMs + 60_000])
    cuts.push(['after', o.killAtMs + 60_000, o.endMs])
  } else cuts.push(['steady state', o.joinRampMs, o.endMs])
  return cuts.map(([name, from, to]) => {
    const inside = host.filter((h) => h.t >= from && h.t < to)
    const cpu = inside.flatMap((h) => (h.cpuPct === undefined ? [] : [h.cpuPct]))
    const mem = inside.flatMap((h) => (h.memMB === undefined ? [] : [h.memMB]))
    const anon = inside.flatMap((h) => (h.anonMB === undefined ? [] : [h.anonMB]))
    const r1 = (x: number) => Math.round(x * 10) / 10
    return {
      name,
      from,
      to,
      cpuSamples: cpu.length,
      cpuMeanPct: cpu.length ? r1(cpu.reduce((a, b) => a + b, 0) / cpu.length) : null,
      cpuMaxPct: cpu.length ? Math.max(...cpu) : null,
      memMaxMB: mem.length ? Math.max(...mem) : null,
      anonMaxMB: anon.length ? Math.max(...anon) : null,
    }
  })
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
  // the restart (§2.13: "after the SIGKILL, all 260 sessions back within 30 s"): per session that had
  // joined before the kill, its first close at or after the kill and its first welcome after that close
  const killRef = meta.killAt ?? null
  const joinedBeforeKill = killRef === null ? [] : joined.filter((s) => (s.joinedAt as number) < killRef)
  const killClose = new Map<SessionReport, number>()
  const killBack = new Map<SessionReport, number>()
  for (const s of joinedBeforeKill) {
    const c = s.closes.find((x) => x.at >= (killRef as number) - 2_000)
    if (!c) continue
    killClose.set(s, c.at)
    const w =
      (s.welcomeTimes ?? []).find((t) => t > c.at) ??
      (s.backAt !== null && s.backAt > c.at ? s.backAt : undefined)
    if (w !== undefined) killBack.set(s, w)
  }
  const killSeenAt = killClose.size ? Math.min(...killClose.values()) : Number.NaN
  const affected = [...killClose.keys()]
  const back = [...killBack.keys()]
  const backMs = back.map((s) => (killBack.get(s) as number) - killSeenAt)
  const everyoneBack =
    affected.length > 0 && back.length === affected.length && affected.length === joinedBeforeKill.length
  const allBackMs = everyoneBack ? Math.max(...backMs) : null
  const allBackFromKillMs =
    everyoneBack && meta.killMeasured && killRef !== null ? Math.max(...killBack.values()) - killRef : null
  // B10: receive-only sessions on O2's full core (a thin one has no core and cannot push)
  const receivers = sessions.filter((s) => s.kind === 'watcher' && !s.thin)
  const abm = ackedButMissing(sessions, final)
  const eventLoopP99 = lastOf(scrapes, SERVER_METRICS.eventLoopP99, meta.startedAt)
  const rssMax = host.some((h) => h.memMB !== undefined) ? Math.max(...host.map((h) => h.memMB ?? 0)) : null
  const anonMax = host.some((h) => h.anonMB !== undefined)
    ? Math.max(...host.map((h) => h.anonMB ?? 0))
    : null
  const rssGate = rssMax === null && anonMax === null ? null : Math.max(rssMax ?? 0, anonMax ?? 0)
  const cpuMax = host.some((h) => h.cpuPct !== undefined) ? Math.max(...host.map((h) => h.cpuPct ?? 0)) : null
  const steadyBackpressure = sessions.reduce(
    (n, s) =>
      n + s.closes.filter((c) => c.code === 4000 && (killRef === null || c.at < killRef - 2_000)).length,
    0,
  )
  const restartValue = meta.killMeasured ? allBackFromKillMs : allBackMs
  const restartVerdict: Verdict =
    killRef === null
      ? 'not measured'
      : !everyoneBack
        ? affected.length
          ? 'missed'
          : 'not measured'
        : verdict(restartValue, (v) => v <= 30_000)
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
      name: 'RSS peak (docker stats every 10 s, and cgroup anon every 1 s: the larger)',
      limit: '≤ 400 MB',
      value: rssGate,
      verdict: verdict(rssGate, (v) => v <= 400),
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
      name: meta.killMeasured
        ? 'all sessions back after the SIGKILL (from the kill command)'
        : 'all sessions back after the SIGKILL (from the first close seen)',
      limit: '≤ 30 s, every session that had joined',
      value: killRef === null ? null : restartValue,
      verdict: restartVerdict,
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
      allBackFromKillMs,
      restartCmdMs: killRef !== null && meta.restartedAt ? meta.restartedAt - killRef : null,
      joinedBeforeKill: joinedBeforeKill.length,
      harnessReconnects: sessions.reduce((n, s) => n + s.reconnectsByHarness, 0),
    },
    phases: phasesOf(host, {
      joinRampMs: meta.joinRampMs ?? 60_000,
      killAtMs: killRef === null ? null : killRef - meta.startedAt,
      endMs: meta.endedAt - meta.startedAt,
    }),
    ackedButMissing: {
      checked: abm.checked,
      missing: abm.missing,
      method: abm.method,
      ids: abm.ids,
      samples: abm.samples,
    },
    echo: {
      receivers: receivers.length,
      receiversThatPushed: receivers.filter((s) => s.ops > 0).length,
      receiverOps: receivers.reduce((n, s) => n + s.ops, 0),
    },
    server: {
      scrapes: scrapes.length,
      okScrapes: scrapes.filter((s) => s.ok).length,
      names: [...new Set(scrapes.flatMap((s) => s.samples.map((m) => m.name)))].sort(),
      receiveToAckMs: histogramOver(scrapes, 'lobby_receive_to_ack_ms'),
      commitMs: histogramOver(scrapes, 'lobby_commit_ms'),
      pushesPerCommit: histogramOver(scrapes, 'lobby_pushes_per_commit'),
      eventLoopP99Ms: eventLoopP99,
      eventLoopP50Ms: lastOf(
        scrapes,
        [{ name: 'lobby_event_loop_delay_ms', labels: { quantile: '0.5' } }],
        meta.startedAt,
      ),
      eventLoopMaxMs: lastOf(
        scrapes,
        [{ name: 'lobby_event_loop_delay_ms', labels: { quantile: '1' } }],
        meta.startedAt,
      ),
      fsyncMs: histogramOver(scrapes, 'lobby_fsync_ms'),
      commitsPerSec: (() => {
        const c = histogramOver(scrapes, 'lobby_commit_ms')
        return c ? c.n / secs : null
      })(),
      outboundBytesPerSec: scrapes.some((x) => x.ok)
        ? sumOf(counterTotals(scrapes, 'lobby_outbound_bytes_total')) / secs
        : null,
      presenceInPerSec: scrapes.some((x) => x.ok)
        ? sumOf(counterTotals(scrapes, 'lobby_presence_in_total')) / secs
        : null,
      presenceOutPerSec: scrapes.some((x) => x.ok)
        ? sumOf(counterTotals(scrapes, 'lobby_presence_out_total')) / secs
        : null,
      resets: scrapes.some((x) => x.ok) ? sumOf(counterTotals(scrapes, 'lobby_resets_total')) : null,
      closes: counterTotals(scrapes, 'lobby_closes_total'),
      ops: counterTotals(scrapes, 'lobby_ops_total'),
    },
    host,
    targets,
    errors: sessions.flatMap((s) => s.errors.map((e) => `${s.key}: ${e}`)).slice(0, 50),
  }
}

const h = (x: HistogramSummary | null | undefined) =>
  x ? `n ${x.n}, p50 ≤ ${x.p50}, p95 ≤ ${x.p95}, p99 ≤ ${x.p99}, mean ${x.mean}` : '—'
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
    `| restart | ${r.restart.sessionsBack}/${r.restart.sessionsAffected} back of ${r.restart.joinedBeforeKill} joined before the kill; all back ${fmt(r.restart.allBackFromKillMs, ' ms')} after the kill command (docker start returned after ${fmt(r.restart.restartCmdMs, ' ms')}), ${fmt(r.restart.allBackMs, ' ms')} after the first close seen; per session ${s(r.restart.backMs)}; harness reconnects ${r.restart.harnessReconnects} |`,
    `| acked-but-missing | ${r.ackedButMissing.missing} of ${r.ackedButMissing.checked} (${r.ackedButMissing.method}) |`,
    `| echo (B10) | ${r.echo.receiversThatPushed} of ${r.echo.receivers} receivers pushed (${r.echo.receiverOps} ops) |`,
    `| server scrapes | ${r.server.okScrapes}/${r.server.scrapes} |`,
    `| server: push received → ack (ms, bucket bounds) | ${h(r.server.receiveToAckMs)} |`,
    `| server: group commit (ms, bucket bounds) | ${h(r.server.commitMs)} |`,
    `| server: pushes per commit | ${h(r.server.pushesPerCommit)} |`,
    `| server: event-loop delay p50 / p99 / max (ms, largest scraped; since sync started) | ${fmt(r.server.eventLoopP50Ms)} / ${fmt(r.server.eventLoopP99Ms)} / ${fmt(r.server.eventLoopMaxMs)} |`,
    `| server: COMMIT statement (fsync, ms, bucket bounds) | ${h(r.server.fsyncMs)} |`,
    `| server: commits/s; outbound bytes/s; presence in/s, out/s | ${fmt(r.server.commitsPerSec)}; ${fmt(r.server.outboundBytesPerSec)}; ${fmt(r.server.presenceInPerSec)}, ${fmt(r.server.presenceOutPerSec)} |`,
    `| server: RESYNC resets; closes (code, reason); ops by result | ${fmt(r.server.resets)}; ${JSON.stringify(r.server.closes ?? {})}; ${JSON.stringify(r.server.ops ?? {})} |`,
    ...(r.phases ?? []).map(
      (p) =>
        `| phase ${p.name} (${Math.round(p.from / 1000)}-${Math.round(p.to / 1000)} s): CPU % of quota mean / max; memory max (docker stats / anon) MB | ${fmt(p.cpuMeanPct)} / ${fmt(p.cpuMaxPct)} (${p.cpuSamples} samples); ${fmt(p.memMaxMB)} / ${fmt(p.anonMaxMB)} |`,
    ),
    ...(r.host.some((x) => x.folderMB !== undefined)
      ? [`| data folder peak (du -sm) | ${Math.max(...r.host.map((x) => x.folderMB ?? 0))} MB |`]
      : []),
    '',
    '| Target (§2.13) | Limit | Value | Verdict |',
    '|---|---|---|---|',
    ...r.targets.map((t) => `| ${t.name} | ${t.limit} | ${fmt(t.value)} | ${t.verdict} |`),
  ]
  const c = r.conversion
  if (c) {
    const fin = (id: string) => c.final?.boards.find((b) => b.boardId === id)
    lines.push(
      '',
      '| Conversion under load | Number |',
      '|---|---|',
      `| runtime heap cap (MB) | ${fmt(c.runtimeCapMb)} |`,
      ...c.joins.map((j) => {
        const b = fin(j.boardId)
        return `| ${j.boardId} | ${j.welcomedAt ? `served ${j.elements} elements after ${j.welcomedAt - j.startedAt} ms` : `not served: ${j.error}`}; status ${b ? `${b.state}${b.reason ? ` (${b.reason})` : ''}, ${fmt(b.ms, ' ms')} in the worker, peak heap used ${fmt(b.peakHeapUsedMb, ' MB')}, cap ${fmt(b.capMb, ' MB')}` : '—'} |`
      }),
      `| second job queued behind the first | ${c.secondQueuedBehindFirst ? 'yes' : 'no'}; queue wait ${fmt(c.secondQueueWaitMs, ' ms')} |`,
      `| status polls (changes) | ${c.timeline.map((p) => `${Math.round(p.t / 100) / 10}s run=${p.running ?? '-'} q=[${p.queued.join(',')}]`).join('; ')} |`,
      `| every room keeps serving (acks in each 10 s window overlapping ${c.servingWindow ? `${Math.round(c.servingWindow.from / 1000)}-${Math.round(c.servingWindow.to / 1000)} s` : '—'}) | ${c.servingBoards} boards with editors x ${c.servingWindows} windows; boards with an idle window: ${c.boardsWithIdleWindows.length ? JSON.stringify(c.boardsWithIdleWindows) : 'none'} |`,
    )
  }
  if (r.meta.clientLoopDelayP99Ms?.length)
    lines.push(
      '',
      `Client event-loop delay p99 per thread (ms): ${r.meta.clientLoopDelayP99Ms.map((x) => fmt(x)).join(', ')}`,
    )
  return `${lines.join('\n')}\n`
}

export { percentile }
