// K1-7 (wave K): lib/stale-chunk.ts. A chunk a deploy removed reloads the page once outside a board (a
// sessionStorage guard, read and written in try/catch, stops a loop); on a board it never reloads by
// itself: it shows a notice with a Reload button, which waits for changes not yet acknowledged.
import { describe, expect, it } from 'vitest'
import { createBoardCode } from './prefetch-board.ts'
import {
  chunkOwners,
  createStaleChunkHandler,
  EDITING_RECHECK_MS,
  installStaleChunkRecovery,
  isStaleChunkError,
  OFFLINE_CHUNK_TEXT,
  OFFLINE_RETURN_TEXT,
  ownedImport,
  RELOAD_GUARD_MS,
  RELOAD_KEY,
  recoverChunk,
  reloadWhenOnline,
  retryingImport,
  STALE_NOTICE_KEY,
  STALE_NOTICE_TEXT,
  type StaleNotice,
  UNSENT_WAIT_MS,
} from './stale-chunk.ts'

const STALE = new TypeError(
  'Failed to fetch dynamically imported module: https://lobby.example/assets/LobbyBoardPage-Ab12Cd.js',
)
const STALE_OTHER = new TypeError(
  'Failed to fetch dynamically imported module: https://lobby.example/assets/scene-Ef34Gh.js',
)
const SAFARI = new TypeError('Importing a module script failed.')

function env(opts: { storage?: 'ok' | 'throws' | 'none'; now?: number; offline?: boolean } = {}) {
  const store = new Map<string, string>()
  const timers: { fn: () => void; at: number }[] = []
  const e = {
    reloads: 0,
    t: opts.now ?? 1_000_000,
    store,
    reload: () => {
      e.reloads++
    },
    now: () => e.t,
    online: () => opts.offline !== true,
    storage: () => {
      if (opts.storage === 'none') return null
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
    setTimeout: (fn: () => void, ms: number) => {
      timers.push({ fn, at: e.t + ms })
      return timers.length
    },
    /** runs the timers due by `ms` from now */
    advance(ms: number) {
      const until = e.t + ms
      for (;;) {
        timers.sort((a, b) => a.at - b.at)
        const next = timers[0]
        if (!next || next.at > until) break
        timers.shift()
        e.t = next.at
        next.fn()
      }
      e.t = until
    },
  }
  return e
}

describe('isStaleChunkError', () => {
  it('knows the browsers’ and Vite’s words for a missing chunk, and nothing else', () => {
    expect(isStaleChunkError(STALE)).toBe(true)
    expect(isStaleChunkError(new TypeError('error loading dynamically imported module: /assets/x.js'))).toBe(
      true,
    )
    expect(isStaleChunkError(new TypeError('Importing a module script failed.'))).toBe(true)
    expect(isStaleChunkError(new Error('Unable to preload CSS for /assets/x.css'))).toBe(true)
    expect(isStaleChunkError(new Error('Network request failed'))).toBe(false)
    expect(isStaleChunkError(new Error('The board could not be opened.'))).toBe(false)
    expect(isStaleChunkError(null)).toBe(false)
    expect(isStaleChunkError({ message: 42 })).toBe(false)
  })
})

describe('outside a board: one reload, guarded', () => {
  it('reloads once; a second failure inside the guard shows the notice instead of reloading again', () => {
    const e = env()
    const h = createStaleChunkHandler(e)
    expect(h.report(STALE)).toBe('reload')
    expect(e.reloads).toBe(1)
    expect(e.store.get(RELOAD_KEY)).toBe(String(e.t))
    // the reload did not happen yet (or the new page failed at once): no second reload from this page
    expect(h.report(STALE)).toBe('reloading')
    expect(e.reloads).toBe(1)
    // the next page, still inside the guard: the notice, no loop
    const next = createStaleChunkHandler(e)
    let changes = 0
    next.subscribe(() => changes++)
    e.t += RELOAD_GUARD_MS - 1
    expect(next.report(STALE)).toBe('notice')
    expect(e.reloads).toBe(1)
    expect(changes).toBe(1)
    const n = next.notice() as StaleNotice
    expect(n.key).toBe(STALE_NOTICE_KEY)
    expect(n.action?.label).toBe('Reload')
    expect(n.timeoutMs).toBeNull()
    // the person's own Reload always reloads
    n.action?.onClick()
    expect(e.reloads).toBe(2)
    next.dismiss()
    expect(next.notice()).toBeNull()
  })

  it('after the guard has passed, a later deploy reloads once again', () => {
    const e = env()
    expect(createStaleChunkHandler(e).report(STALE)).toBe('reload')
    e.t += RELOAD_GUARD_MS
    expect(createStaleChunkHandler(e).report(STALE)).toBe('reload')
    expect(e.reloads).toBe(2)
  })

  it('offline (wave K round 2 refix): the connection notice, not “Lobby has been updated”, no Reload to the offline page, no reload', () => {
    const e = env({ offline: true })
    const h = createStaleChunkHandler(e)
    expect(h.report(STALE)).toBe('notice')
    expect(e.reloads).toBe(0)
    expect(e.store.has(RELOAD_KEY)).toBe(false)
    const n = h.notice() as StaleNotice
    expect(n).toMatchObject({
      key: STALE_NOTICE_KEY,
      text: OFFLINE_CHUNK_TEXT,
      testId: 'stale-chunk-offline-notice',
    })
    expect(n.text).not.toBe(STALE_NOTICE_TEXT)
    expect(n.action).toBeUndefined()
    expect(h.online()).toBe(false)
  })

  it('offline (round 2): opening a board whose code fails (no board registered yet) resolves to the offline fallback, not “updated”', async () => {
    const UPDATED = { default: 'updated' }
    const OFFLINE = { default: 'offline' }
    const off = env({ offline: true })
    const h = createStaleChunkHandler(off)
    expect(await recoverChunk(() => Promise.reject(STALE), UPDATED, h, OFFLINE)()).toBe(OFFLINE)
    expect(off.reloads).toBe(0)
    expect(h.notice()?.testId).toBe('stale-chunk-offline-notice')
    expect(h.notice()?.action).toBeUndefined()
    // online, the same failure is a deploy's: the updated fallback, and the page reloads once
    const on = env()
    const h2 = createStaleChunkHandler(on)
    expect(await recoverChunk(() => Promise.reject(STALE), UPDATED, h2, OFFLINE)()).toBe(UPDATED)
    expect(on.reloads).toBe(1)
    // without an offline fallback (other lazy pages), the one fallback, as before
    const h3 = createStaleChunkHandler(env({ offline: true }))
    expect(await recoverChunk(() => Promise.reject(STALE), UPDATED, h3)()).toBe(UPDATED)
  })

  it('storage that throws, or none: the notice, never a reload it could not guard', () => {
    for (const storage of ['throws', 'none'] as const) {
      const e = env({ storage })
      const h = createStaleChunkHandler(e)
      expect(h.report(STALE), storage).toBe('notice')
      expect(e.reloads, storage).toBe(0)
      expect(h.notice()?.testId).toBe('stale-chunk-notice')
    }
  })
})

describe('on a board: a notice, never a reload by itself', () => {
  it('with changes not yet acknowledged: no reload; the Reload button waits for them, then reloads', () => {
    const e = env()
    const h = createStaleChunkHandler(e)
    const notices: StaleNotice[] = []
    let unsent = true
    const off = h.registerBoard({ unsent: () => unsent, notify: (n) => notices.push(n) })
    expect(h.report(STALE)).toBe('notice')
    expect(e.reloads).toBe(0)
    expect(e.store.has(RELOAD_KEY)).toBe(false)
    expect(h.notice()).toBeNull() // the board's own notices show it
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ key: STALE_NOTICE_KEY, testId: 'stale-chunk-notice', timeoutMs: null })
    notices[0]?.action?.onClick()
    expect(e.reloads).toBe(0)
    e.advance(1_000)
    expect(e.reloads).toBe(0)
    unsent = false
    e.advance(100)
    expect(e.reloads).toBe(1)
    off()
  })

  it('the Reload button gives up waiting after UNSENT_WAIT_MS', () => {
    const e = env()
    const h = createStaleChunkHandler(e)
    const notices: StaleNotice[] = []
    h.registerBoard({ unsent: () => true, notify: (n) => notices.push(n) })
    h.report(STALE)
    notices[0]?.action?.onClick()
    e.advance(UNSENT_WAIT_MS - 200)
    expect(e.reloads).toBe(0)
    e.advance(300)
    expect(e.reloads).toBe(1)
  })

  it('with nothing unsent it still never reloads by itself; the button reloads at once', () => {
    const e = env()
    const h = createStaleChunkHandler(e)
    const notices: StaleNotice[] = []
    h.registerBoard({ unsent: () => false, notify: (n) => notices.push(n) })
    expect(h.report(STALE)).toBe('notice')
    expect(h.report(STALE)).toBe('notice') // the same key: the board shows one notice
    expect(e.reloads).toBe(0)
    notices[0]?.action?.onClick()
    expect(e.reloads).toBe(1)
  })

  it('offline (P-003, wave P): nothing at all, no notice and no reload (the board’s offline banner speaks)', () => {
    const e = env({ offline: true })
    const h = createStaleChunkHandler(e)
    const notices: StaleNotice[] = []
    h.registerBoard({ unsent: () => true, notify: (n) => notices.push(n) })
    expect(h.report(STALE)).toBe('quiet')
    expect(h.report(STALE)).toBe('quiet')
    e.advance(UNSENT_WAIT_MS * 2)
    expect(notices).toHaveLength(0)
    expect(h.notice()).toBeNull()
    expect(e.reloads).toBe(0)
  })

  it('P-003: a part that failed offline and fails again back online gets the calm words, with Reload', () => {
    let online = false
    const e = { ...env(), online: () => online }
    const h = createStaleChunkHandler(e)
    const notices: StaleNotice[] = []
    h.registerBoard({ unsent: () => false, notify: (n) => notices.push(n) })
    expect(h.report(STALE)).toBe('quiet')
    online = true
    expect(h.report(STALE)).toBe('notice')
    expect(notices).toHaveLength(1)
    expect(notices[0]?.text).toBe(OFFLINE_RETURN_TEXT)
    expect(notices[0]?.text).not.toBe(STALE_NOTICE_TEXT)
    expect(notices[0]?.action?.label).toBe('Reload')
    expect(e.reloads).toBe(0)
  })

  it('wave P review: the offline words are for the file that failed offline; a deploy later (another file) gets the update words', () => {
    let online = false
    const e = { ...env(), online: () => online }
    const h = createStaleChunkHandler(e)
    const notices: StaleNotice[] = []
    h.registerBoard({ unsent: () => false, notify: (n) => notices.push(n) })
    expect(h.report(STALE)).toBe('quiet')
    online = true
    // the browser kept its failed import: the same file fails again, as often as it is asked for
    h.report(STALE)
    h.report(new TypeError(STALE.message))
    expect(notices.map((n) => n.text)).toEqual([OFFLINE_RETURN_TEXT, OFFLINE_RETURN_TEXT])
    // hours later, a real deploy
    h.report(STALE_OTHER)
    expect(notices).toHaveLength(3)
    expect(notices[2]?.text).toBe(STALE_NOTICE_TEXT)
  })

  it('wave P review: a failure that names no file (Safari) gets the offline words once, for both of its reports', () => {
    let online = false
    const e = { ...env(), online: () => online }
    const h = createStaleChunkHandler(e)
    const notices: StaleNotice[] = []
    h.registerBoard({ unsent: () => false, notify: (n) => notices.push(n) })
    expect(h.report(SAFARI)).toBe('quiet')
    online = true
    const again = new TypeError(SAFARI.message)
    h.report(again) // Vite's event
    h.report(again) // the import's rejection: the same failure
    expect(notices.map((n) => n.text)).toEqual([OFFLINE_RETURN_TEXT, OFFLINE_RETURN_TEXT])
    // hours later, a real deploy
    h.report(new TypeError(SAFARI.message))
    expect(notices[2]?.text).toBe(STALE_NOTICE_TEXT)
  })

  it('wave P review: a part that loads after an offline failure clears it (a deploy later gets the update words)', () => {
    let online = false
    const e = { ...env(), online: () => online }
    const h = createStaleChunkHandler(e)
    const notices: StaleNotice[] = []
    h.registerBoard({ unsent: () => false, notify: (n) => notices.push(n) })
    expect(h.report(STALE)).toBe('quiet')
    online = true
    h.loaded()
    h.report(STALE)
    expect(notices).toHaveLength(1)
    expect(notices[0]?.text).toBe(STALE_NOTICE_TEXT)
  })

  it('P-003: never while someone types: the notice waits for the text editor to close', () => {
    const e = env()
    const h = createStaleChunkHandler(e)
    const notices: StaleNotice[] = []
    let editing = true
    h.registerBoard({ unsent: () => false, editing: () => editing, notify: (n) => notices.push(n) })
    expect(h.report(STALE)).toBe('notice')
    expect(h.newVersion(false, 'abcdef1')).toBe('notice')
    e.advance(EDITING_RECHECK_MS * 10)
    expect(notices).toHaveLength(0)
    editing = false
    e.advance(EDITING_RECHECK_MS)
    expect(notices).toHaveLength(1) // the latest one, once
    expect(notices[0]).toMatchObject({ key: STALE_NOTICE_KEY, text: STALE_NOTICE_TEXT })
    e.advance(EDITING_RECHECK_MS * 4)
    expect(notices).toHaveLength(1)
    expect(e.reloads).toBe(0)
  })

  it('P-003: a held notice is dropped when its board leaves', () => {
    const e = env()
    const h = createStaleChunkHandler(e)
    const notices: StaleNotice[] = []
    const off = h.registerBoard({ unsent: () => false, editing: () => true, notify: (n) => notices.push(n) })
    h.report(STALE)
    off()
    e.advance(EDITING_RECHECK_MS * 4)
    expect(notices).toHaveLength(0)
  })

  it('the board leaving: the next failure is outside a board again', () => {
    const e = env()
    const h = createStaleChunkHandler(e)
    const off = h.registerBoard({ unsent: () => false, notify: () => {} })
    off()
    expect(h.report(STALE)).toBe('reload')
  })
})

describe('the sources', () => {
  function fakeWindow() {
    const listeners = new Map<string, (e: Event) => void>()
    return {
      listeners,
      addEventListener: (t: string, fn: (e: Event) => void) => listeners.set(t, fn),
      removeEventListener: (t: string) => listeners.delete(t),
    }
  }

  it('vite:preloadError and an uncaught stale chunk rejection are reported; other rejections are not touched', () => {
    const win = fakeWindow()
    const reports: unknown[] = []
    const off = installStaleChunkRecovery(win, {
      report: (e) => {
        reports.push(e)
        return 'notice'
      },
    })
    win.listeners.get('vite:preloadError')?.(
      Object.assign(new Event('vite:preloadError'), { payload: STALE }),
    )
    expect(reports).toEqual([STALE])
    let prevented = 0
    const rejection = (reason: unknown) => ({ reason, preventDefault: () => prevented++ }) as unknown as Event
    win.listeners.get('unhandledrejection')?.(rejection(STALE))
    expect(reports).toEqual([STALE, STALE])
    expect(prevented).toBe(1)
    win.listeners.get('unhandledrejection')?.(rejection(new Error('something else')))
    expect(reports).toHaveLength(2)
    expect(prevented).toBe(1)
    off()
    expect(win.listeners.size).toBe(0)
  })

  it('a preloadError the caller says is nobody’s (a speculative prefetch) is not reported', () => {
    const win = fakeWindow()
    const reports: unknown[] = []
    let speculative = true
    installStaleChunkRecovery(
      win,
      {
        report: (e) => {
          reports.push(e)
          return 'notice'
        },
      },
      () => speculative,
    )
    const fire = () =>
      win.listeners.get('vite:preloadError')?.(
        Object.assign(new Event('vite:preloadError'), { payload: STALE }),
      )
    fire()
    expect(reports).toEqual([])
    speculative = false
    fire()
    expect(reports).toEqual([STALE])
  })

  it('recoverChunk: a stale chunk resolves to the fallback and is reported; other errors still throw', async () => {
    const reports: unknown[] = []
    const handler = {
      report: (e: unknown) => {
        reports.push(e)
        return 'notice' as const
      },
    }
    const fallback = { default: 'fallback' }
    const stale = recoverChunk(() => Promise.reject(STALE), fallback, handler)
    expect(await stale()).toBe(fallback)
    expect(reports).toEqual([STALE])
    const broken = recoverChunk(() => Promise.reject(new Error('a bug')), fallback, handler)
    await expect(broken()).rejects.toThrow('a bug')
    const fine = recoverChunk(() => Promise.resolve({ default: 'page' }), fallback, handler)
    expect(await fine()).toEqual({ default: 'page' })
    expect(reports).toHaveLength(1)
  })
})

describe('retryingImport (wave P review: a lazy part that failed to load is asked for again)', () => {
  function handler() {
    const h = {
      reports: [] as unknown[],
      loads: 0,
      report: (e: unknown) => {
        h.reports.push(e)
        return 'quiet' as const
      },
      loaded: () => {
        h.loads++
      },
    }
    return h
  }

  it('a failed attempt draws the fallback; once drawn, the next open imports again and can succeed', async () => {
    const h = handler()
    let calls = 0
    let offline = true
    const load = () => {
      calls++
      return offline ? Promise.reject(STALE) : Promise.resolve({ default: 'dialog' })
    }
    const imports = retryingImport(load, { default: 'nothing' }, h)
    const first = imports.attempt()
    expect(await first.result()).toEqual({ default: 'nothing' })
    expect(h.reports).toEqual([STALE])
    // the same mount draws again (a retry render after the suspense): the same attempt, no second import
    expect(imports.attempt()).toBe(first)
    expect(await first.result()).toEqual({ default: 'nothing' })
    expect(calls).toBe(1)
    imports.shown(first)
    offline = false
    const second = imports.attempt()
    expect(second).not.toBe(first)
    expect(await second.result()).toEqual({ default: 'dialog' })
    expect(calls).toBe(2)
    expect(h.loads).toBe(1)
    // a loaded attempt is kept
    imports.shown(second)
    expect(imports.attempt()).toBe(second)
    expect(calls).toBe(2)
  })

  it('other errors are thrown, not drawn as the fallback', async () => {
    const h = handler()
    const imports = retryingImport(() => Promise.reject(new Error('a bug')), { default: 'nothing' }, h)
    await expect(imports.attempt().result()).rejects.toThrow('a bug')
    expect(h.reports).toHaveLength(0)
  })

  it('recoverChunk tells the handler a part loaded', async () => {
    const h = handler()
    await recoverChunk(() => Promise.resolve({ default: 'page' }), { default: 'x' }, h)()
    expect(h.loads).toBe(1)
  })
})

describe('reloadWhenOnline (round 2: the board route’s offline fallback)', () => {
  function onlineWindow() {
    const listeners = new Map<string, (e: Event) => void>()
    return {
      listeners,
      addEventListener: (t: string, fn: (e: Event) => void) => listeners.set(t, fn),
      removeEventListener: (t: string, fn: (e: Event) => void) => {
        if (listeners.get(t) === fn) listeners.delete(t)
      },
    }
  }

  it('offline: nothing until the browser is back online, then one reload', () => {
    const win = onlineWindow()
    let reloads = 0
    reloadWhenOnline(
      win,
      () => false,
      () => reloads++,
    )
    expect(reloads).toBe(0)
    expect(win.listeners.has('online')).toBe(true)
    win.listeners.get('online')?.(new Event('online'))
    expect(reloads).toBe(1)
    expect(win.listeners.has('online')).toBe(false)
  })

  it('already back online: reloads at once; the cancel (the fallback unmounted) stops a pending one', () => {
    const win = onlineWindow()
    let reloads = 0
    reloadWhenOnline(
      win,
      () => true,
      () => reloads++,
    )
    expect(reloads).toBe(1)
    expect(win.listeners.size).toBe(0)
    const cancel = reloadWhenOnline(
      win,
      () => false,
      () => reloads++,
    )
    cancel()
    expect(win.listeners.size).toBe(0)
    expect(reloads).toBe(1)
  })

  it('the board route gives its board page an offline fallback that waits for the connection', async () => {
    const { readFileSync } = await import('node:fs')
    const route = readFileSync(new URL('../canvas/board/route.tsx', import.meta.url), 'utf8')
    expect(route).toContain('recoverChunk(loadBoardCode, UPDATED, staleChunks, OFFLINE)')
    expect(route).toContain('reloadWhenOnline()')
  })

  it('the feedback page (the other lazy page outside a board) has one too', async () => {
    const { readFileSync } = await import('node:fs')
    const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
    expect(app).toMatch(/{ default: FeedbackCodeOffline }/)
    expect(app).toContain('reloadWhenOnline()')
  })
})

describe('the board code prefetch is nobody’s to report (lib/prefetch-board.ts)', () => {
  it('a download a prefetch started is speculative until something asks for the module', async () => {
    let resolve: (v: string) => void = () => {}
    const code = createBoardCode(
      () =>
        new Promise<string>((r) => {
          resolve = r
        }),
      { saveData: () => false },
    )
    expect(code.speculative).toBe(false)
    code.prefetch()
    expect(code.speculative).toBe(true)
    const real = code.load() // the person opens a board meanwhile: its failure would be theirs to report
    expect(code.speculative).toBe(false)
    resolve('m')
    expect(await real).toBe('m')
    // a prefetch that settles on its own stops being speculative too
    let reject: (e: unknown) => void = () => {}
    const other = createBoardCode(
      () =>
        new Promise<string>((_, r) => {
          reject = r
        }),
      { saveData: () => false },
    )
    other.prefetch()
    expect(other.speculative).toBe(true)
    reject(STALE)
    await new Promise((r) => setTimeout(r, 0))
    expect(other.speculative).toBe(false)
    expect(other.started).toBe(false)
  })

  it('App.tsx installs the recovery once, while it is evaluated, ignoring the board code prefetch', async () => {
    const { readFileSync } = await import('node:fs')
    const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
    const top = app.slice(0, app.indexOf('export function App('))
    expect(top).toContain('installStaleChunkRecovery(window, staleChunks, isBoardCodePrefetch)')
  })
})

describe('fix/firefox: an owned import (a dashboard dialog in its LazyDialogBoundary) keeps its failure', () => {
  function fakeWindow() {
    const listeners = new Map<string, (e: Event) => void>()
    return {
      listeners,
      addEventListener: (t: string, fn: (e: Event) => void) => listeners.set(t, fn),
      removeEventListener: (t: string) => listeners.delete(t),
    }
  }
  /** What Vite's preload helper does with a chunk that is gone: the event first, then the import rejects with it. */
  const viteImport = (win: ReturnType<typeof fakeWindow>, error: Error) => () =>
    Promise.resolve().then(() => {
      win.listeners.get('vite:preloadError')?.(
        Object.assign(new Event('vite:preloadError'), { payload: error }),
      )
      throw error
    })
  function setup() {
    const win = fakeWindow()
    const reports: unknown[] = []
    const queued: (() => void)[] = []
    const off = installStaleChunkRecovery(
      win,
      {
        report: (e) => {
          reports.push(e)
          return 'reload'
        },
      },
      () => false,
      chunkOwners,
      (fn) => queued.push(fn),
    )
    const runLater = () => {
      for (const fn of queued.splice(0)) fn()
    }
    return { win, reports, runLater, off }
  }

  it('the Share chunk that is gone still rejects (the boundary shows its notice) and is never reported (no reload)', async () => {
    const { win, reports, runLater, off } = setup()
    const share = ownedImport(viteImport(win, STALE))
    await expect(share()).rejects.toBe(STALE)
    expect(reports).toEqual([])
    runLater()
    expect(reports).toEqual([])
    expect(chunkOwners.pending()).toBe(false)
    off()
  })

  it('another chunk that fails while an owned import is under way is reported, one task later', async () => {
    const { win, reports, runLater, off } = setup()
    let finish: (v: { default: string }) => void = () => {}
    const share = ownedImport(() => new Promise<{ default: string }>((r) => (finish = r)))
    const opened = share()
    expect(chunkOwners.pending()).toBe(true)
    win.listeners.get('vite:preloadError')?.(
      Object.assign(new Event('vite:preloadError'), { payload: STALE_OTHER }),
    )
    expect(reports).toEqual([])
    runLater()
    expect(reports).toEqual([STALE_OTHER])
    finish({ default: 'ShareDialog' })
    expect(await opened).toEqual({ default: 'ShareDialog' })
    expect(chunkOwners.pending()).toBe(false)
    // with no owned import under way a failure is reported at once, as before
    win.listeners.get('vite:preloadError')?.(
      Object.assign(new Event('vite:preloadError'), { payload: SAFARI }),
    )
    expect(reports).toEqual([STALE_OTHER, SAFARI])
    off()
  })

  it('an unowned import that fails is still reported (the board route, an export)', async () => {
    const { win, reports, runLater, off } = setup()
    await expect(viteImport(win, STALE)()).rejects.toBe(STALE)
    runLater()
    expect(reports).toEqual([STALE])
    off()
  })

  it('the dashboard’s boundary-guarded dialogs are owned: Share, the command palette and the Miro import', async () => {
    const { readFileSync } = await import('node:fs')
    const page = readFileSync(new URL('../dashboard/DashboardPage.tsx', import.meta.url), 'utf8')
    expect(page).toMatch(
      /const ShareDialog = lazy\(\s*ownedImport\(\(\) => import\('\.\.\/board\/ShareDialog\.tsx'\)/,
    )
    expect(page).toContain(
      "const DashboardPalette = lazy(ownedImport(() => import('../features/command-palette/dashboard.tsx')))",
    )
    const miro = readFileSync(new URL('../dashboard/import-miro/index.tsx', import.meta.url), 'utf8')
    expect(miro).toContain(
      "const MiroImportDialog = lazy(ownedImport(() => import('./MiroImportDialog.tsx')))",
    )
  })
})
