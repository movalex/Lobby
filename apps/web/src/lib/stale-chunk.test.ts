// K1-7 (wave K): lib/stale-chunk.ts. A chunk a deploy removed reloads the page once outside a board (a
// sessionStorage guard, read and written in try/catch, stops a loop); on a board it never reloads by
// itself: it shows a notice with a Reload button, which waits for changes not yet acknowledged.
import { describe, expect, it } from 'vitest'
import { createBoardCode } from './prefetch-board.ts'
import {
  createStaleChunkHandler,
  installStaleChunkRecovery,
  isStaleChunkError,
  RELOAD_GUARD_MS,
  RELOAD_KEY,
  recoverChunk,
  STALE_NOTICE_KEY,
  type StaleNotice,
  UNSENT_WAIT_MS,
} from './stale-chunk.ts'

const STALE = new TypeError(
  'Failed to fetch dynamically imported module: https://lobby.example/assets/LobbyBoardPage-Ab12Cd.js',
)

function env(opts: { storage?: 'ok' | 'throws' | 'none'; now?: number } = {}) {
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
