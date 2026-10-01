import { describe, expect, it } from 'vitest'
import { replacedGeometry, replaceRefusal } from './edit-media.tsx'

const facts = (kind: 'image' | 'pdf' | 'video' | 'other') =>
  ({ assetId: 'a', versionId: 'v', kind, name: 'x', mimeType: 'x', sizeBytes: 1 }) as const
const file = (name: string, type: string, size = 10) => new File([new Uint8Array(size)], name, { type })

describe('W5-13: Replace media', () => {
  it('an image keeps its centre and its longer side, with the new picture’s proportions', () => {
    const g = replacedGeometry(
      { x: 100, y: 100, w: 400, h: 300, cropped: false, kind: 'image' },
      { kind: 'image', size: { w: 1080, h: 1920 } },
    )
    expect(g.crop).toBeNull()
    expect(g.box.h).toBe(400)
    expect(g.box.w).toBeCloseTo(225)
    expect(g.box.x + g.box.w / 2).toBeCloseTo(300)
    expect(g.box.y + g.box.h / 2).toBeCloseTo(250)
  })

  it('a cropped image (a template slot’s photo) keeps its box and is cropped again to it', () => {
    const g = replacedGeometry(
      { x: 0, y: 0, w: 320, h: 180, cropped: true, kind: 'image' },
      { kind: 'image', size: { w: 1000, h: 1000 } },
    )
    expect(g.box).toEqual({ x: 0, y: 0, w: 320, h: 180 })
    // a centre crop of the 512 px thumb to 16:9
    expect(g.crop).toEqual({ x: 0, y: 112, width: 512, height: 288, naturalWidth: 512, naturalHeight: 512 })
  })

  it('a card keeps its box for the same kind, and takes the new kind’s shape at the same width', () => {
    expect(
      replacedGeometry(
        { x: 5, y: 6, w: 260, h: 356, cropped: false, kind: 'pdf' },
        { kind: 'pdf', size: null },
      ).box,
    ).toEqual({ x: 5, y: 6, w: 260, h: 356 })
    const v = replacedGeometry(
      { x: 5, y: 6, w: 260, h: 356, cropped: false, kind: 'pdf' },
      { kind: 'video', size: null },
    )
    expect(v.box.x).toBe(5)
    expect(v.box.w).toBe(260)
    expect(v.box.h).toBeCloseTo((260 * 276) / 360)
  })

  it('images replace images, files replace files; the size limit is checked before any byte is sent', () => {
    expect(replaceRefusal(facts('image'), file('v2.png', 'image/png'))).toBeNull()
    expect(replaceRefusal(facts('image'), file('v2.pdf', 'application/pdf'))).toMatch(/Pick an image/)
    expect(replaceRefusal(facts('pdf'), file('v2.png', 'image/png'))).toMatch(/images replace images/)
    expect(replaceRefusal(facts('pdf'), file('cut.mp4', 'video/mp4'))).toBeNull()
    expect(replaceRefusal(facts('image'), file('huge.png', 'image/png', 30 * 1024 * 1024))).toMatch(
      /larger than/,
    )
  })
})
