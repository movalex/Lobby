import { describe, expect, it } from 'vitest'
import type { CanvasElement, LobbyCanvas } from '../../canvas/api/index.ts'
import { emptySlotsAt, factsFromMeta, layoutFiles, partitionUploads, sceneOf } from './insert.ts'

const file = (name: string, type: string, size = 10) =>
  ({ name, type, size, lastModified: 0, slice: () => new Blob() }) as unknown as File

describe('partitionUploads', () => {
  it('images, cards and files over their limit (named)', () => {
    const big = file('dunes.jpg', 'image/jpeg', 31 * 1024 * 1024)
    const p = partitionUploads([
      file('a.png', 'image/png'),
      file('b.pdf', 'application/pdf'),
      file('c.mp4', 'video/mp4'),
      file('d.svg', 'image/svg+xml'),
      big,
    ])
    expect(p.images.map((f) => f.name)).toEqual(['a.png'])
    expect(p.cards.map((c) => [c.file.name, c.kind])).toEqual([
      ['b.pdf', 'pdf'],
      ['c.mp4', 'video'],
      ['d.svg', 'other'],
    ])
    expect(p.rejected.map((r) => `${r.file.name} ${r.reason}.`)).toEqual([
      'dunes.jpg is larger than 25 MB, the limit for images.',
    ])
  })

  it('facts from the upload answer', () => {
    expect(
      factsFromMeta({
        assetId: 'ast_A',
        versionId: 'ver_B',
        kind: 'pdf',
        name: 'x.pdf',
        mimeType: '',
        declaredMimeType: 'application/pdf',
        sizeBytes: 12.4,
      } as never),
    ).toEqual({
      assetId: 'ast_A',
      versionId: 'ver_B',
      kind: 'pdf',
      name: 'x.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 12,
    })
  })
})

type Box = { x: number; y: number; width: number; height: number }

/** A LobbyCanvas with just the reads the layout uses. */
function fakeCanvas(
  els: (Partial<CanvasElement> & Box & { id: string; type: string })[],
  locked: string[] = [],
) {
  const items = els.map((e) => ({
    frameId: null,
    angle: 0,
    groupIds: [],
    ...e,
  })) as unknown as CanvasElement[]
  return {
    items: () => items,
    get: (id: string) => items.find((e) => e.id === id),
    bounds: (id: string) => {
      const e = items.find((x) => x.id === id)
      return e ? { x: e.x, y: e.y, width: e.width, height: e.height } : null
    },
    isHidden: () => false,
    isLocked: (id: string) => locked.includes(id),
    viewport: { get: () => ({ x: 0, y: 0, width: 2000, height: 1200, zoom: 1 }) },
  } as unknown as LobbyCanvas
}

const slot = (id: string, x: number, y: number, frameId = 'F') => ({
  id,
  type: 'rectangle',
  x,
  y,
  width: 320,
  height: 180,
  frameId,
  locked: true,
  customData: { lobby: { slot: 'image' } },
})

describe('where a drop lands', () => {
  it('images alone: a grid of equal cells centred on the drop point, clear of content', () => {
    const canvas = fakeCanvas([{ id: 'n1', type: 'rectangle', x: -50, y: -50, width: 100, height: 100 }])
    const plan = layoutFiles(
      canvas,
      [
        { w: 1600, h: 1067 },
        { w: 1080, h: 1350 },
        { w: 1200, h: 1200 },
        { w: 800, h: 600 },
      ],
      [],
      { x: 0, y: 0 },
      true,
    )
    expect(plan.images).toHaveLength(4)
    const longest = plan.images.map((i) => Math.max(i.rect.w, i.rect.h))
    for (const l of longest) expect(l).toBeCloseTo(longest[0] ?? 0, 5)
    for (const i of plan.images) {
      expect(i.frameId).toBeNull()
      const over = i.rect.x < 50 && i.rect.x + i.rect.w > -50 && i.rect.y < 50 && i.rect.y + i.rect.h > -50
      expect(over).toBe(false)
    }
  })

  it('a drop on a frame with empty slots fills them from the slot under the pointer; the rest go under the frame', () => {
    const canvas = fakeCanvas([
      { id: 'F', type: 'frame', x: 0, y: 0, width: 1000, height: 400 },
      slot('s1', 20, 20),
      slot('s2', 360, 20),
      { id: 'photo', type: 'image', x: 360, y: 20, width: 320, height: 180, frameId: 'F' },
      slot('s3', 700, 20),
    ])
    const scene = sceneOf(canvas)
    // s2 is taken by the photo: s3 first (under the pointer), then s1
    expect(emptySlotsAt(canvas, scene, { x: 800, y: 100 }, new Set()).map((s) => s.id)).toEqual(['s3', 's1'])
    const plan = layoutFiles(
      canvas,
      [
        { w: 1080, h: 1920 }, // portrait into a landscape slot: centre-cropped
        { w: 1920, h: 1080 },
        { w: 1000, h: 1000 },
      ],
      [],
      { x: 800, y: 100 },
      true,
    )
    const [a, b, c] = plan.images
    expect(a?.slot?.id).toBe('s3')
    expect(a?.rect).toEqual({ x: 700, y: 20, w: 320, h: 180 })
    expect(a?.frameId).toBe('F')
    expect(a?.crop).toMatchObject({ naturalWidth: 288, naturalHeight: 512, width: 288 })
    expect(b?.slot?.id).toBe('s1')
    expect(c?.slot).toBeNull()
    expect(c?.rect.y).toBeGreaterThanOrEqual(400) // under the frame
  })

  it('a locked frame takes nothing; "Insert file" (not aimed) never fills a slot', () => {
    const els = [{ id: 'F', type: 'frame', x: 0, y: 0, width: 1000, height: 400 }, slot('s1', 20, 20)]
    const scene = (c: LobbyCanvas) => sceneOf(c)
    const lockedCanvas = fakeCanvas(els, ['F'])
    expect(emptySlotsAt(lockedCanvas, scene(lockedCanvas), { x: 100, y: 100 }, new Set())).toEqual([])
    const plan = layoutFiles(fakeCanvas(els), [{ w: 1000, h: 1000 }], [], { x: 100, y: 100 }, false)
    expect(plan.images[0]?.slot).toBeNull()
  })

  it('images and cards of one drop share one grid (F12); cards alone keep their size', () => {
    const canvas = fakeCanvas([])
    const mixed = layoutFiles(
      canvas,
      [{ w: 1000, h: 800 }],
      [{ file: file('a.pdf', 'application/pdf'), kind: 'pdf' }],
      { x: 0, y: 0 },
      false,
    )
    expect(mixed.cards[0]?.rect.w).toBeLessThanOrEqual(Math.max(mixed.images[0]?.rect.w ?? 0, 400) + 1)
    const cardsOnly = layoutFiles(
      canvas,
      [],
      [{ file: file('a.zip', 'application/zip'), kind: 'other' }],
      { x: 0, y: 0 },
      false,
    )
    expect(cardsOnly.cards[0]?.rect).toMatchObject({ w: 300, h: 92 })
  })
})
