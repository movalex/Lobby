// The load generator's own checks (vitest project e2e-load): tickets, the fake api on the frozen internal
// contracts, the plans, the meter, the seeding chunks, the report's joins, and a short run end to end on
// the in-memory room (plumbing only; no number here is a measurement of sync).
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { verifyTicket } from '../../packages/auth-tickets/src/index.ts'
import { FileRefsResponse, SyncInternalErrorBody } from '../../packages/contracts/src/sync-internal.ts'
import { l1Board, smallBoard } from './boards.ts'
import { startFakeApi } from './fake-api.ts'
import { runLoad } from './load.ts'
import { Meter, messageType, probePointer, probeSentAt } from './meter.ts'
import { parsePrometheus } from './metrics.ts'
import { boardsOf, buildPlans, membersOf, probeSids, signedTickets } from './plan.ts'
import { DRY, L1, L2, plannedWritesPerSecond, sessionCount } from './profiles.ts'
import { ackedButMissing, counterTotals, histogramOver, phasesOf, visibilitySamples } from './report.ts'
import { partitionPlans } from './runner.ts'
import { chunkCreates, SEED_MAX_BYTES } from './seed.ts'
import type { SessionReport } from './session.ts'
import { percentile, Recorder, summarize } from './stats.ts'
import { loadUser, mintTicket, newRunSecrets, runEnvText, secretsFromEnv } from './tickets.ts'

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

describe('tickets and secrets', () => {
  it('fresh different secrets per run, and tickets sync accepts', () => {
    const a = newRunSecrets()
    const b = newRunSecrets()
    expect(a.ticketSecret).not.toBe(b.ticketSecret)
    expect(a.ticketSecret).not.toBe(a.internalSecret)
    expect(a.ticketSecret.length).toBeGreaterThanOrEqual(32)
    const env = Object.fromEntries(
      runEnvText(a, 'http://draftroom-spike-load:7899')
        .trim()
        .split('\n')
        .map((l) => l.split(/=(.*)/s).slice(0, 2)),
    )
    expect(secretsFromEnv(env)).toEqual(a)
    expect(() => secretsFromEnv({})).toThrow(/required/)
    const t = mintTicket(a.ticketSecret, 'l1-l1', loadUser(0, 3, 'viewer'))
    const v = verifyTicket(a.ticketSecret, t, { boardId: 'l1-l1' })
    expect(v.ok && v.claims.role).toBe('viewer')
    expect(verifyTicket(b.ticketSecret, t, { boardId: 'l1-l1' }).ok).toBe(false)
  })
})

describe('fake api', () => {
  it('answers every route sync calls, on the frozen shapes, behind the secret', async () => {
    const api = await startFakeApi({ internalSecret: 's'.repeat(40) })
    try {
      api.addBoard('b1', [['usr_1', 'editor']], ['ver_AAAAAAAAAA01'])
      const h = { 'x-draftroom-internal': 's'.repeat(40) }
      const bad = await fetch(`${api.url}/internal/access?boardId=b1&userId=usr_1`, {
        headers: { 'x-draftroom-internal': 'nope' },
      })
      expect(bad.status).toBe(401)
      expect(SyncInternalErrorBody.parse(await bad.json()).error.code).toBe('bad-secret')
      const access = await fetch(`${api.url}/internal/access?boardId=b1&userId=usr_1`, { headers: h })
      expect(await access.json()).toEqual({ role: 'editor' })
      const none = await fetch(`${api.url}/internal/access?boardId=b1&userId=usr_2`, { headers: h })
      expect(await none.json()).toEqual({ role: null })
      const refs = await fetch(
        `${api.url}/internal/boards/b1/file-refs?ids=ver_AAAAAAAAAA01,ver_BBBBBBBBBB02`,
        { headers: h },
      )
      const body = FileRefsResponse.parse(await refs.json())
      expect(body.ok.map((r) => r.versionId)).toEqual(['ver_AAAAAAAAAA01'])
      expect(body.missing).toEqual(['ver_BBBBBBBBBB02'])
      const malformed = await fetch(`${api.url}/internal/boards/b1/file-refs?ids=nope`, { headers: h })
      expect(malformed.status).toBe(400)
      const ws = await fetch(`${api.url}/internal/boards/b1/workshop-state`, { headers: h })
      expect(await ws.json()).toEqual({ voteOpen: false, anonymous: false })
      expect((await fetch(`${api.url}/internal/boards/zz/workshop-state`, { headers: h })).status).toBe(404)
      expect((await fetch(`${api.url}/internal/boards/b1/touched?at=1`, { headers: h })).status).toBe(204)
      expect((await fetch(`${api.url}/internal/boards/b1/session-ended?at=1`, { headers: h })).status).toBe(
        204,
      )
      api.setDown(true)
      expect(
        (await fetch(`${api.url}/internal/boards/b1/file-refs?ids=ver_AAAAAAAAAA01`, { headers: h })).status,
      ).toBe(503)
      expect(api.counts).toMatchObject({ access: 2, fileRefs: 2, badSecret: 1, workshopState: 1, touched: 1 })
    } finally {
      await api.close()
    }
  })
})

describe('profiles and plans', () => {
  it('L1 is 260 sessions (200 on the workshop board), about 20-30 pushes/s there; L2 is 30 sessions at 20 edits/s', () => {
    expect(sessionCount(L1)).toBe(260)
    expect(L1.boards[0]?.groups.reduce((n, g) => n + g.count, 0)).toBe(200)
    // the budget: "Pushes: ~20/s on the big board", "about 30 writes/s" with the typists' fits
    expect(plannedWritesPerSecond(L1.boards[0] as never)).toBeGreaterThan(18)
    expect(plannedWritesPerSecond(L1.boards[0] as never)).toBeLessThan(30)
    expect(sessionCount(L2)).toBe(30)
    expect(plannedWritesPerSecond(L2.boards[0] as never)).toBe(20)
  })

  it('plans: unique tabs, disjoint notes per editor, a ramp over joinRampMs, members for the fake api', () => {
    const boards = boardsOf(DRY)
    const s = newRunSecrets()
    const plans = buildPlans(DRY, boards, signedTickets(s.ticketSecret))
    expect(new Set(plans.map((p) => p.key)).size).toBe(plans.length)
    const owned = plans.flatMap((p) => p.ownNotes)
    expect(new Set(owned).size).toBe(owned.length)
    for (const p of plans) if (p.group.kind === 'watcher') expect(p.ownNotes).toEqual([])
    const joins = plans.map((p) => p.joinAtMs)
    expect(Math.min(...joins)).toBe(0)
    expect(Math.max(...joins)).toBe(DRY.joinRampMs)
    const members = membersOf(plans)
    expect([...members.keys()].sort()).toEqual([...boards.keys()].sort())
    expect(probeSids(plans).size).toBe(1)
  })
  it('thin sessions: the last ones of a marked group, measuring first in the ramp, all on worker 0', () => {
    const s = newRunSecrets()
    const plans = buildPlans(L1, boardsOf(L1), signedTickets(s.ticketSecret))
    const thin = plans.filter((p) => p.thin)
    // L1: 50 of the 60 editor-role watchers, 4 of the 5 measuring viewers plus the probe, all 95 viewers
    expect(thin.length).toBe(50 + 5 + 95)
    expect(thin.every((p) => p.group.kind === 'watcher')).toBe(true)
    const probe = [...probeSids(plans).values()][0] // a sid: `<uid>:<tab>`
    const sid = (p: (typeof plans)[number]) => `${p.user.uid}:${p.key}`
    expect(plans.find((p) => sid(p) === probe)?.thin).toBe(true)
    // a measuring group without thin sessions keeps its probe on the full core (the DRY profile)
    const dry = buildPlans(DRY, boardsOf(DRY), signedTickets(s.ticketSecret))
    expect(dry.some((p) => p.thin)).toBe(false)
    expect(sid(plans[0] as (typeof plans)[number])).toBe(probe) // the probe joins first, the other measuring sessions next
    expect(plans.slice(1, 5).every((p) => p.group.measureVisibility)).toBe(true)
    const parts = partitionPlans(plans, 5)
    expect(parts.length).toBe(5)
    expect(parts[0]?.length).toBe(thin.length)
    expect(parts[0]?.every((p) => p.thin)).toBe(true)
    expect(
      parts
        .slice(1)
        .flat()
        .some((p) => p.thin),
    ).toBe(false)
    expect(parts.slice(1).map((p) => p.length)).toEqual([28, 28, 27, 27])
    // one thread, or no thin session: plain round-robin
    expect(partitionPlans(plans, 1).map((p) => p.length)).toEqual([260])
    const full = plans.filter((p) => !p.thin)
    expect(partitionPlans(full, 3).map((p) => p.length)).toEqual([37, 37, 36])
  })
})

describe('meter', () => {
  it('counts frames by type, splits drag ids from deltas, decodes the probe cursor', () => {
    const m = new Meter({ parsePresence: true })
    m.probeSid = 'u:probe'
    const t = 1_790_000_123_456
    m.received(JSON.stringify({ type: 'welcome', clock: 1 }), t)
    m.received(new ArrayBuffer(100), t)
    m.received(
      JSON.stringify({
        type: 'presence',
        peers: [{ sid: 'u:probe', pointer: probePointer(t - 37) }],
        drags: [
          { sid: 'x', d: 1, ids: ['a', 'b'], dx: 0, dy: 0 },
          { sid: 'y', d: 2, dx: 1, dy: 1 },
        ],
      }),
      t,
    )
    const s = m.snapshot()
    expect(Object.keys(s.in).sort()).toEqual(['presence', 'snapshot', 'welcome'])
    expect(s.dragStartsSeen).toBe(1)
    expect(s.dragIdsBytes).toBeGreaterThan(s.dragDeltaBytes)
    expect(m.presenceDelay.values()).toEqual([37])
    expect(m.welcomes[0]?.snapshotBytes).toBe(100)
    expect(messageType('{"type":"lease.grant","req":1}')).toBe('lease.grant')
    expect(probeSentAt(probePointer(t))).toBe(t % 1_000_000)
  })
})

describe('seeding, stats and the report joins', () => {
  it("reads O1's histograms over the run (last scrape minus first) and its event-loop gauge", () => {
    const text = (n5: number, n25: number, nInf: number, sum: number, p99: number) =>
      [
        `lobby_receive_to_ack_ms_bucket{le="5"} ${n5}`,
        `lobby_receive_to_ack_ms_bucket{le="25"} ${n25}`,
        `lobby_receive_to_ack_ms_bucket{le="+Inf"} ${nInf}`,
        `lobby_receive_to_ack_ms_sum ${sum}`,
        `lobby_receive_to_ack_ms_count ${nInf}`,
        'lobby_event_loop_delay_ms{quantile="0.5"} 1',
        `lobby_event_loop_delay_ms{quantile="0.99"} ${p99}`,
        'lobby_event_loop_delay_ms{quantile="1"} 90',
      ].join('\n')
    const scrape = (at: number, t: string) => ({ at, ok: true, status: 200, samples: parsePrometheus(t) })
    // before the run 10 pushes (all ≤ 5 ms); during it 100 more: 50 ≤ 5, 45 ≤ 25, 5 above
    const h = histogramOver(
      [scrape(0, text(10, 10, 10, 20, 3)), scrape(1, text(60, 105, 110, 820, 7))],
      'lobby_receive_to_ack_ms',
    )
    expect(h).toEqual({ n: 100, p50: 5, p95: 25, p99: Number.POSITIVE_INFINITY, mean: 8 })
    expect(histogramOver([], 'lobby_receive_to_ack_ms')).toBeNull()
    // sync restarted between scrape 2 and 3 (the SIGKILL): its counters start from 0 again
    const r = histogramOver(
      [
        scrape(0, text(10, 10, 10, 20, 3)),
        scrape(1, text(60, 105, 110, 820, 7)),
        scrape(2, text(4, 5, 6, 60, 2)),
        scrape(3, text(8, 10, 12, 120, 2)),
      ],
      'lobby_receive_to_ack_ms',
    )
    expect(r?.n).toBe(112)
    expect(r?.mean).toBe(Math.round((920 / 112) * 10) / 10)
  })
  it('sums counters across a restart, per label set', () => {
    const t = (a: number, b: number) =>
      [`lobby_closes_total{code="4000",reason="x"} ${a}`, `lobby_outbound_bytes_total ${b}`].join('\n')
    const scrape = (at: number, x: string) => ({ at, ok: true, status: 200, samples: parsePrometheus(x) })
    const s = [scrape(0, t(1, 100)), scrape(1, t(3, 500)), scrape(2, t(0, 50)), scrape(3, t(2, 80))]
    expect(counterTotals(s, 'lobby_outbound_bytes_total')).toEqual({ lobby_outbound_bytes_total: 480 })
    expect(counterTotals(s, 'lobby_closes_total')).toEqual({ 'code=4000,reason=x': 4 })
    const ph = phasesOf(
      [
        { t: 5_000, cpuPct: 40, memMB: 100 },
        { t: 70_000, cpuPct: 60, memMB: 120, anonMB: 110 },
        { t: 490_000, cpuPct: 90, memMB: 90 },
      ],
      { joinRampMs: 60_000, killAtMs: 480_000, endMs: 600_000 },
    )
    expect(ph.map((p) => [p.name, p.cpuMaxPct, p.anonMaxMB])).toEqual([
      ['join storm', 40, null],
      ['steady state', 60, 110],
      ['reconnect storm (60 s after the kill)', 90, null],
      ['after', null, null],
    ])
  })
  it('summarizes 300,000 samples (L2 visibility: 10 measuring sessions x 12,000 edits) without a spread', () => {
    const big = Array.from({ length: 300_000 }, (_, i) => (i * 7919) % 1_000)
    // 7919 and 1000 are coprime: every residue 0..999 appears 300 times (nearest rank: 499, 949, 989)
    expect(summarize(big)).toEqual({ n: 300_000, p50: 499, p95: 949, p99: 989, max: 999, mean: 499.5 })
  })
  it('chunks creates within 500 ops and 500 KiB, a label with its note', () => {
    const b = l1Board('seed-x')
    const chunks = chunkCreates(b.elements)
    expect(chunks.flat()).toHaveLength(b.elements.length)
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(500)
      expect(Buffer.byteLength(JSON.stringify(c))).toBeLessThanOrEqual(SEED_MAX_BYTES)
      const last = c.at(-1)
      expect(last?.type === 'stickynote' && last.boundElements?.some((r) => r.type === 'text')).toBe(false)
    }
  })

  it('percentiles, the reservoir and prometheus text', () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3)
    expect(percentile([1, 2, 3, 4, 100], 95)).toBe(100)
    const r = new Recorder(10)
    for (let i = 0; i < 1000; i++) r.add(i)
    expect(r.count).toBe(1000)
    expect(r.values()).toHaveLength(10)
    expect(r.summary().max).toBe(999)
    const m = parsePrometheus('# HELP x\nlobby_pushes_total{code="ok"} 12\nlobby_rss_bytes 1.5e8\nbad line\n')
    expect(m).toEqual([
      { name: 'lobby_pushes_total', labels: { code: 'ok' }, value: 12 },
      { name: 'lobby_rss_bytes', labels: {}, value: 1.5e8 },
    ])
  })

  it("visibility joins an editor's acked edits with other sessions' arrivals on the same board", () => {
    const base = { acked: {}, arrivals: {}, edits: [] } as unknown as SessionReport
    const editor = { ...base, key: 'e', boardId: 'b', edits: [{ id: 'n1', v: 3, sentAt: 1000, ackAt: 1040 }] }
    const w1 = { ...base, key: 'w1', boardId: 'b', arrivals: { 'n1:3': 1030 } }
    const w2 = { ...base, key: 'w2', boardId: 'other', arrivals: { 'n1:3': 1500 } }
    expect(visibilitySamples([editor, w1, w2] as SessionReport[])).toEqual([30])
    const s = { ...base, key: 'e', acked: { n1: { x: 5 }, n2: { x: 1 } } } as SessionReport
    const stored = new Map([
      ['n1', { x: 5 }],
      ['n2', { x: 2 }],
    ])
    expect(ackedButMissing([s], { stored, method: 't' })).toMatchObject({
      checked: 2,
      missing: 1,
      unresolved: 0,
      ids: ['n2'],
    })
    // the same difference while a push of n2 was still out without an ack at the end: unresolved, not missing
    const pending = { ...s, pendingAtEnd: ['n2'] } as SessionReport
    expect(ackedButMissing([pending], { stored, method: 't' })).toMatchObject({
      checked: 2,
      missing: 0,
      unresolved: 1,
      ids: ['n2 (pending)'],
      samples: [{ id: 'n2', acked: { x: 1 }, stored: { x: 2 }, pending: true }],
    })
    // a stored element that is gone is missing even with a pending push
    expect(ackedButMissing([pending], { stored: new Map([['n1', { x: 5 }]]), method: 't' })).toMatchObject({
      missing: 1,
      unresolved: 0,
    })
    expect(ackedButMissing([s], { stored: null, method: 't' }).method).toMatch(/UNVERIFIED/)
  })
})

describe('a short run on the in-memory room (plumbing)', () => {
  it('joins every session, edits, measures, and receivers push nothing', async () => {
    const out = mkdtempSync(join(tmpdir(), 'o3-load-'))
    dirs.push(out)
    const report = await runLoad({
      profile: { ...DRY, joinRampMs: 1_000 },
      syncHttpUrl: 'http://fake',
      secrets: newRunSecrets(),
      seed: 'none',
      threads: 0,
      durationMs: 6_000,
      tag: 'test',
      out,
      fake: true,
      log: () => undefined,
    })
    expect(report.joins.joined).toBe(sessionCount(DRY))
    expect(report.protocol.pushes).toBeGreaterThan(0)
    expect(report.latency.ack.n).toBeGreaterThan(0)
    expect(report.latency.visibility.n).toBeGreaterThan(0)
    expect(report.latency.presence.n).toBeGreaterThan(0)
    expect(report.echo.receiversThatPushed).toBe(0)
    expect(report.ackedButMissing.missing).toBe(0)
    expect(report.meta.notes?.[0]).toMatch(/PLUMBING DRY RUN/)
    expect(smallBoard('x', 1).elements.length).toBeGreaterThan(80)
  }, 30_000)
})

describe('board files (gen-boards)', () => {
  it('writes lb_* rows with the frozen DDL and a real tldraw board file; never overwrites', async () => {
    const { DatabaseSync } = await import('node:sqlite')
    const { writeLbBoard, writeTldrawBoard } = await import('./board-files.ts')
    const { LB_TABLES } = await import('../../apps/sync/src/room/schema.ts')
    const data = mkdtempSync(join(tmpdir(), 'o3-gen-'))
    dirs.push(data)
    const b = smallBoard('gen-s00', 7)
    const w = writeLbBoard(data, 'gen-s00', b.elements)
    expect(w.rows).toBe(b.elements.length)
    expect(() => writeLbBoard(data, 'gen-s00', b.elements)).toThrow(/exists/)
    const db = new DatabaseSync(w.path, { readOnly: true })
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    ).map((r) => r.name)
    for (const t of LB_TABLES) expect(tables).toContain(t)
    expect(tables).not.toContain('documents')
    const n = db.prepare('SELECT count(*) AS n FROM lb_elements WHERE deleted = 0').get() as { n: number }
    expect(n.n).toBe(b.elements.length)
    const first = db.prepare('SELECT data FROM lb_elements ORDER BY idx, id LIMIT 1').get() as {
      data: string
    }
    expect(JSON.parse(first.data).id).toBe(b.elements[0]?.id)
    db.close()
    const t = writeTldrawBoard(data, 'gen-tl', { notes: 30 })
    const tdb = new DatabaseSync(t.path, { readOnly: true })
    const ttables = (
      tdb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    ).map((r) => r.name)
    expect(ttables).toContain('documents')
    expect(ttables.some((x) => x.startsWith('lb_'))).toBe(false)
    tdb.close()
  })
})
