// OWNER: W5 (wave M, M5-5). countUsage and its transport, and the contract's lists against
// what the web really has: every static command of the board features is a PALETTE_COMMAND_IDS member (so
// `palette.run:<id>` can count it), and the template ids are the picker's.
import {
  PALETTE_COMMAND_IDS,
  PENDING_PALETTE_COMMAND_IDS,
  USAGE_BATCH_MAX_KEYS,
  USAGE_COUNT_CAP,
  USAGE_EMPTY_HINT_ACTIONS,
  USAGE_EVENTS,
  USAGE_TEMPLATE_IDS,
  UsageBatch,
  type UsageEvent,
} from '@draftroom/contracts'
import { TEMPLATE_INFOS } from '@draftroom/templates/plan'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CANVAS_FEATURES } from '../features/canvas-registry.ts'
import {
  countUsage,
  pendingUsage,
  resetUsageForTests,
  startUsageTransport,
  takeUsageBatch,
  type UsageTransportDeps,
} from './usage.ts'

afterEach(() => resetUsageForTests())

describe('countUsage (in memory until the transport sends it)', () => {
  it('a fixed family typed from its list type-checks as a template (scripts/usage-events.test.ts accepts it too)', () => {
    for (const action of USAGE_EMPTY_HINT_ACTIONS) countUsage(`emptyhint.${action}`)
    const step: 'shown' | 'good' | 'issue' = 'good'
    countUsage(`feedback.prompt.${step}`)
    const how = 'cold' as 'cached' | 'cold'
    countUsage(`open.${how}`)
    expect(Object.keys(pendingUsage()).sort()).toEqual(
      [...USAGE_EMPTY_HINT_ACTIONS.map((a) => `emptyhint.${a}`), 'feedback.prompt.good', 'open.cold'].sort(),
    )
    for (const k of Object.keys(pendingUsage())) expect(USAGE_EVENTS as readonly string[]).toContain(k)
  })

  it('counts per event, and a batch is a valid POST /api/usage body that starts the count again', () => {
    countUsage('coach.shown')
    countUsage('coach.shown')
    countUsage('palette.open:key')
    expect(pendingUsage()).toEqual({ 'coach.shown': 2, 'palette.open:key': 1 })
    const batch = takeUsageBatch()
    expect(batch).toEqual({ events: { 'coach.shown': 2, 'palette.open:key': 1 } })
    expect(UsageBatch.safeParse(batch).success).toBe(true)
    expect(takeUsageBatch()).toBeNull()
    expect(pendingUsage()).toEqual({})
  })

  it('caps each event and the number of events; ignores what is not an event; never throws', () => {
    for (let i = 0; i < USAGE_COUNT_CAP + 20; i++) countUsage('open.cold')
    expect(pendingUsage()['open.cold']).toBe(USAGE_COUNT_CAP)
    for (const e of USAGE_EVENTS.slice(0, USAGE_BATCH_MAX_KEYS + 10)) countUsage(e)
    expect(Object.keys(pendingUsage())).toHaveLength(USAGE_BATCH_MAX_KEYS)
    resetUsageForTests()
    expect(() => countUsage('board:b-abc123' as UsageEvent)).not.toThrow()
    expect(pendingUsage()).toEqual({})
    for (const e of USAGE_EVENTS.slice(0, USAGE_BATCH_MAX_KEYS)) countUsage(e)
    expect(UsageBatch.safeParse(takeUsageBatch()).success).toBe(true)
  })

  it('in a page without a window (a worker, a test) nothing is sent: no fetch, no beacon', () => {
    const calls: string[] = []
    const g = globalThis as { fetch?: unknown; navigator?: unknown }
    const fetchBefore = g.fetch
    g.fetch = (...a: unknown[]) => {
      calls.push(String(a[0]))
      return Promise.reject(new Error('no'))
    }
    try {
      for (let i = 0; i < 5; i++) countUsage('version.notice')
      expect(calls).toEqual([])
    } finally {
      g.fetch = fetchBefore
    }
  })
})

// ---- the transport (M5-5) ----------------------------------------------------------------------------------------

/** A page: its visibility, its window's pagehide, a fetch and a beacon that record, and the flush timer by hand. */
function page(opts: { status?: number; beacon?: 'ok' | 'refused' | 'throws' | 'none' } = {}) {
  const win = new EventTarget()
  const doc = { visibilityState: 'visible' as DocumentVisibilityState }
  const sent: { via: 'fetch' | 'beacon'; body: unknown; keepalive?: boolean; type?: string }[] = []
  let status = opts.status ?? 204
  let tickFn: (() => void) | null = null
  const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(String(url)).toBe('/api/usage')
    expect(init?.method).toBe('POST')
    expect(init?.credentials).toBe('same-origin')
    expect((init?.headers ?? {}) as Record<string, string>).toMatchObject({
      'content-type': 'application/json',
    })
    sent.push({ via: 'fetch', body: JSON.parse(String(init?.body)), keepalive: init?.keepalive === true })
    if (status === 0) throw new TypeError('Failed to fetch')
    return new Response(null, { status })
  }) as unknown as typeof fetch
  const beaconMode = opts.beacon ?? 'ok'
  const beacon =
    beaconMode === 'none'
      ? undefined
      : (url: string, data: Blob) => {
          expect(url).toBe('/api/usage')
          if (beaconMode === 'throws') throw new TypeError('not allowed')
          if (beaconMode === 'refused') return false
          sent.push({ via: 'beacon', body: data, type: data.type })
          return true
        }
  const deps: UsageTransportDeps = {
    fetch: fetchImpl,
    doc,
    win: win as unknown as Window,
    ...(beacon ? { beacon } : {}),
    setInterval: (fn) => {
      tickFn = fn
      return 1
    },
    clearInterval: () => {
      tickFn = null
    },
  }
  const stop = startUsageTransport(deps)
  return {
    sent,
    stop,
    hide: () => {
      doc.visibilityState = 'hidden'
    },
    show: () => {
      doc.visibilityState = 'visible'
    },
    pagehide: () => win.dispatchEvent(new Event('pagehide')),
    /** the 5-minute timer fires, and its request settles */
    async flush() {
      tickFn?.()
      await new Promise((r) => setTimeout(r, 0))
    },
    answer: (s: number) => {
      status = s
    },
    get ticking() {
      return tickFn !== null
    },
  }
}

describe('the usage transport (M5-5)', () => {
  it('batches: every flush while visible sends what was counted since the last, once', async () => {
    const p = page()
    countUsage('coach.shown')
    countUsage('coach.shown')
    countUsage('palette.open:key')
    await p.flush()
    expect(p.sent).toEqual([
      { via: 'fetch', body: { events: { 'coach.shown': 2, 'palette.open:key': 1 } }, keepalive: false },
    ])
    expect(pendingUsage()).toEqual({})
    await p.flush() // nothing new: nothing sent
    expect(p.sent).toHaveLength(1)
    countUsage('open.cold')
    await p.flush()
    expect(p.sent.map((s) => s.body)).toEqual([
      { events: { 'coach.shown': 2, 'palette.open:key': 1 } },
      { events: { 'open.cold': 1 } },
    ])
    p.stop()
    expect(p.ticking).toBe(false)
  })

  it('nothing is sent while the tab is hidden; pagehide sends what is left, as a JSON beacon', async () => {
    const p = page()
    countUsage('follow.pause')
    p.hide()
    await p.flush()
    await p.flush()
    expect(p.sent).toEqual([])
    countUsage('follow.pause')
    p.pagehide()
    expect(p.sent).toHaveLength(1)
    expect(p.sent[0]?.via).toBe('beacon')
    expect(p.sent[0]?.type).toBe('application/json')
    expect(JSON.parse(await (p.sent[0] as { body: Blob }).body.text())).toEqual({
      events: { 'follow.pause': 2 },
    })
    // a second pagehide with nothing counted sends nothing
    p.pagehide()
    expect(p.sent).toHaveLength(1)
    // shown again (back from the back/forward cache): the flushes resume
    p.show()
    countUsage('compass.click')
    await p.flush()
    expect(p.sent.at(-1)).toEqual({
      via: 'fetch',
      body: { events: { 'compass.click': 1 } },
      keepalive: false,
    })
    p.stop()
  })

  it('a refused (or throwing) beacon, or none at all, is a keepalive fetch instead', async () => {
    for (const mode of ['refused', 'throws', 'none'] as const) {
      resetUsageForTests()
      const p = page({ beacon: mode })
      countUsage('version.notice')
      p.pagehide()
      expect(p.sent, mode).toEqual([
        { via: 'fetch', body: { events: { 'version.notice': 1 } }, keepalive: true },
      ])
      p.stop()
    }
  })

  it('a 404 (an api from before wave M) drops silently, and nothing more is sent from the tab', async () => {
    const p = page({ status: 404 })
    countUsage('open.cached')
    await p.flush()
    expect(p.sent).toHaveLength(1)
    countUsage('open.cached')
    await p.flush()
    p.pagehide()
    expect(p.sent).toHaveLength(1)
    expect(pendingUsage()).toEqual({})
    p.stop()
  })

  it('a 429, a server error or no answer puts the counts back for the next flush (capped); a 400 drops them', async () => {
    const p = page({ status: 429 })
    countUsage('stalechunk.notice')
    await p.flush()
    expect(pendingUsage()).toEqual({ 'stalechunk.notice': 1 })
    countUsage('stalechunk.notice')
    p.answer(503)
    await p.flush()
    expect(pendingUsage()).toEqual({ 'stalechunk.notice': 2 })
    p.answer(0)
    await p.flush()
    expect(pendingUsage()).toEqual({ 'stalechunk.notice': 2 })
    p.answer(204)
    await p.flush()
    expect(p.sent.at(-1)?.body).toEqual({ events: { 'stalechunk.notice': 2 } })
    expect(pendingUsage()).toEqual({})
    p.answer(400)
    countUsage('stalechunk.reload')
    await p.flush()
    expect(pendingUsage()).toEqual({})
    // put back never passes the cap
    p.answer(429)
    for (let i = 0; i < USAGE_COUNT_CAP; i++) countUsage('timetravel.scrub')
    await p.flush()
    for (let i = 0; i < 10; i++) countUsage('timetravel.scrub')
    expect(pendingUsage()['timetravel.scrub']).toBe(USAGE_COUNT_CAP)
    p.stop()
  })

  it('every batch it sends is a valid POST /api/usage body', async () => {
    const p = page()
    for (const e of USAGE_EVENTS.slice(0, USAGE_BATCH_MAX_KEYS + 5)) countUsage(e)
    await p.flush()
    expect(UsageBatch.safeParse(p.sent[0]?.body).success).toBe(true)
    p.stop()
  })
})

describe('the contract’s lists match the web', () => {
  it('every static command of the board features is a palette command id (pending ones aside, all are)', () => {
    const ids = CANVAS_FEATURES.flatMap((f) => (f.commands ?? []).map((c) => c.id))
    const known = new Set<string>(PALETTE_COMMAND_IDS)
    expect(ids.filter((id) => !known.has(id))).toEqual([])
    // and the list names nothing else, except the commands still to come (W8)
    const live = new Set(ids)
    expect(PALETTE_COMMAND_IDS.filter((id) => !live.has(id))).toEqual([...PENDING_PALETTE_COMMAND_IDS])
  })

  it('the template ids are the picker’s', () => {
    expect([...USAGE_TEMPLATE_IDS].sort()).toEqual(TEMPLATE_INFOS.map((t) => t.id).sort())
  })
})
