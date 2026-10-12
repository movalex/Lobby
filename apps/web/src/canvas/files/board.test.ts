// The board page's image loading kept in step with the scene (./board.ts installBoardFiles). Wave N.1: a camera move
// (the same element array) reads only the scene's images; a new array (elements came, went or were replaced) is
// read again: refs learned, new images requested, keys no element uses any more let go.
import { describe, expect, it, vi } from 'vitest'
import { installBoardFiles } from './board.ts'

const ver = (n: number) => `ver_${String(n).padStart(20, 'a')}`
const ast = (n: number) => `ast_${String(n).padStart(20, 'b')}`

const image = (n: number, x: number) => ({
  id: `img${n}`,
  type: 'image',
  isDeleted: false,
  fileId: ver(n),
  x,
  y: 0,
  width: 100,
  height: 100,
  customData: { lobby: { file: { assetId: ast(n), versionId: ver(n) } } },
})
const rect = (n: number) => ({ id: `r${n}`, type: 'rectangle', x: n, y: 0, width: 10, height: 10 })

function fakeApi(elements: readonly unknown[]) {
  let els = elements
  let state = { scrollX: 0, scrollY: 0, width: 500, height: 500, zoom: { value: 1 } }
  const listeners = new Set<() => void>()
  const getSceneElements = vi.fn(() => els)
  return {
    api: {
      addFiles: () => {},
      getAppState: () => state,
      getSceneElements,
      onChange: (l: () => void) => {
        listeners.add(l)
        return () => listeners.delete(l)
      },
    },
    getSceneElements,
    setElements(next: readonly unknown[]) {
      els = next
      for (const l of listeners) l()
    },
    pan(scrollX: number) {
      state = { ...state, scrollX }
      for (const l of listeners) l()
    },
  }
}

describe('installBoardFiles (wave N.1): a camera move reads the images only', () => {
  it('requests the images, follows a pan by their visibility, and reads a new element array again', () => {
    const f = fakeApi([image(1, 0), image(2, 2_000), ...Array.from({ length: 50 }, (_, i) => rect(i))])
    let pending: (() => void)[] = []
    const files = installBoardFiles({
      api: f.api as never,
      boardId: 'b1',
      meta: { get: async () => null } as never,
      loader: { fetch: () => new Promise(() => {}), setTimer: () => 0, clearTimer: () => {} },
      schedule: (fn) => pending.push(fn),
    })
    const run = () => {
      const p = pending
      pending = []
      for (const fn of p) fn()
    }
    const learn = vi.spyOn(files.resolver, 'learn')
    const retain = vi.spyOn(files.loader, 'retainOnly')
    // both images are known to the loader (the install's own sync), the one in view first
    expect(files.loader.state(ver(1))).toBeDefined()
    expect(files.loader.state(ver(2))).toBeDefined()
    expect(files.resolver.assetOf(ver(2))).toBe(ast(2))
    // a pan: the same array, so nothing is learned again and no key is let go
    f.pan(-1_900)
    run()
    expect(learn).not.toHaveBeenCalled()
    expect(retain).not.toHaveBeenCalled()
    // a new array without image 1 and with image 3: learned, requested, the unused key let go
    f.setElements([image(2, 2_000), image(3, 4_000)])
    run()
    expect(learn).toHaveBeenCalledTimes(1)
    expect(learn.mock.calls[0]?.[0]).toHaveLength(2)
    expect(files.resolver.assetOf(ver(3))).toBe(ast(3))
    expect(files.loader.state(ver(3))).toBeDefined()
    expect(retain).toHaveBeenCalledTimes(1)
    expect([...(retain.mock.calls[0]?.[0] ?? [])].sort()).toEqual([ver(2), ver(3)])
    files.dispose()
  })
})
