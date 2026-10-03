import { describe, expect, it } from 'vitest'
import { ImageLoader } from './loader.ts'
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

function rig(opts: { els: El[]; zoom: number; cropping?: string }) {
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
        ({
          scrollX: 0,
          scrollY: 0,
          width: 1000,
          height: 800,
          zoom: { value: opts.zoom },
          croppingElementId: opts.cropping ?? null,
        }) as never,
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
    // the pending hold is released; the upgraded image holds its display file itself (CR-W5-3G-3)
    expect(r.held.get(`${VER}@display`)).toBe(1)
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

// CR-W5-3G-3: the swap against the real loader and the board page's retainOnly (canvas/files/board.ts
// calls it with the scene's fileIds whenever they change). Before, a moment on the wire id (an undo's
// install, a full server copy) let retainOnly revoke the display file the swap had released at its
// switch: the swap then waited for a 'loaded' that never came, with the image on its thumb for good.
describe('the derivative swap and the loader (CR-W5-3G-3)', () => {
  function realRig() {
    let now = 0
    let els: El[] = [img()]
    const loader = new ImageLoader({
      addFiles: () => {},
      resolveUrl: (ver, d) => `/files/ast_x/${ver}/d/${d}`,
      fetch: async () =>
        new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'content-type': 'image/webp' } }),
      decode: async () => {},
      createObjectURL: (() => {
        let n = 0
        return () => `blob:test/${++n}`
      })(),
      revokeObjectURL: () => {},
      scheduleFlush: (fn) => queueMicrotask(fn),
    })
    /** board.ts's scene sync: request what the scene uses, revoke what it no longer uses */
    const sceneSync = () => {
      loader.syncScene(els)
      loader.retainOnly(new Set(els.filter((e) => !('isDeleted' in e && e.isDeleted)).map((e) => e.fileId)))
    }
    const swap = installDerivativeSwap({
      api: {
        getSceneElements: () => els as never,
        getAppState: () =>
          ({ scrollX: 0, scrollY: 0, width: 1000, height: 800, zoom: { value: 1 } }) as never,
        onChange: (() => () => {}) as never,
      },
      loader: () => loader,
      apply: (s) => {
        els = els.map((e) => {
          const to = s.find((x) => x.id === e.id)
          return to ? { ...e, fileId: to.fileId } : e
        })
        sceneSync()
      },
      dpr: () => 1,
      policy: { now: () => now },
      schedule: () => {},
    })
    const settle = async () => {
      for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0))
    }
    const tick = (ms: number) => {
      now += ms
      swap.sync()
    }
    return {
      swap,
      loader,
      tick,
      settle,
      sceneSync,
      els: () => els,
      setEls: (next: El[]) => {
        els = next
        sceneSync()
      },
    }
  }

  async function upgraded() {
    const r = realRig()
    r.sceneSync()
    await r.settle()
    r.tick(0)
    r.tick(350) // the display rendering is requested
    await r.settle()
    r.tick(16) // loaded: switched
    expect(r.els()[0]?.fileId).toBe(`${VER}@display`)
    expect(r.swap.upgrades).toBe(1)
    return r
  }

  it('a moment on the wire id never loses the display file: the switch back is at once, with no new upgrade', async () => {
    const r = await upgraded()
    // an undo's install (or any full copy) puts the element on its wire id: the scene sync runs first
    r.setEls([img({ x: 12 })])
    expect(r.loader.state(`${VER}@display`)).toBe('loaded')
    r.tick(16)
    expect(r.els()[0]).toMatchObject({ x: 12, fileId: `${VER}@display` })
    expect(r.swap.upgrades).toBe(1)
    r.swap.dispose()
  })

  it('the display file is let go once the image is deleted or replaced, and on dispose', async () => {
    const del = await upgraded()
    del.setEls([])
    del.tick(16)
    del.sceneSync()
    expect(del.loader.state(`${VER}@display`)).toBeUndefined()
    const rep = await upgraded()
    rep.setEls([img({ fileId: 'ver_BBBBBBBBBBBBBBBBBBBB' })])
    rep.tick(16)
    rep.sceneSync()
    expect(rep.loader.state(`${VER}@display`)).toBeUndefined()
    const gone = await upgraded()
    gone.swap.dispose()
    gone.setEls([img()])
    expect(gone.loader.state(`${VER}@display`)).toBeUndefined()
  })
})

// CR-W5-3G-2: the crop rule inside the swap (the files part's filtered view and keeper are gone). A crop
// is in the pixels of the thumb every tab loads, so a cropped image, and the one in the crop editor, is
// never upgraded and never shown from a larger rendering.
describe('the derivative swap keeps cropped images on their thumb (CR-W5-3G-2)', () => {
  it('a remote crop of an upgraded image puts it back on its thumb; uncropped, it may upgrade again', () => {
    const r = rig({ els: [img()], zoom: 1 })
    r.tick(0)
    r.tick(350)
    r.states.set(`${VER}@display`, 'loaded')
    r.tick(16)
    expect(r.els()[0]?.fileId).toBe(`${VER}@display`)
    // bob crops it: the server copy arrives with the crop, the core keeps the local suffix
    r.setEls([img({ fileId: `${VER}@display`, crop: { x: 0, y: 0, width: 100, height: 100 } })])
    r.tick(16)
    expect(r.els()[0]?.fileId).toBe(VER)
    expect(r.held.get(`${VER}@display`)).toBe(0)
    // shown large for long: never upgraded while cropped
    r.tick(400)
    r.tick(400)
    expect(r.els()[0]?.fileId).toBe(VER)
    // the crop removed: the policy decides again
    r.setEls([img()])
    r.tick(0)
    r.tick(350)
    r.tick(16)
    expect(r.els()[0]?.fileId).toBe(`${VER}@display`)
    expect(r.swap.upgrades).toBe(2)
    r.swap.dispose()
  })

  it('the image in the crop editor is never upgraded, and toThumb switches at once', () => {
    const r = rig({ els: [img(), img({ id: 'i2', x: 900 })], zoom: 1, cropping: 'i1' })
    r.tick(0)
    r.tick(350)
    expect(r.requested).toEqual([`${VER}@display`])
    r.states.set(`${VER}@display`, 'loaded')
    r.tick(16)
    expect(r.els().map((e) => e.fileId)).toEqual([VER, `${VER}@display`])
    r.swap.toThumb(['i2'])
    expect(r.applied.at(-1)).toEqual([{ id: 'i2', fileId: VER }])
    expect(r.held.get(`${VER}@display`)).toBe(0)
    r.swap.dispose()
  })

  it('switches a cropped image back to its thumb with no loader on the page yet', () => {
    let els: El[] = [img({ fileId: `${VER}@display`, crop: { x: 0, y: 0, width: 1, height: 1 } })]
    const swap = installDerivativeSwap({
      api: {
        getSceneElements: () => els as never,
        getAppState: () =>
          ({ scrollX: 0, scrollY: 0, width: 1000, height: 800, zoom: { value: 1 } }) as never,
        onChange: (() => () => {}) as never,
      },
      loader: () => null,
      apply: (s) => {
        els = els.map((e) => ({ ...e, fileId: s.find((x) => x.id === e.id)?.fileId ?? e.fileId }))
      },
      schedule: () => {},
    })
    swap.sync()
    expect(els[0]?.fileId).toBe(VER)
    swap.dispose()
  })
})
