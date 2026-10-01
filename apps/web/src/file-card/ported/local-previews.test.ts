import { describe, expect, it } from 'vitest'
import {
  createLocalPreviews,
  PREVIEW_GRACE_MS,
  PREVIEW_MAX_ENTRIES,
  PREVIEW_MAX_PIXELS,
} from './local-previews.ts'

function kit() {
  let t = 1_000
  let n = 0
  const revoked: string[] = []
  const p = createLocalPreviews({
    createObjectURL: () => `blob:local/${++n}`,
    revokeObjectURL: (u) => void revoked.push(u),
    now: () => t,
  })
  return {
    p,
    revoked,
    tick: (ms: number) => {
      t += ms
    },
  }
}
const png = (name = 'a.png') => new File([new Uint8Array(8)], name, { type: 'image/png' })

describe('W5-56: the uploading tab’s local previews (never stored)', () => {
  it('only raster images the browser shows, never a decompression bomb or an SVG', () => {
    const { p } = kit()
    expect(p.make(png(), { w: 1920, h: 1080 })).toMatch(/^blob:/)
    expect(p.make(png(), { w: 12_000, h: 12_000 })).toBeNull()
    expect(PREVIEW_MAX_PIXELS).toBeLessThan(12_000 * 12_000)
    expect(p.make(new File(['<svg/>'], 'v.svg', { type: 'image/svg+xml' }), { w: 10, h: 10 })).toBeNull()
    expect(p.make(png(), null)).toBeNull()
  })

  it('a kept preview lives while its version is needed, then goes after the grace period', () => {
    const { p, revoked, tick } = kit()
    const url = p.make(png(), { w: 100, h: 100 }) as string
    p.keep('ver_A', url)
    p.drop(url) // the upload flow's clean-up: kept URLs are not revoked
    expect(revoked).toEqual([])
    expect(p.urlOf('ver_A')).toBe(url)
    p.sweep(new Set(['ver_A']))
    tick(PREVIEW_GRACE_MS * 3)
    p.sweep(new Set(['ver_A']))
    expect(p.urlOf('ver_A')).toBe(url)
    // the loader has the derivative: nothing needs it any more
    tick(PREVIEW_GRACE_MS - 1)
    p.sweep(new Set())
    expect(p.urlOf('ver_A')).toBe(url)
    tick(PREVIEW_GRACE_MS + 1)
    p.sweep(new Set())
    expect(p.urlOf('ver_A')).toBeNull()
    expect(revoked).toEqual([url])
  })

  it('a failed upload’s preview is revoked at once; ghosts come and go by key', () => {
    const { p, revoked } = kit()
    const url = p.make(png(), { w: 100, h: 100 }) as string
    p.addGhosts([{ key: '1:0', url, name: 'a.png', rect: { x: 0, y: 0, w: 10, h: 10 } }])
    expect(p.ghosts.get()).toHaveLength(1)
    p.removeGhosts(['1:0'])
    expect(p.ghosts.get()).toEqual([])
    p.drop(url)
    expect(revoked).toEqual([url])
  })

  it('is bounded, and disposing revokes everything', () => {
    const { p, revoked } = kit()
    for (let i = 0; i < PREVIEW_MAX_ENTRIES + 3; i++) {
      p.keep(`ver_${i}`, p.make(png(), { w: 10, h: 10 }) as string)
    }
    expect(revoked).toHaveLength(3)
    expect(p.urlOf('ver_0')).toBeNull()
    const loose = p.make(png(), { w: 10, h: 10 }) as string
    p.dispose()
    expect(revoked).toHaveLength(PREVIEW_MAX_ENTRIES + 4)
    expect(revoked).toContain(loose)
  })
})
