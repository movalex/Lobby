// K6-3: one thumbnail upload per board when several people are on it (6 of 51 PUTs got 429 with 2-3 people on
// one board, 10-07). The board's event stream says when the api accepted an upload ('thumbnail.updated', with
// its version): another client's upload cancels this client's pending one and moves its next one past theirs,
// and a 429 is rescheduled once, after Retry-After. Plain logic on a fake clock, like ./scheduler.test.ts.
import { THUMBNAIL_MIN_INTERVAL_MS } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import {
  CaptureScheduler,
  REMOTE_JITTER_MAX_MS,
  REMOTE_JITTER_MIN_MS,
  RENDER_QUIET_MS,
  type RenderResult,
  type SchedulerTiming,
  type SendResult,
  UPLOAD_MIN_GAP_MS,
  UPLOAD_QUIET_MS,
} from './scheduler.ts'

const image = (tag = 'a'): RenderResult => ({
  kind: 'image',
  blob: new Blob([tag], { type: 'image/webp' }),
  type: 'image/webp',
  width: 480,
  height: 300,
})

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

/** One clock and its timers, run in order as time advances. */
function clock(start = 2_000_000) {
  let t = start
  let seq = 1
  const timers: { at: number; fn: () => void; id: number }[] = []
  return {
    now: () => t,
    setTimeout: (fn: () => void, ms: number) => {
      const id = seq++
      timers.push({ at: t + Math.max(0, ms), fn, id })
      return id
    },
    clearTimeout: (id: unknown) => {
      const i = timers.findIndex((x) => x.id === id)
      if (i >= 0) timers.splice(i, 1)
    },
    pending: () => timers.length,
    async advance(ms: number) {
      const end = t + ms
      for (;;) {
        timers.sort((a, b) => a.at - b.at)
        const next = timers[0]
        if (!next || next.at > end) break
        timers.shift()
        t = next.at
        next.fn()
        await flush()
      }
      t = end
      await flush()
    },
  }
}

/** One client, whose renders and sends the test records and answers. */
function harness(opts: { random?: () => number } = {}) {
  const c = clock()
  const h = {
    renderResult: image() as RenderResult,
    sendResult: { ok: true, version: 'v' } as SendResult,
    renders: [] as number[],
    sends: [] as { at: number; kind: string }[],
    /** While set, uploads stay in flight until it resolves. */
    gate: null as Promise<void> | null,
    now: c.now,
    advance: c.advance,
    pendingTimers: c.pending,
  }
  const s = new CaptureScheduler({
    now: c.now,
    setTimeout: c.setTimeout,
    clearTimeout: c.clearTimeout,
    isBusy: () => false,
    render: async () => {
      h.renders.push(c.now())
      return h.renderResult
    },
    send: async (r) => {
      h.sends.push({ at: c.now(), kind: r.kind })
      if (h.gate) await h.gate
      return h.sendResult
    },
    random: opts.random ?? (() => 0.5),
  })
  return { h, s }
}

/**
 * Several clients on ONE board and one clock, against a fake api with the real per-board window (one accepted
 * upload per THUMBNAIL_MIN_INTERVAL_MS, else 429 with Retry-After) that tells every client's event stream of
 * each accepted upload `latencyMs` later. `stream: false` is the build before K6-3 (nobody hears of it).
 */
function board(opts: {
  clients: number
  latencyMs?: number
  stream?: boolean
  random: () => number
  timing?: Partial<SchedulerTiming>
}) {
  const c = clock()
  const accepted: { at: number; by: number; version: string }[] = []
  const refused: { at: number; by: number }[] = []
  let lastAccepted = Number.NEGATIVE_INFINITY
  let versions = 0
  const schedulers: CaptureScheduler[] = []
  for (let n = 0; n < opts.clients; n++) {
    const me = n
    schedulers.push(
      new CaptureScheduler({
        now: c.now,
        setTimeout: c.setTimeout,
        clearTimeout: c.clearTimeout,
        isBusy: () => false,
        render: async () => image(`client ${me}`),
        random: opts.random,
        ...(opts.timing ? { timing: opts.timing } : {}),
        send: async (): Promise<SendResult> => {
          if (c.now() - lastAccepted < THUMBNAIL_MIN_INTERVAL_MS) {
            refused.push({ at: c.now(), by: me })
            return { ok: false, retryAfterMs: lastAccepted + THUMBNAIL_MIN_INTERVAL_MS - c.now() }
          }
          lastAccepted = c.now()
          const version = `v${++versions}`
          accepted.push({ at: c.now(), by: me, version })
          if (opts.stream !== false)
            c.setTimeout(() => {
              for (const s of schedulers) s.noteRemoteUpload(version)
            }, opts.latencyMs ?? 300)
          return { ok: true, version }
        },
      }),
    )
  }
  return { schedulers, accepted, refused, advance: c.advance }
}

/** A deterministic 0..1 sequence (an LCG): the jitter draws of a run. */
const seeded = (seed: number) => () => {
  seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
  return seed / 2_147_483_648
}

/**
 * Everyone edits on and off for `minutes` (bursts of `burstMs` with a change every `stepMs`, then a pause, each
 * person on their own offset), then everyone stops.
 */
async function coEdit(
  b: ReturnType<typeof board>,
  minutes: number,
  opts: { stepMs?: number; burstMs?: number; cycleMs?: number } = {},
) {
  const step = opts.stepMs ?? 4_000
  const burst = opts.burstMs ?? 30_000
  const cycle = opts.cycleMs ?? 70_000
  for (let t = 0; t < minutes * 60_000; t += step) {
    for (const [n, s] of b.schedulers.entries()) if ((t + n * 23_000) % cycle < burst) s.noteChange()
    await b.advance(step)
  }
  await b.advance(10 * 60_000)
}

describe('K6-3: another client’s upload (the board stream’s thumbnail.updated)', () => {
  it(`within THUMBNAIL_MIN_INTERVAL_MS cancels this client’s pending upload; the next waits ${UPLOAD_MIN_GAP_MS / 1000} s after theirs plus the jitter, drawn again`, async () => {
    const { h, s } = harness({ random: () => 0.25 })
    s.noteChange()
    await h.advance(RENDER_QUIET_MS)
    expect(h.renders).toHaveLength(1)
    // someone else's upload arrives before ours was due (20 s after the change)
    await h.advance(5_000)
    const heardAt = h.now()
    s.noteRemoteUpload('v-theirs')
    await h.advance(UPLOAD_QUIET_MS)
    expect(h.sends).toEqual([]) // cancelled: it would only have met the api's window (429)
    const jitter = REMOTE_JITTER_MIN_MS + 0.25 * (REMOTE_JITTER_MAX_MS - REMOTE_JITTER_MIN_MS)
    await h.advance(UPLOAD_MIN_GAP_MS + REMOTE_JITTER_MAX_MS)
    // their picture is newer than ours: ours is drawn again, then sent once, after the gap and the jitter
    expect(h.renders).toHaveLength(2)
    expect(h.sends).toHaveLength(1)
    expect((h.sends[0]?.at ?? 0) - heardAt).toBe(UPLOAD_MIN_GAP_MS + jitter)
    expect((h.renders[1] ?? 0) - heardAt).toBeLessThan(UPLOAD_MIN_GAP_MS)
  })

  it('this client’s own upload coming back on the stream changes nothing, also when it arrives before the PUT’s answer', async () => {
    const { h, s } = harness()
    h.sendResult = { ok: true, version: 'v-mine' }
    s.noteChange()
    await h.advance(UPLOAD_QUIET_MS)
    expect(h.sends).toHaveLength(1)
    s.noteRemoteUpload('v-mine')
    s.noteChange()
    await h.advance(UPLOAD_MIN_GAP_MS)
    expect(h.sends).toHaveLength(2) // exactly the 2-minute gap: no jitter added
    // published before the response: heard while the upload is still in flight
    let open: () => void = () => {}
    h.gate = new Promise<void>((r) => {
      open = r
    })
    h.sendResult = { ok: true, version: 'v-mine-2' }
    s.noteChange()
    await h.advance(UPLOAD_MIN_GAP_MS)
    expect(h.sends).toHaveLength(3)
    s.noteRemoteUpload('v-mine-2')
    h.gate = null
    open()
    await h.advance(0)
    s.noteChange()
    await h.advance(UPLOAD_MIN_GAP_MS)
    expect(h.sends).toHaveLength(4)
  })

  it('someone else’s upload heard while ours is in flight still counts once ours is answered', async () => {
    const { h, s } = harness()
    let open: () => void = () => {}
    h.gate = new Promise<void>((r) => {
      open = r
    })
    h.sendResult = { ok: true, version: 'v-mine' }
    s.noteChange()
    await h.advance(UPLOAD_QUIET_MS)
    expect(h.sends).toHaveLength(1)
    s.noteRemoteUpload('v-theirs')
    h.gate = null
    open()
    await h.advance(0)
    s.noteChange()
    await h.advance(UPLOAD_MIN_GAP_MS)
    expect(h.sends).toHaveLength(1) // theirs moved our next one past the gap, by the jitter
    await h.advance(REMOTE_JITTER_MAX_MS)
    expect(h.sends).toHaveLength(2)
  })

  it('a 429 is rescheduled once, after Retry-After (not at once), with the picture drawn again', async () => {
    const { h, s } = harness()
    h.sendResult = { ok: false, retryAfterMs: 12_000 }
    s.noteChange()
    await h.advance(UPLOAD_QUIET_MS)
    expect(h.sends).toHaveLength(1)
    // someone's newer picture was there: ours is drawn again (once, for the retry)
    expect(h.renders).toHaveLength(2)
    h.sendResult = { ok: true, version: 'v2' }
    await h.advance(12_000 - 1)
    expect(h.sends).toHaveLength(1) // not retried at once, nor before Retry-After
    await h.advance(1)
    expect(h.sends).toHaveLength(2)
    expect(h.renders).toHaveLength(2)
    await h.advance(10 * 60_000)
    expect(h.sends).toHaveLength(2) // once
    expect(h.pendingTimers()).toBe(0)
  })

  it('a removal by someone else counts too; this client’s own removal does not', async () => {
    const { h, s } = harness()
    h.renderResult = { kind: 'empty' }
    s.setRemote(true)
    s.noteChange()
    await h.advance(UPLOAD_QUIET_MS)
    expect(h.sends).toEqual([expect.objectContaining({ kind: 'empty' })])
    s.noteRemoteUpload(null) // our own removal, on the stream
    h.renderResult = image('b')
    s.noteChange()
    await h.advance(UPLOAD_MIN_GAP_MS)
    expect(h.sends).toHaveLength(2)
    await h.advance(20_000)
    s.noteRemoteUpload(null) // someone else's, later
    s.noteChange()
    await h.advance(UPLOAD_MIN_GAP_MS)
    expect(h.sends).toHaveLength(2)
    await h.advance(REMOTE_JITTER_MAX_MS)
    expect(h.sends).toHaveLength(3)
  })

  it('closing the board hands over a leftover that waits for the api window after someone else’s upload', async () => {
    const { h, s } = harness({ random: () => 0 })
    s.noteChange()
    await h.advance(RENDER_QUIET_MS)
    s.noteRemoteUpload('v-theirs')
    const heardAt = h.now()
    s.noteChange()
    await h.advance(RENDER_QUIET_MS)
    const left = s.dispose()
    expect(left?.notBefore).toBe(heardAt + THUMBNAIL_MIN_INTERVAL_MS + REMOTE_JITTER_MIN_MS)
  })

  it('three people editing one board for 30 minutes: no 429, about one upload per board every 2 minutes', async () => {
    const b = board({ clients: 3, random: seeded(7) })
    await coEdit(b, 30)
    expect(b.refused).toEqual([])
    expect(b.accepted.length).toBeGreaterThan(5)
    expect(b.accepted.length).toBeLessThanOrEqual(Math.ceil((30 * 60_000) / UPLOAD_MIN_GAP_MS) + 2)
    for (let i = 1; i < b.accepted.length; i++)
      expect((b.accepted[i]?.at ?? 0) - (b.accepted[i - 1]?.at ?? 0)).toBeGreaterThanOrEqual(
        THUMBNAIL_MIN_INTERVAL_MS,
      )
  })

  it('control: without the stream (the build before K6-3) the same three people meet the api’s window', async () => {
    const b = board({ clients: 3, stream: false, random: seeded(7) })
    await coEdit(b, 30)
    expect(b.refused.length).toBeGreaterThan(0)
  })

  it('with the shortened waits of a test build, two clients editing nonstop never collide', async () => {
    const b = board({
      clients: 2,
      random: seeded(11),
      timing: {
        renderQuietMs: 300,
        uploadQuietMs: 600,
        uploadMinGapMs: 1_000,
        remoteJitterMinMs: 2_000,
        remoteJitterMaxMs: 6_000,
      },
    })
    await coEdit(b, 2, { stepMs: 500, burstMs: 5_000, cycleMs: 8_000 })
    expect(b.refused).toEqual([])
    // the api's window (30 s) is the limit then: about one upload per 30 s
    expect(b.accepted.length).toBeGreaterThanOrEqual(3)
  })
})
