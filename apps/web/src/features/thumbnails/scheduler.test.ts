import { THUMBNAIL_MIN_INTERVAL_MS } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import {
  BUSY_RETRY_MS,
  CaptureScheduler,
  ERROR_BACKOFF_MS,
  RENDER_QUIET_MS,
  type RenderResult,
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

/** A scheduler on a fake clock: timers run in order as time advances. */
function harness() {
  let t = 1_000_000
  let seq = 1
  const timers: { at: number; fn: () => void; id: number }[] = []
  const h = {
    busy: false,
    renderResult: image() as RenderResult,
    sendResult: { ok: true, version: 'v' } as SendResult,
    renders: [] as { at: number; force: boolean }[],
    sends: [] as { at: number; kind: string; keepalive: boolean }[],
    states: [] as string[],
    now: () => t,
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
    pendingTimers: () => timers.length,
  }
  const scheduler = new CaptureScheduler({
    now: () => t,
    setTimeout: (fn, ms) => {
      const id = seq++
      timers.push({ at: t + ms, fn, id })
      return id
    },
    clearTimeout: (id) => {
      const i = timers.findIndex((x) => x.id === id)
      if (i >= 0) timers.splice(i, 1)
    },
    isBusy: () => h.busy,
    render: async ({ force }) => {
      h.renders.push({ at: t, force })
      return h.renderResult
    },
    send: async (r, { keepalive }) => {
      h.sends.push({ at: t, kind: r.kind, keepalive })
      return h.sendResult
    },
    onStatus: (s) => h.states.push(s.state),
  })
  return { h, s: scheduler }
}

describe('thumbnail capture scheduler', () => {
  it('never captures per change: one render once changes settle, one upload 20 s after they settle', async () => {
    const { h, s } = harness()
    const start = h.now()
    for (let i = 0; i < 10; i++) {
      s.noteChange()
      await h.advance(500)
    }
    const lastChange = start + 9 * 500
    expect(h.renders).toEqual([])
    await h.advance(RENDER_QUIET_MS)
    expect(h.renders).toEqual([{ at: lastChange + RENDER_QUIET_MS, force: false }])
    expect(h.sends).toEqual([])
    await h.advance(UPLOAD_QUIET_MS)
    expect(h.sends).toEqual([{ at: lastChange + UPLOAD_QUIET_MS, kind: 'image', keepalive: false }])
    expect(h.states).toEqual(['rendering', 'rendered', 'uploading', 'uploaded'])
    // Nothing changed since: nothing more happens, and no timer is left running.
    await h.advance(10 * 60_000)
    expect(h.renders).toHaveLength(1)
    expect(h.sends).toHaveLength(1)
    expect(h.pendingTimers()).toBe(0)
  })

  it('a change during the quiet period restarts it; changes after a render cause a new render', async () => {
    const { h, s } = harness()
    s.noteChange()
    await h.advance(RENDER_QUIET_MS + 10)
    expect(h.renders).toHaveLength(1)
    await h.advance(5_000)
    s.noteChange()
    await h.advance(UPLOAD_QUIET_MS - 1)
    expect(h.renders).toHaveLength(2)
    expect(h.sends).toHaveLength(0) // 20 s after the LAST change, not the first
    await h.advance(1)
    expect(h.sends).toHaveLength(1)
  })

  it('uploads at most every 2 minutes while someone keeps editing', async () => {
    const { h, s } = harness()
    s.noteChange()
    await h.advance(UPLOAD_QUIET_MS)
    expect(h.sends).toHaveLength(1)
    const firstAt = h.sends[0]?.at ?? 0
    s.noteChange()
    await h.advance(UPLOAD_QUIET_MS + 1)
    expect(h.sends).toHaveLength(1)
    await h.advance(UPLOAD_MIN_GAP_MS)
    expect(h.sends).toHaveLength(2)
    expect((h.sends[1]?.at ?? 0) - firstAt).toBe(UPLOAD_MIN_GAP_MS)
  })

  it('never renders while the person is busy (dragging, panning, typing)', async () => {
    const { h, s } = harness()
    h.busy = true
    s.noteChange()
    await h.advance(RENDER_QUIET_MS + 10 * BUSY_RETRY_MS)
    expect(h.renders).toEqual([])
    h.busy = false
    await h.advance(BUSY_RETRY_MS)
    expect(h.renders).toHaveLength(1)
  })

  it('a render that finds the person busy is retried shortly, without counting as done', async () => {
    const { h, s } = harness()
    h.renderResult = { kind: 'busy' }
    s.noteChange()
    await h.advance(RENDER_QUIET_MS)
    expect(h.renders).toHaveLength(1)
    h.renderResult = image()
    await h.advance(BUSY_RETRY_MS)
    expect(h.renders).toHaveLength(2)
    await h.advance(UPLOAD_QUIET_MS)
    expect(h.sends).toHaveLength(1)
  })

  it('tab hidden: renders at once (forced) and sends with keepalive, without the 20 s or 2 min waits', async () => {
    const { h, s } = harness()
    s.noteChange()
    await h.advance(UPLOAD_QUIET_MS) // first upload
    await h.advance(THUMBNAIL_MIN_INTERVAL_MS)
    s.noteChange()
    await h.advance(100)
    h.busy = true // e.g. still holding the mouse button when switching tabs
    s.leave('hidden')
    await h.advance(0)
    expect(h.renders.at(-1)).toMatchObject({ force: true })
    expect(h.sends).toHaveLength(2)
    expect(h.sends[1]).toMatchObject({ kind: 'image', keepalive: true })
    // Nothing left to do afterwards.
    await h.advance(10 * 60_000)
    expect(h.sends).toHaveLength(2)
  })

  it('leaving never sends inside the api window (one upload per board per 30 s)', async () => {
    const { h, s } = harness()
    s.noteChange()
    await h.advance(UPLOAD_QUIET_MS)
    s.noteChange()
    await h.advance(RENDER_QUIET_MS)
    s.leave('hidden')
    s.leave('pagehide')
    await h.advance(0)
    expect(h.sends).toHaveLength(1)
    // The board closes: what is left goes once the window opens.
    const left = s.dispose()
    expect(left?.rendered.kind).toBe('image')
    expect(left?.notBefore).toBe((h.sends[0]?.at ?? 0) + THUMBNAIL_MIN_INTERVAL_MS)
  })

  it('hidden inside the api window: rendered at once, and still sent later by the usual schedule', async () => {
    const { h, s } = harness()
    s.noteChange()
    await h.advance(UPLOAD_QUIET_MS)
    const firstAt = h.sends[0]?.at ?? 0
    s.noteChange()
    s.leave('hidden')
    await h.advance(0)
    expect(h.renders.at(-1)).toMatchObject({ force: true })
    expect(h.sends).toHaveLength(1) // inside the 30 s window: not even tried
    await h.advance(UPLOAD_MIN_GAP_MS)
    expect(h.sends).toHaveLength(2)
    expect(h.sends[1]?.at).toBe(firstAt + UPLOAD_MIN_GAP_MS)
    expect(h.renders).toHaveLength(2) // the forced render was not repeated
  })

  it('pagehide sends what was already rendered (it cannot wait for a render)', async () => {
    const { h, s } = harness()
    s.noteChange()
    await h.advance(RENDER_QUIET_MS)
    s.leave('pagehide')
    await h.advance(0)
    expect(h.sends).toEqual([expect.objectContaining({ kind: 'image', keepalive: true })])
    s.noteChange() // not rendered yet: pagehide has nothing new to send
    s.leave('pagehide')
    await h.advance(0)
    expect(h.renders).toHaveLength(1)
    expect(h.sends).toHaveLength(1)
  })

  it('closing the board hands over only a rendered, unsent image', async () => {
    const a = harness()
    expect(a.s.dispose()).toBeNull() // nothing changed
    const b = harness()
    b.s.noteChange()
    expect(b.s.dispose()).toBeNull() // changed but not rendered yet
    const c = harness()
    c.s.noteChange()
    await c.h.advance(RENDER_QUIET_MS)
    const left = c.s.dispose()
    expect(left?.rendered.kind).toBe('image')
    expect(left?.notBefore).toBeLessThanOrEqual(c.h.now())
    // Disposed: no timer fires any more.
    await c.h.advance(10 * 60_000)
    expect(c.h.sends).toEqual([])
    const d = harness()
    d.s.noteChange()
    await d.h.advance(UPLOAD_QUIET_MS)
    expect(d.s.dispose()).toBeNull() // already sent
  })

  it('a 429 waits for Retry-After; other failures back off; refusals of the image drop it', async () => {
    const { h, s } = harness()
    h.sendResult = { ok: false, retryAfterMs: 12_000 }
    s.noteChange()
    await h.advance(UPLOAD_QUIET_MS)
    expect(h.sends).toHaveLength(1)
    h.sendResult = { ok: false }
    await h.advance(12_000)
    expect(h.sends).toHaveLength(2)
    await h.advance(ERROR_BACKOFF_MS - 1)
    expect(h.sends).toHaveLength(2)
    h.sendResult = { ok: false, drop: true }
    await h.advance(1)
    expect(h.sends).toHaveLength(3)
    await h.advance(10 * 60_000)
    expect(h.sends).toHaveLength(3) // dropped until the next change
    h.sendResult = { ok: true, version: 'v2' }
    s.noteChange()
    await h.advance(UPLOAD_QUIET_MS)
    expect(h.sends).toHaveLength(4)
  })

  it('no permission (or signed out) stops this board session for good', async () => {
    const { h, s } = harness()
    h.sendResult = { ok: false, stop: true }
    s.noteChange()
    await h.advance(UPLOAD_QUIET_MS)
    expect(h.states.at(-1)).toBe('off')
    s.noteChange()
    s.leave('hidden')
    await h.advance(10 * 60_000)
    expect(h.renders).toHaveLength(1)
    expect(h.sends).toHaveLength(1)
  })

  it('an empty board removes a stored thumbnail, and does nothing when none is stored', async () => {
    const { h, s } = harness()
    h.renderResult = { kind: 'empty' }
    s.setRemote(true)
    s.noteChange()
    await h.advance(UPLOAD_QUIET_MS)
    expect(h.sends).toEqual([expect.objectContaining({ kind: 'empty' })])
    // Now none is stored: clearing again sends nothing.
    await h.advance(UPLOAD_MIN_GAP_MS)
    s.noteChange()
    await h.advance(UPLOAD_QUIET_MS)
    expect(h.sends).toHaveLength(1)
    expect(s.dispose()).toBeNull()

    const other = harness()
    other.h.renderResult = { kind: 'empty' }
    other.s.setRemote(false)
    other.s.noteChange()
    await other.h.advance(UPLOAD_QUIET_MS)
    expect(other.h.sends).toEqual([])
  })

  it('a skipped render (too many shapes, too large) sends nothing, not even an older image', async () => {
    const { h, s } = harness()
    s.noteChange()
    await h.advance(RENDER_QUIET_MS)
    h.renderResult = { kind: 'skipped' }
    s.noteChange()
    await h.advance(UPLOAD_QUIET_MS)
    expect(h.renders).toHaveLength(2)
    expect(h.sends).toEqual([])
    expect(h.states).toContain('skipped')
    expect(s.dispose()).toBeNull()
  })
})
