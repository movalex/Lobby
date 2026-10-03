// Pure Node checks of the join diagnostics (support/join-diag.ts, wave D5): the records B11 keeps of its headless
// joins, the loop-lag ticker, the metered socket and the snapshot analysis. No stack, no browser:
//   O3_SELFTEST_NO_WEB=1 SPIKE_B_PORT_BASE=<base> pnpm exec playwright test -c spike-b/support/selftest/playwright.config.ts join-diag.spec.ts
import { gzipSync } from 'node:zlib'
import { expect, test } from '@playwright/test'
import { encodeSnapshotFrame } from '../../../../packages/canvas-schema/src/protocol.ts'
import {
  analyseSnapshot,
  attachMeter,
  CapturingMeter,
  JoinTrace,
  LoopLag,
  meterOf,
  profileTop,
  turnCost,
} from '../join-diag.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const busy = (ms: number) => {
  const until = Date.now() + ms
  while (Date.now() < until) {
    // a task that keeps the loop from running
  }
}

test.describe('LoopLag', () => {
  test('a task that blocks the loop shows as a late tick, and the heap and collections are read', async () => {
    const lag = new LoopLag().begin()
    try {
      await sleep(100)
      expect(lag.worstSince(2_000)).toBe(0)
      busy(450)
      await sleep(60)
      expect(lag.worstSince(2_000)).toBeGreaterThanOrEqual(350)
      const now = lag.now()
      expect(now.heapUsedMB).toBeGreaterThan(0)
      expect(now.heapLimitMB).toBeGreaterThan(now.heapUsedMB)
      expect(now.tickLagMaxLast10s).toBeGreaterThanOrEqual(350)
      expect(lag.worstSince(10)).toBe(0) // the lag is dated: nothing late in the last 10 ms
    } finally {
      lag.end()
    }
  })

  test('summary: a window per 5 s with its worst tick, the ticks over 1 s listed', async () => {
    const lag = new LoopLag().begin()
    try {
      busy(1_100)
      await sleep(40)
      const s = lag.summary()
      expect(s.stallsOver1s).toBe(1)
      expect(s.stalls[0]?.[1]).toBeGreaterThanOrEqual(1_000)
      expect(s.heapLimitMB).toBeGreaterThan(0)
      expect(s.worstTickLagMs).toBe(0) // no 5 s window has closed yet
    } finally {
      lag.end()
    }
  })
})

test.describe('JoinTrace', () => {
  test('counts the joins in flight: a watch and a hold, each released once', () => {
    const lag = new LoopLag()
    const trace = new JoinTrace(lag, () => {}, 60_000)
    expect(trace.active).toBe(0)
    const stopA = trace.watch(trace.begin('h1', 1, 'first'))
    const release = trace.hold()
    expect(trace.active).toBe(2)
    stopA()
    stopA()
    expect(trace.active).toBe(1)
    release()
    release()
    expect(trace.active).toBe(0)
  })

  test('a join with no welcome is reported while it waits, again after longer waits, and not after it ends', async () => {
    const reports: number[] = []
    const lag = new LoopLag()
    const trace = new JoinTrace(lag, (_rec, waited) => reports.push(waited), 30)
    const rec = trace.begin('h2', 2, 'chaos')
    const stop = trace.watch(rec)
    await sleep(200)
    stop()
    const n = reports.length
    expect(n).toBeGreaterThanOrEqual(2)
    expect(reports[0]).toBeGreaterThanOrEqual(25)
    expect(reports[1]).toBeGreaterThan(reports[0] as number)
    await sleep(150)
    expect(reports.length).toBe(n)
  })

  test('a failing report does not stop the watch, and a join that ends in time is never reported', async () => {
    const lag = new LoopLag()
    let calls = 0
    const trace = new JoinTrace(
      lag,
      () => {
        calls++
        throw new Error('the report itself failed')
      },
      20,
    )
    const stop = trace.watch(trace.begin('h3', 1, 'first'))
    await sleep(120)
    stop()
    expect(calls).toBeGreaterThanOrEqual(2)
    let reported = 0
    const quick = new JoinTrace(lag, () => reported++, 100)
    const stopQuick = quick.watch(quick.begin('h4', 1, 'first'))
    stopQuick()
    await sleep(160)
    expect(reported).toBe(0)
  })

  test('summary: percentiles of the welcomes, and the slow and failed joins in full with their socket', () => {
    const lag = new LoopLag()
    const trace = new JoinTrace(lag, () => {})
    for (const [i, ms] of [100, 120, 90, 6_500].entries()) {
      const r = trace.begin(`h${i}`, 1, 'first')
      r.welcomeMs = ms
    }
    const failed = trace.begin('hf', 2, 'chaos')
    failed.failed = 'closed 4099 NOT_AUTHENTICATED'
    const meter = new CapturingMeter()
    meter.received('{"type":"welcome","x":1}')
    attachMeter(failed, meter)
    const s = trace.summary()
    expect(s.joins).toBe(5)
    expect(s.welcomed).toBe(4)
    expect(s.failed).toBe(1)
    expect(s.welcomeMs.max).toBe(6_500)
    expect(s.welcomeMs.p50).toBe(120)
    // the 6.5 s join and the failed one are listed, the quick ones are not
    expect(s.slow.map((r) => r.name)).toEqual(['h3', 'hf'])
    expect(s.slow[1]?.socket?.byType).toEqual({ welcome: 1 })
    expect(s.slow[0]?.socket).toBeUndefined()
    expect(meterOf(failed)).toBe(meter)
  })
})

test.describe('CapturingMeter', () => {
  test('sees every frame at the socket: its type, the binary ones with their size, a copy of the last one', () => {
    const m = new CapturingMeter()
    const source = new Uint8Array([1, 2, 3, 4]).buffer
    m.received('{"type":"welcome","clock":1}', 1_000)
    m.received(source, 1_100)
    m.received('{"type":"changes","ops":[]}', 1_200)
    m.received('{"type":"changes","ops":[]}', 1_300)
    m.received('not json', 1_400)
    expect(m.frames).toBe(5)
    expect(m.lastAt).toBe(1_400)
    expect(m.byType).toEqual({ welcome: 1, binary: 1, changes: 2, unknown: 1 })
    expect(m.binary).toEqual([[1_100, 4]])
    new Uint8Array(source)[0] = 99 // the frame's own buffer is reused by the socket: the copy must not follow
    expect(Array.from(m.lastBinary ?? [])).toEqual([1, 2, 3, 4])
    expect(m.rawSummary(2_000)).toMatchObject({ frames: 5, sinceLastFrameMs: 600, binary: [[1_100, 4]] })
    // the Meter's own counters still run
    expect(m.in.get('changes')?.frames).toBe(2)
    expect(m.snapshotBytes).toBe(4)
  })
})

test.describe('analyseSnapshot', () => {
  const frame = {
    type: 'snapshot' as const,
    epoch: 'ep1',
    clock: 3,
    horizon: 0,
    elements: [],
    doc: {},
    docClocks: {},
  }

  test('takes a real snapshot frame apart: gunzip, the stages of the decoder, the turn cost', async () => {
    const m = new CapturingMeter()
    m.received((await encodeSnapshotFrame(frame)).slice().buffer)
    const said = new Map<string, unknown>()
    await analyseSnapshot(m, (what, detail) => said.set(what, detail), 10_000)
    expect(said.get('gunzipSync (the main thread)')).toMatchObject({ head: '1f8b0800', jsonParses: true })
    expect(said.get('event-loop turn cost now')).toMatchObject({ turns: 20 })
    for (const stage of [
      'zlib.gunzip (callback, the thread pool)',
      'Blob stream read by a Response (no decompression)',
      'Blob stream through DecompressionStream, read by a Response',
      'decodeSnapshotFrame (the whole decoder)',
    ])
      expect(said.get(stage), stage).toMatchObject({ verdict: 'done' })
    expect(said.get('event-loop turn cost after')).toMatchObject({ turns: 20 })
  })

  test('a frame that is not complete gzip is reported as such, not as a stuck decoder', async () => {
    const whole = gzipSync(Buffer.from(JSON.stringify(frame)))
    const m = new CapturingMeter()
    m.received(new Uint8Array(whole.subarray(0, whole.length - 6)).buffer)
    const said = new Map<string, unknown>()
    await analyseSnapshot(m, (what, detail) => said.set(what, detail), 10_000)
    expect(said.get('gunzipSync (the main thread)')).toMatchObject({ ok: false })
    expect(
      String((said.get('decodeSnapshotFrame (the whole decoder)') as { verdict: string }).verdict),
    ).toMatch(/^rejected/)
  })

  test('without a binary frame it says so', async () => {
    const said: string[] = []
    await analyseSnapshot(new CapturingMeter(), (what) => said.push(what))
    expect(said).toEqual(['no binary frame'])
  })

  test('turnCost measures the hops through the loop', async () => {
    const t = await turnCost(10)
    expect(t.turns).toBe(10)
    expect(t.perTurnMs).toBeCloseTo(t.totalMs / 10, 5)
  })
})

test('profileTop names the functions a busy process spends its time in', async () => {
  const profile = profileTop(500, 5)
  await sleep(100)
  busy(250)
  const top = await profile
  expect(top.length).toBeGreaterThan(0)
  expect(top.length).toBeLessThanOrEqual(5)
  expect(top[0]).toMatch(/^\d+ ms {2}\S+/)
  // the 250 ms of busy loop, attributed to this file as `name file:line`
  expect(top.join('\n')).toMatch(/\d+ ms {2}\S+ e2e\/spike-b\/support\/selftest\/join-diag\.spec\.ts:\d+/)
})
