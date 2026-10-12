// W3 (wave M, M3-5, S2): open tabs learn about a new build. lib/version-check.ts asks /version.json when the tab becomes
// visible, on focus and every 15 minutes while it is visible, never while it is hidden, never the api, and backs off after
// three failures. A newer build is a notice on a board (the existing stale-chunk notice, whose Reload waits for unsent
// changes) and a silent reload outside one while the tab is hidden, under the K1-7 guard and one for the same build.
// The page behaviour is e2e/excalidraw/m3-version.spec.ts.
import type { UsageEvent } from '@draftroom/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createStaleChunkHandler,
  domHasTypedWork,
  RELOAD_GUARD_MS,
  RELOAD_KEY,
  STALE_NOTICE_KEY,
  STALE_NOTICE_TEXT,
  type StaleNotice,
  UNSENT_WAIT_MS,
  VERSION_RELOAD_GUARD_MS,
  VERSION_RELOAD_KEY,
} from './stale-chunk.ts'
import {
  browserVersionEnv,
  isNewerBuild,
  startVersionCheck,
  VERSION_BACKOFF_MS,
  VERSION_CHECK_MS,
  VERSION_FAIL_LIMIT,
  VERSION_MIN_GAP_MS,
  VERSION_URL,
  type VersionEnv,
} from './version-check.ts'

const OLD = '0123456789ab'
const NEW = 'feedc0ffee12'

/** A page: a clock, timers, a tab that is shown or hidden, and a /version.json that answers what the test says. */
function page(opts: { visible?: boolean; commit?: string; served?: string; storage?: 'ok' | 'throws' } = {}) {
  const store = new Map<string, string>()
  const timers = new Map<number, { fn: () => void; at: number }>()
  const listeners: Record<string, Set<() => void>> = { visibilitychange: new Set(), focus: new Set() }
  let next = 1
  const p = {
    t: 10_000_000,
    shown: opts.visible ?? true,
    served: opts.served ?? NEW,
    /** every fetch of /version.json, and whether the tab was shown */
    asks: [] as boolean[],
    failing: false,
    /** words typed into a dialog's field (the page's typed work) */
    typing: false,
    reloads: 0,
    counts: [] as UsageEvent[],
    store,
    commit: opts.commit ?? OLD,
    storage: () => {
      if (opts.storage === 'throws')
        return {
          getItem: () => {
            throw new Error('SecurityError')
          },
          setItem: () => {
            throw new Error('SecurityError')
          },
        }
      return {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
      }
    },
    versionEnv: undefined as unknown as VersionEnv,
    timerCount: () => timers.size,
    /** runs the timers due within `ms`, moving the clock with them */
    advance(ms: number) {
      const until = p.t + ms
      for (;;) {
        const due = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0]
        if (!due || due[1].at > until) break
        timers.delete(due[0])
        p.t = due[1].at
        due[1].fn()
      }
      p.t = until
    },
    show(visible: boolean) {
      p.shown = visible
      for (const fn of listeners.visibilitychange ?? []) fn()
    },
    focus() {
      for (const fn of listeners.focus ?? []) fn()
    },
  }
  p.versionEnv = {
    commit: p.commit,
    fetchCommit: async () => {
      p.asks.push(p.shown)
      if (p.failing) throw new Error('offline')
      return p.served
    },
    visible: () => p.shown,
    now: () => p.t,
    setTimeout: (fn, ms) => {
      const id = next++
      timers.set(id, { fn, at: p.t + ms })
      return id
    },
    clearTimeout: (h) => void timers.delete(h as number),
    listen: (event, fn) => {
      listeners[event]?.add(fn)
      return () => listeners[event]?.delete(fn)
    },
  }
  const handler = createStaleChunkHandler({
    reload: () => {
      p.reloads++
    },
    now: () => p.t,
    online: () => true,
    storage: p.storage,
    typedWork: () => p.typing,
    setTimeout: (fn, ms) => p.versionEnv.setTimeout(fn, ms),
    count: (e) => void p.counts.push(e),
  })
  return { p, handler }
}

/** Lets the promise of a fetch settle. */
const settle = () => new Promise<void>((r) => setTimeout(r, 0))

afterEach(() => vi.useRealTimers())

describe('when it asks', () => {
  it('never while the tab is hidden: not on focus, not on a timer, not when asked', async () => {
    const { p, handler } = page({ visible: false })
    const check = startVersionCheck(p.versionEnv, handler)
    p.focus()
    p.advance(VERSION_CHECK_MS * 4)
    await check.check()
    await settle()
    expect(p.asks).toEqual([])
    expect(p.timerCount()).toBe(0)
    check.stop()
  })

  it('on becoming visible, once even when focus arrives with it', async () => {
    const { p, handler } = page({ visible: false })
    const check = startVersionCheck(p.versionEnv, handler)
    p.show(true)
    p.focus()
    await settle()
    expect(p.asks).toEqual([true])
    check.stop()
  })

  it('every 15 minutes while it stays visible, and not once it is hidden', async () => {
    const { p, handler } = page({ served: OLD })
    const check = startVersionCheck(p.versionEnv, handler)
    // nothing at start: the page was just loaded with the build it runs
    expect(p.asks).toEqual([])
    p.advance(VERSION_CHECK_MS - 1)
    await settle()
    expect(p.asks).toEqual([])
    p.advance(1)
    await settle()
    expect(p.asks).toEqual([true])
    p.advance(VERSION_CHECK_MS)
    await settle()
    p.advance(VERSION_CHECK_MS)
    await settle()
    expect(p.asks).toEqual([true, true, true])
    // hidden: the timer goes, an hour passes, no request
    p.show(false)
    expect(p.timerCount()).toBe(0)
    p.advance(60 * 60_000)
    await settle()
    expect(p.asks).toHaveLength(3)
    // visible again: one request, and the cadence starts over
    p.show(true)
    await settle()
    expect(p.asks).toHaveLength(4)
    expect(p.asks.every(Boolean)).toBe(true)
    check.stop()
  })

  it('two asks are never within a minute of each other (a tab flipped back and forth)', async () => {
    const { p, handler } = page({ served: OLD })
    const check = startVersionCheck(p.versionEnv, handler)
    p.show(false)
    p.show(true)
    await settle()
    p.show(false)
    p.advance(VERSION_MIN_GAP_MS / 2)
    p.show(true)
    await settle()
    expect(p.asks).toHaveLength(1)
    p.show(false)
    p.advance(VERSION_MIN_GAP_MS)
    p.show(true)
    await settle()
    expect(p.asks).toHaveLength(2)
    check.stop()
  })

  it('backs off for an hour after three failures in a row, then asks again; a success clears the count', async () => {
    const { p, handler } = page({ served: OLD })
    const check = startVersionCheck(p.versionEnv, handler)
    p.failing = true
    for (let i = 0; i < VERSION_FAIL_LIMIT; i++) {
      p.advance(VERSION_CHECK_MS)
      await settle()
    }
    expect(p.asks).toHaveLength(VERSION_FAIL_LIMIT)
    // blocked: a focus, a visible event and the timer do nothing for an hour
    p.focus()
    p.show(false)
    p.show(true)
    p.advance(VERSION_BACKOFF_MS - VERSION_CHECK_MS)
    await settle()
    expect(p.asks).toHaveLength(VERSION_FAIL_LIMIT)
    p.failing = false
    p.advance(VERSION_CHECK_MS)
    await settle()
    expect(p.asks).toHaveLength(VERSION_FAIL_LIMIT + 1)
    // two failures and a success: the next failure is the first again, not the third
    p.failing = true
    p.advance(VERSION_CHECK_MS)
    await settle()
    p.advance(VERSION_CHECK_MS)
    await settle()
    p.failing = false
    p.advance(VERSION_CHECK_MS)
    await settle()
    p.failing = true
    p.advance(VERSION_CHECK_MS)
    await settle()
    p.advance(VERSION_CHECK_MS)
    await settle()
    p.advance(VERSION_CHECK_MS)
    await settle()
    expect(p.asks.length).toBe(VERSION_FAIL_LIMIT + 1 + 6)
    check.stop()
  })

  it('stops for good when stopped: no listener, no timer', async () => {
    const { p, handler } = page({ served: OLD })
    const check = startVersionCheck(p.versionEnv, handler)
    check.stop()
    p.focus()
    p.show(true)
    p.advance(VERSION_CHECK_MS * 3)
    await settle()
    expect(p.asks).toEqual([])
  })
})

describe('what a newer build is', () => {
  it('differs from the page’s own, both being commits; a build that cannot be compared is no news', () => {
    expect(isNewerBuild(OLD, NEW)).toBe(true)
    expect(isNewerBuild(OLD, OLD)).toBe(false)
    expect(isNewerBuild(OLD, OLD.toUpperCase())).toBe(false)
    expect(isNewerBuild('unknown', NEW)).toBe(false)
    expect(isNewerBuild(OLD, 'unknown')).toBe(false)
    expect(isNewerBuild(OLD, '')).toBe(false)
    expect(isNewerBuild(OLD, '<!doctype html>')).toBe(false)
  })

  it('the same commit never tells the page anything', async () => {
    const { p, handler } = page({ served: OLD })
    const check = startVersionCheck(p.versionEnv, handler)
    p.show(false)
    p.show(true)
    await settle()
    p.show(false)
    expect(check.stale()).toBeNull()
    expect(p.reloads).toBe(0)
    expect(handler.notice()).toBeNull()
    check.stop()
  })
})

describe('a newer build outside a board: a silent reload while the tab is hidden', () => {
  it('waits while the tab is shown, reloads once the tab is hidden, and writes the guards', async () => {
    const { p, handler } = page({ served: NEW })
    const check = startVersionCheck(p.versionEnv, handler)
    p.advance(VERSION_CHECK_MS)
    await settle()
    expect(check.stale()).toBe(NEW)
    // seen while the person is looking at the page: nothing visible happens
    expect(p.reloads).toBe(0)
    expect(handler.notice()).toBeNull()
    p.show(false)
    expect(p.reloads).toBe(1)
    expect(p.store.get(RELOAD_KEY)).toBe(String(p.t))
    expect(p.store.get(VERSION_RELOAD_KEY)).toBe(`${NEW}@${p.t}`)
    // a second hide does not reload again
    p.show(true)
    p.show(false)
    expect(p.reloads).toBe(1)
    expect(p.counts).toEqual(['stalechunk.reload'])
    check.stop()
  })

  it('reloads at once when the tab went hidden while the answer was on its way', async () => {
    const { p, handler } = page({ served: NEW })
    let release: (commit: string) => void = () => {}
    const env: VersionEnv = { ...p.versionEnv, fetchCommit: () => new Promise<string>((r) => (release = r)) }
    const check = startVersionCheck(env, handler)
    p.advance(VERSION_CHECK_MS)
    // hidden before the answer: nothing new is asked, and the answer that lands finds nobody looking
    p.show(false)
    expect(p.reloads).toBe(0)
    release(NEW)
    await settle()
    expect(p.reloads).toBe(1)
    check.stop()
  })

  it('the K1-7 guard: a page reloaded a moment ago does not reload again; it shows the notice with its button', async () => {
    const { p, handler } = page({ served: NEW })
    const check = startVersionCheck(p.versionEnv, handler)
    p.advance(VERSION_CHECK_MS)
    await settle()
    p.store.set(RELOAD_KEY, String(p.t - 1000))
    p.show(false)
    expect(p.reloads).toBe(0)
    const n = handler.notice()
    expect(n).toMatchObject({ key: STALE_NOTICE_KEY, text: STALE_NOTICE_TEXT })
    expect(n?.action?.label).toBe('Reload')
    expect(p.counts).toEqual(['version.notice'])
    check.stop()
    expect(RELOAD_GUARD_MS).toBeLessThan(VERSION_CHECK_MS)
  })

  it('the loop guard: after a reload for a build, the same build is not reloaded for again (a cache serving the old page)', async () => {
    const { p, handler } = page({ served: NEW })
    // the page reloaded for NEW ten minutes ago, and is still the old build
    p.store.set(VERSION_RELOAD_KEY, `${NEW}@${p.t - 10 * 60_000}`)
    const check = startVersionCheck(p.versionEnv, handler)
    p.advance(VERSION_CHECK_MS)
    await settle()
    p.show(false)
    expect(p.reloads).toBe(0)
    expect(handler.notice()).not.toBeNull()
    check.stop()
    // after VERSION_RELOAD_GUARD_MS it may try once more; a different build is a new reason at once
    const later = page({ served: NEW })
    later.p.store.set(VERSION_RELOAD_KEY, `${NEW}@${later.p.t - VERSION_RELOAD_GUARD_MS - 1}`)
    const c2 = startVersionCheck(later.p.versionEnv, later.handler)
    later.p.advance(VERSION_CHECK_MS)
    await settle()
    later.p.show(false)
    expect(later.p.reloads).toBe(1)
    c2.stop()
    const other = page({ served: 'abcdefabcdef' })
    other.p.store.set(VERSION_RELOAD_KEY, `${NEW}@${other.p.t - 1000}`)
    other.p.store.set(RELOAD_KEY, String(other.p.t - RELOAD_GUARD_MS - 1))
    const c3 = startVersionCheck(other.p.versionEnv, other.handler)
    other.p.advance(VERSION_CHECK_MS)
    await settle()
    other.p.show(false)
    expect(other.p.reloads).toBe(1)
    c3.stop()
  })

  it('storage that throws is a guard that cannot be read: the notice, never a loop', async () => {
    const { p, handler } = page({ served: NEW, storage: 'throws' })
    const check = startVersionCheck(p.versionEnv, handler)
    p.advance(VERSION_CHECK_MS)
    await settle()
    p.show(false)
    expect(p.reloads).toBe(0)
    expect(handler.notice()).toMatchObject({ key: STALE_NOTICE_KEY })
    check.stop()
  })
})

describe('N1 (wave M follow-up 3): a hidden tab with words typed into a dialog is not reloaded', () => {
  it('typed work in the page: no silent reload; the notice with its button waits for the person', async () => {
    const { p, handler } = page({ served: NEW })
    p.typing = true
    const check = startVersionCheck(p.versionEnv, handler)
    p.advance(VERSION_CHECK_MS)
    await settle()
    p.show(false)
    expect(p.reloads).toBe(0)
    expect(handler.notice()).toMatchObject({ key: STALE_NOTICE_KEY, text: STALE_NOTICE_TEXT })
    expect(handler.notice()?.action?.label).toBe('Reload')
    expect(p.counts).toEqual(['version.notice'])
    // and no guard was written for a reload that did not happen
    expect(p.store.get(RELOAD_KEY)).toBeUndefined()
    expect(p.store.get(VERSION_RELOAD_KEY)).toBeUndefined()
    check.stop()
  })

  it('the words gone (the dialog closed) before the tab is hidden: the silent reload as before', async () => {
    const { p, handler } = page({ served: NEW })
    p.typing = true
    const check = startVersionCheck(p.versionEnv, handler)
    p.advance(VERSION_CHECK_MS)
    await settle()
    p.typing = false
    p.show(false)
    expect(p.reloads).toBe(1)
    check.stop()
  })
})

describe('domHasTypedWork: words in a field of an open dialog or the feedback form', () => {
  const field = (type: string | null, value: string) => ({ type, value })
  const doc = (fields: { type: string | null; value: string }[]) => ({
    querySelectorAll: (selector: string) => {
      // the selector names the places a person types into: dialogs and the feedback form
      expect(selector).toMatch(/dialog/)
      return fields
    },
  })

  it('a text field, a search or a textarea with something in it is typed work; empty or blank is not', () => {
    expect(domHasTypedWork(doc([field('text', 'Sprint 12')]))).toBe(true)
    expect(domHasTypedWork(doc([field('email', 'a@b.co')]))).toBe(true)
    expect(domHasTypedWork(doc([field(null, 'a long feedback message')]))).toBe(true)
    expect(domHasTypedWork(doc([field('text', ''), field('text', '   ')]))).toBe(false)
    expect(domHasTypedWork(doc([]))).toBe(false)
  })

  it('a checkbox, a radio, a file, a hidden field or a button holds no words', () => {
    for (const type of ['checkbox', 'radio', 'file', 'hidden', 'button', 'submit', 'range', 'color'])
      expect(domHasTypedWork(doc([field(type, 'on')])), type).toBe(false)
  })

  it('a page it cannot read is no typed work (never blocks an update by throwing)', () => {
    expect(
      domHasTypedWork({
        querySelectorAll: () => {
          throw new Error('SecurityError')
        },
      }),
    ).toBe(false)
  })
})

describe('a newer build on a board: the notice, never a reload by itself', () => {
  function board(unsent: () => boolean) {
    const notices: StaleNotice[] = []
    return { notices, board: { unsent, notify: (n: StaleNotice) => void notices.push(n) } }
  }

  it('shows the stale-chunk notice (once per sighting) and does not reload, shown or hidden', async () => {
    const { p, handler } = page({ served: NEW })
    const b = board(() => false)
    handler.registerBoard(b.board)
    const check = startVersionCheck(p.versionEnv, handler)
    p.advance(VERSION_CHECK_MS)
    await settle()
    expect(b.notices.at(-1)).toMatchObject({ key: STALE_NOTICE_KEY, text: STALE_NOTICE_TEXT })
    p.show(false)
    p.show(true)
    expect(p.reloads).toBe(0)
    expect(p.counts.filter((e) => e === 'version.notice')).toHaveLength(1)
    check.stop()
  })

  it('its Reload waits for changes not yet acknowledged, then reloads', async () => {
    const { p, handler } = page({ served: NEW })
    let pending = true
    const b = board(() => pending)
    handler.registerBoard(b.board)
    const check = startVersionCheck(p.versionEnv, handler)
    p.advance(VERSION_CHECK_MS)
    await settle()
    b.notices.at(-1)?.action?.onClick()
    p.advance(UNSENT_WAIT_MS / 2)
    expect(p.reloads).toBe(0)
    pending = false
    p.advance(200)
    expect(p.reloads).toBe(1)
    expect(p.counts).toEqual(['version.notice', 'stalechunk.reload'])
    check.stop()
  })

  it('its Reload gives up waiting after UNSENT_WAIT_MS (a connection that never comes back must not trap the tab)', async () => {
    const { p, handler } = page({ served: NEW })
    const b = board(() => true)
    handler.registerBoard(b.board)
    const check = startVersionCheck(p.versionEnv, handler)
    p.advance(VERSION_CHECK_MS)
    await settle()
    b.notices.at(-1)?.action?.onClick()
    p.advance(UNSENT_WAIT_MS - 200)
    expect(p.reloads).toBe(0)
    p.advance(400)
    expect(p.reloads).toBe(1)
    check.stop()
  })

  it('a board opened after the newer build was seen shows the notice when it registers', async () => {
    const { p, handler } = page({ served: NEW })
    const check = startVersionCheck(p.versionEnv, handler)
    p.advance(VERSION_CHECK_MS)
    await settle()
    const b = board(() => false)
    handler.registerBoard(b.board)
    p.advance(1)
    expect(b.notices).toHaveLength(1)
    expect(b.notices[0]?.key).toBe(STALE_NOTICE_KEY)
    // a board that closed in between is not told
    const gone = board(() => false)
    const off = handler.registerBoard(gone.board)
    off()
    p.advance(1)
    expect(gone.notices).toEqual([])
    check.stop()
  })
})

describe('the browser’s environment', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('asks /version.json of its own origin, uncached and without credentials, and reads {commit}', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ commit: NEW }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const env = browserVersionEnv(OLD)
    expect(await env.fetchCommit(new AbortController().signal)).toBe(NEW)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(call[0]).toBe(VERSION_URL)
    expect(VERSION_URL).toBe('/version.json')
    expect(call[1]).toMatchObject({ cache: 'no-store', credentials: 'omit' })
  })

  it('rejects an error status, a body that is no JSON and a body without a commit (each a failure to back off from)', async () => {
    const answer = (body: BodyInit, status = 200) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(body, { status })),
      )
      return browserVersionEnv(OLD).fetchCommit(new AbortController().signal)
    }
    await expect(answer('{}', 503)).rejects.toThrow()
    await expect(answer('<!doctype html><html></html>')).rejects.toThrow()
    await expect(answer('{"commit":42}')).rejects.toThrow()
    await expect(answer('{}')).rejects.toThrow()
  })
})
