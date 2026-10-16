// Wave T (WS3): the animatic's picture window: never more than WINDOW pictures held (a 200-panel storyboard played
// through end to end), the nearest panels ahead drawn first, pictures that leave the window closed, a changed panel
// drawn again, nothing started while the player says a swap is near.
import { describe, expect, it } from 'vitest'
import { type Picture, PictureWindow, WINDOW, windowOrder } from './pictures.ts'

class FakePicture implements Picture {
  static open = 0
  readonly width = 160
  readonly height = 90
  closed = false
  constructor(readonly index: number) {
    FakePicture.open++
  }
  close() {
    if (!this.closed) FakePicture.open--
    this.closed = true
  }
}

const settle = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}

describe('windowOrder', () => {
  it('the playhead, then ahead, then one behind; a short tail leaves room behind', () => {
    expect(windowOrder(0, 20)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(windowOrder(5, 20)).toEqual([5, 6, 7, 8, 9, 10, 11, 4])
    expect(windowOrder(18, 20)).toEqual([18, 19, 17, 16, 15, 14, 13, 12])
    expect(windowOrder(2, 3)).toEqual([2, 1, 0])
    expect(windowOrder(0, 0)).toEqual([])
  })
})

describe('PictureWindow', () => {
  it('holds at most WINDOW pictures through a 200-panel storyboard, closing what it drops', async () => {
    FakePicture.open = 0
    const rendered: number[] = []
    const win = new PictureWindow<FakePicture>(
      async (i) => {
        rendered.push(i)
        return new FakePicture(i)
      },
      () => {},
    )
    win.setJobs(Array.from({ length: 200 }, (_, i) => ({ key: `p${i}`, sig: 'a' })))
    await settle()
    expect(rendered.slice(0, WINDOW)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    let most = 0
    for (let i = 0; i < 200; i++) {
      win.moveTo(i)
      await settle()
      most = Math.max(most, win.held(), FakePicture.open)
      expect(win.get(i)?.index, `panel ${i}`).toBe(i)
    }
    expect(most).toBeLessThanOrEqual(WINDOW)
    win.dispose()
    expect(FakePicture.open).toBe(0)
  })

  it('a panel whose picture changed (its signature) is drawn again; a panel with none is ready empty', async () => {
    FakePicture.open = 0
    const rendered: number[] = []
    const ready: number[] = []
    const win = new PictureWindow<FakePicture>(
      async (i) => {
        rendered.push(i)
        return i === 1 ? null : new FakePicture(i)
      },
      (i) => ready.push(i),
    )
    win.setJobs([
      { key: 'a', sig: '1' },
      { key: 'b', sig: '1' },
    ])
    await settle()
    expect(win.ready(1)).toBe(true)
    expect(win.get(1)).toBeNull()
    const first = win.get(0)
    win.setJobs([
      { key: 'a', sig: '2' },
      { key: 'b', sig: '1' },
    ])
    await settle()
    expect(first?.closed).toBe(true)
    expect(win.get(0)).not.toBe(first)
    expect(rendered).toEqual([0, 1, 0])
    expect(win.windowReady(0)).toBe(true)
    win.dispose()
  })

  it('starts nothing while the player says no (a swap is near), and goes on when kicked', async () => {
    let allowed = false
    const rendered: number[] = []
    const win = new PictureWindow<FakePicture>(
      async (i) => {
        rendered.push(i)
        return new FakePicture(i)
      },
      () => {},
      { canStart: () => allowed },
    )
    win.setJobs([{ key: 'a', sig: '' }])
    await settle()
    expect(rendered).toEqual([])
    allowed = true
    win.kick()
    await settle()
    expect(rendered).toEqual([0])
    win.dispose()
  })

  it('a rendering that fails leaves the panel ready without a picture', async () => {
    const win = new PictureWindow<FakePicture>(
      async () => {
        throw new Error('export failed')
      },
      () => {},
    )
    win.setJobs([{ key: 'a', sig: '' }])
    await settle()
    expect(win.ready(0)).toBe(true)
    expect(win.get(0)).toBeNull()
  })
})
