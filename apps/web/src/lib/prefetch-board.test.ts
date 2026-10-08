// K1-1 (wave K): lib/prefetch-board.ts, the board code. It downloads once per tab (idempotent), a failed
// download may be asked for again, and the module-load start (App.tsx, while it is evaluated) fires only on a
// board address, so a board link opened cold downloads the code alongside the sign-in check.
import { describe, expect, it, vi } from 'vitest'
import { createBoardCode, startBoardCodeFor } from './prefetch-board.ts'

// the real board page would bring the whole engine into Node: a stand-in that counts its evaluations
const evaluated = vi.hoisted(() => ({ count: 0 }))
vi.mock('../canvas/board/LobbyBoardPage.tsx', () => {
  evaluated.count++
  return { default: () => null, LobbyBoardPage: () => null }
})

describe('the board code (K1-1)', () => {
  it('loads once: concurrent and later calls share one import', async () => {
    let calls = 0
    const code = createBoardCode(async () => ({ n: ++calls }))
    const a = code.load()
    const b = code.load()
    expect(a).toBe(b)
    expect(await a).toEqual({ n: 1 })
    expect(await code.load()).toEqual({ n: 1 })
    expect(calls).toBe(1)
    expect(code.started).toBe(true)
  })

  it('a failed download may be asked for again (a deploy, the network)', async () => {
    let calls = 0
    const code = createBoardCode(async () => {
      calls++
      if (calls === 1) throw new TypeError('Failed to fetch dynamically imported module: /assets/x.js')
      return 'ok'
    })
    await expect(code.load()).rejects.toThrow(/dynamically imported/)
    expect(code.started).toBe(false)
    expect(await code.load()).toBe('ok')
    expect(calls).toBe(2)
  })

  it('the real loadBoardCode imports the board page module once', async () => {
    vi.resetModules()
    evaluated.count = 0
    const fresh = await import('./prefetch-board.ts')
    const a = fresh.loadBoardCode()
    expect(fresh.loadBoardCode()).toBe(a)
    expect(typeof (await a).default).toBe('function')
    expect(evaluated.count).toBe(1)
  })

  it('the module-load start fires only on a board address (matchRoute "board")', () => {
    const cases: [string, boolean][] = [
      ['/b/b-3k9x0q2m7a', true],
      ['/b/b-3k9x0q2m7a/', true],
      ['/b/bad id!', false],
      ['/b/', false],
      ['/', false],
      ['/signin', false],
      ['/w/wsp_0123456789ab', false],
      ['/w/wsp_0123456789ab/all', false],
      ['/invite/some-token', false],
      ['/feedback', false],
      ['/spike/host-lab', false],
      ['/nothing/here', false],
    ]
    for (const [path, want] of cases) {
      let loads = 0
      const fired = startBoardCodeFor(path, async () => {
        loads++
      })
      expect(fired, path).toBe(want)
      expect(loads, path).toBe(want ? 1 : 0)
    }
  })

  it('a failed module-load start is never an unhandled rejection (the board route reports it)', async () => {
    const seen: unknown[] = []
    const onUnhandled = (e: unknown) => seen.push(e)
    process.on('unhandledRejection', onUnhandled)
    try {
      startBoardCodeFor('/b/b-3k9x0q2m7a', () => Promise.reject(new TypeError('Failed to fetch')))
      await new Promise((r) => setTimeout(r, 10))
      expect(seen).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('App.tsx starts it while it is evaluated, with the address it was opened at', async () => {
    const { readFileSync } = await import('node:fs')
    const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
    // at the top level of the module (not inside a component), before the first render
    const top = app.slice(0, app.indexOf('export function App('))
    expect(top).toMatch(/\n\s*startBoardCodeFor\(location\.pathname\)\n/)
    // and the board route is in the app's bundle: one lazy step, the board page's chunk
    expect(app).toMatch(/\nimport BoardRoute from '\.\/canvas\/board\/route\.tsx'\n/)
    expect(app).not.toMatch(/import\(['"]\.\/canvas\/board\/route\.tsx['"]\)/)
  })
})
