// K1-3 (wave K): lib/prefetch-board.ts, the board code ahead of a click. `prefetchBoardCode()` imports once
// (idempotent) and is skipped when the browser asks to save data; a pointer, a focus or a press on a link to
// a board prefetches it (document-level delegation, installed by App.tsx); a dashboard (or the sign-in page
// on its way to a board) prefetches once the page is idle, never on a 2G connection.
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  boardOfLink,
  createBoardCode,
  IDLE_DELAY_MS,
  installBoardPrefetch,
  prefetchBoardCodeWhenIdle,
  returnsToBoard,
} from './prefetch-board.ts'

// the real board page would bring the whole engine into Node: a stand-in that counts its evaluations
const evaluated = vi.hoisted(() => ({ count: 0 }))
vi.mock('../canvas/board/LobbyBoardPage.tsx', () => {
  evaluated.count++
  return { default: () => null, LobbyBoardPage: () => null }
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('prefetchBoardCode (K1-3)', () => {
  it('a prefetch starts the one download; later prefetches and loads share it', async () => {
    let calls = 0
    const code = createBoardCode(async () => ++calls, { saveData: () => false })
    expect(code.prefetch()).toBe(true)
    expect(code.prefetch()).toBe(true)
    expect(await code.load()).toBe(1)
    expect(calls).toBe(1)
  })

  it('skipped on Save-Data (no import); the real load still downloads', async () => {
    let calls = 0
    const code = createBoardCode(async () => ++calls, { saveData: () => true })
    expect(code.prefetch()).toBe(false)
    expect(code.prefetch()).toBe(false)
    expect(calls).toBe(0)
    expect(code.started).toBe(false)
    expect(await code.load()).toBe(1)
    // once it is there, a prefetch has nothing to do
    expect(code.prefetch()).toBe(true)
    expect(calls).toBe(1)
  })

  it('the real prefetchBoardCode imports the board page once, and not at all on Save-Data', async () => {
    vi.resetModules()
    evaluated.count = 0
    vi.stubGlobal('navigator', { connection: { saveData: true } })
    const fresh = await import('./prefetch-board.ts')
    expect(fresh.prefetchBoardCode()).toBe(false)
    await new Promise((r) => setTimeout(r, 0))
    expect(evaluated.count).toBe(0)
    vi.stubGlobal('navigator', { connection: { saveData: false } })
    expect(fresh.prefetchBoardCode()).toBe(true)
    expect(fresh.prefetchBoardCode()).toBe(true)
    const a = fresh.loadBoardCode()
    expect(fresh.loadBoardCode()).toBe(a)
    expect(typeof (await a).default).toBe('function')
    expect(evaluated.count).toBe(1)
  })

  it('App.tsx installs the link delegation once, while it is evaluated, and the idle prefetch on a dashboard', async () => {
    const { readFileSync } = await import('node:fs')
    const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
    const top = app.slice(0, app.indexOf('export function App('))
    expect(top).toMatch(/\n\s*installBoardPrefetch\(\)\n/)
    expect(app).toMatch(/<RequireSession>\s*<PrefetchBoardCodeWhenIdle \/>\s*<DashboardPage /)
  })
})

describe('prefetch on intent and when idle (K1-3)', () => {
  const origin = 'https://lobby.example'
  const link = (href: string) => {
    const a = { getAttribute: (n: string) => (n === 'href' ? href : null) }
    return { closest: (sel: string) => (sel === 'a[href]' ? a : null) }
  }

  it('a link to a board, and only that, names the board', () => {
    expect(boardOfLink(link('/b/b-3k9x0q2m7a') as never, origin)).toBe('b-3k9x0q2m7a')
    expect(boardOfLink(link(`${origin}/b/b-3k9x0q2m7a`) as never, origin)).toBe('b-3k9x0q2m7a')
    expect(boardOfLink(link('https://elsewhere.example/b/b-3k9x0q2m7a') as never, origin)).toBeNull()
    expect(boardOfLink(link('/w/wsp_0123456789ab') as never, origin)).toBeNull()
    expect(boardOfLink(link('/b/not a board') as never, origin)).toBeNull()
    expect(boardOfLink({ closest: () => null } as never, origin)).toBeNull()
    expect(boardOfLink(null, origin)).toBeNull()
  })

  it('pointer, focus and press on a board link prefetch; other targets do nothing; uninstall removes it all', () => {
    vi.stubGlobal('location', { origin, pathname: '/w/wsp_0123456789ab' })
    const handlers = new Map<string, (e: Event) => void>()
    const doc = {
      addEventListener: (t: string, fn: (e: Event) => void) => handlers.set(t, fn),
      removeEventListener: (t: string) => handlers.delete(t),
    }
    let prefetches = 0
    const off = installBoardPrefetch(doc as never, () => {
      prefetches++
      return true
    })
    expect([...handlers.keys()].sort()).toEqual(['click', 'focusin', 'pointerdown', 'pointerover'])
    handlers.get('pointerover')?.({ target: link('/b/b-intent00001') } as never)
    handlers.get('focusin')?.({ target: link('/b/b-intent00001') } as never)
    expect(prefetches).toBe(2)
    handlers.get('focusin')?.({ target: link('/w/wsp_0123456789ab/all') } as never)
    handlers.get('pointerover')?.({ target: { closest: () => null } } as never)
    expect(prefetches).toBe(2)
    off()
    expect(handlers.size).toBe(0)
  })

  it('the sign-in page prefetches only on its way to a board', () => {
    expect(returnsToBoard('?returnTo=%2Fb%2Fb-3k9x0q2m7a')).toBe(true)
    expect(returnsToBoard('?returnTo=%2Fb%2Fb-3k9x0q2m7a%3Fel%3Dabc')).toBe(true)
    expect(returnsToBoard('?returnTo=%2Fw%2Fwsp_0123456789ab')).toBe(false)
    expect(returnsToBoard('?returnTo=%2F%2Fevil.example%2Fb%2Fb-3k9x0q2m7a')).toBe(false)
    expect(returnsToBoard('?returnTo=https%3A%2F%2Fevil.example%2Fb%2Fb-3k9x0q2m7a')).toBe(false)
    expect(returnsToBoard('')).toBe(false)
  })

  it('when idle: after the dashboard’s first requests, through requestIdleCallback; cancelled when it leaves', () => {
    vi.useFakeTimers()
    let prefetches = 0
    const idle: (() => void)[] = []
    const win = {
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
      clearTimeout: (t: never) => clearTimeout(t),
      requestIdleCallback: (cb: () => void) => idle.push(cb),
      cancelIdleCallback: () => {},
    }
    const count = () => ++prefetches > 0
    prefetchBoardCodeWhenIdle(win as never, count, () => false)
    vi.advanceTimersByTime(IDLE_DELAY_MS - 1)
    expect(idle.length).toBe(0)
    vi.advanceTimersByTime(1)
    expect(idle.length).toBe(1)
    idle[0]?.()
    expect(prefetches).toBe(1)
    // a dashboard left before its idle time: nothing
    const cancel = prefetchBoardCodeWhenIdle(win as never, count, () => false)
    cancel()
    vi.advanceTimersByTime(IDLE_DELAY_MS * 10)
    expect(idle.length).toBe(1)
    // a 2G connection: no idle prefetch
    prefetchBoardCodeWhenIdle(win as never, count, () => true)
    vi.advanceTimersByTime(IDLE_DELAY_MS * 10)
    expect(idle.length).toBe(1)
    expect(prefetches).toBe(1)
  })

  it('without requestIdleCallback (Safari): a plain delay', () => {
    vi.useFakeTimers()
    let prefetches = 0
    const win = {
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
      clearTimeout: (t: never) => clearTimeout(t),
    }
    prefetchBoardCodeWhenIdle(
      win as never,
      () => ++prefetches > 0,
      () => false,
    )
    vi.advanceTimersByTime(IDLE_DELAY_MS * 4)
    expect(prefetches).toBe(1)
  })
})
