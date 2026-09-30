import { describe, expect, it } from 'vitest'
import { installDerivativeSwap } from './swap.ts'

const VER = 'ver_AAAAAAAAAAAAAAAAAAAA'

interface El {
  id: string
  type: string
  fileId: string
  x: number
  y: number
  width: number
  height: number
  crop?: unknown
}

function rig(opts: { els: El[]; zoom: number }) {
  let now = 0
  let els = opts.els
  const states = new Map<string, string>()
  const requested: string[] = []
  const held = new Map<string, number>()
  const applied: { id: string; fileId: string }[][] = []
  const listeners = new Set<() => void>()
  const swap = installDerivativeSwap({
    api: {
      getSceneElements: () => els as never,
      getAppState: () =>
        ({ scrollX: 0, scrollY: 0, width: 1000, height: 800, zoom: { value: opts.zoom } }) as never,
      onChange: ((l: () => void) => {
        listeners.add(l)
        return () => {
          listeners.delete(l)
        }
      }) as never,
    },
    loader: () => ({
      request: (ids: Iterable<string>) => {
        for (const id of ids) {
          requested.push(id)
          if (!states.has(id)) states.set(id, 'loading')
        }
      },
      state: (k: string) => states.get(k) as never,
      hold: (k: string) => {
        held.set(k, (held.get(k) ?? 0) + 1)
        return () => held.set(k, (held.get(k) ?? 1) - 1)
      },
    }),
    apply: (s) => {
      applied.push([...s])
      els = els.map((e) => {
        const to = s.find((x) => x.id === e.id)
        return to ? { ...e, fileId: to.fileId } : e
      })
    },
    dpr: () => 1,
    policy: { now: () => now },
    schedule: () => {}, // the test drives sync()
  })
  return {
    swap,
    states,
    requested,
    held,
    applied,
    tick: (ms: number) => {
      now += ms
      swap.sync()
    },
    setEls: (next: El[]) => {
      els = next
    },
    els: () => els,
  }
}

const img = (over: Partial<El> = {}): El => ({
  id: 'i1',
  type: 'image',
  fileId: VER,
  x: 0,
  y: 0,
  width: 800,
  height: 600,
  ...over,
})

describe('the derivative swap', () => {
  it('loads display first, then switches the local fileId (held until the engine has it)', () => {
    const r = rig({ els: [img()], zoom: 1 })
    r.tick(0) // shown large: the dwell starts
    expect(r.requested).toEqual([])
    r.tick(350) // past 300 ms: display is requested and held
    expect(r.requested).toEqual([`${VER}@display`])
    expect(r.held.get(`${VER}@display`)).toBe(1)
    expect(r.applied).toEqual([])
    r.states.set(`${VER}@display`, 'loaded')
    r.tick(16)
    expect(r.applied).toEqual([[{ id: 'i1', fileId: `${VER}@display` }]])
    expect(r.held.get(`${VER}@display`)).toBe(0)
    expect(r.swap.upgrades).toBe(1)
    r.swap.dispose()
  })

  it('never upgrades small or cropped images', () => {
    const small = rig({ els: [img({ width: 300, height: 200 })], zoom: 1 })
    small.tick(0)
    small.tick(400)
    expect(small.requested).toEqual([])
    const cropped = rig({ els: [img({ crop: { x: 0, y: 0, width: 10, height: 10 } })], zoom: 1 })
    cropped.tick(0)
    cropped.tick(400)
    expect(cropped.requested).toEqual([])
  })

  it('puts an image the server copy reset back on its loaded display file, without a new upgrade', () => {
    const r = rig({ els: [img()], zoom: 1 })
    r.tick(0)
    r.tick(350)
    r.states.set(`${VER}@display`, 'loaded')
    r.tick(16)
    expect(r.swap.upgrades).toBe(1)
    // a remote move: the scene copy is the server's again (no local suffix)
    r.setEls([img({ x: 40 })])
    r.tick(16)
    expect(r.applied.at(-1)).toEqual([{ id: 'i1', fileId: `${VER}@display` }])
    expect(r.swap.upgrades).toBe(1)
    r.swap.dispose()
  })
})
