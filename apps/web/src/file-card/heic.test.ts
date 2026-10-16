import { describe, expect, it } from 'vitest'
import {
  convertHeicPhotos,
  HEIC_MAX_PIXELS,
  type HeicDeps,
  heicAsJpeg,
  isHeicFile,
  jpegName,
} from './heic.ts'

const heic = (name = 'IMG_0001.HEIC', type = 'image/heic') => new File([new Uint8Array(64)], name, { type })

/** A browser that decodes HEIC (Safari): a bitmap of `w` x `h`, and a canvas that encodes `out`. */
function safari(w: number, h: number, out: Blob = new Blob([new Uint8Array(32)], { type: 'image/jpeg' })) {
  const calls = { decoded: 0, drawn: 0, closed: 0, encoded: [] as unknown[] }
  const deps: HeicDeps = {
    createImageBitmap: async () => {
      calls.decoded++
      return { width: w, height: h, close: () => calls.closed++ } as unknown as ImageBitmap
    },
    OffscreenCanvas: class {
      getContext() {
        return { drawImage: () => calls.drawn++ }
      }
      async convertToBlob(o: unknown) {
        calls.encoded.push(o)
        return out
      }
    } as unknown as HeicDeps['OffscreenCanvas'],
  }
  return { deps, calls }
}

describe('HEIC photos in the uploader', () => {
  it('Safari: the photo is uploaded as a JPEG named after it', async () => {
    const { deps, calls } = safari(4032, 3024)
    const out = await heicAsJpeg(heic(), deps)
    expect(out.name).toBe('IMG_0001.jpg')
    expect(out.type).toBe('image/jpeg')
    expect(calls).toMatchObject({ decoded: 1, drawn: 1, closed: 1 })
    expect(calls.encoded).toEqual([{ type: 'image/jpeg', quality: 0.9 }])
  })

  it('Chrome, Edge, Firefox: no decoder, so the file is uploaded unchanged (an attachment with the hint)', async () => {
    const file = heic()
    const deps: HeicDeps = {
      createImageBitmap: async () => {
        throw new DOMException('The source image could not be decoded.', 'InvalidStateError')
      },
      OffscreenCanvas: safari(1, 1).deps.OffscreenCanvas,
    }
    expect(await heicAsJpeg(file, deps)).toBe(file)
    expect(await heicAsJpeg(file, {})).toBe(file) // no OffscreenCanvas or createImageBitmap at all
  })

  it('too many pixels, a failed encode or not a JPEG: unchanged', async () => {
    const file = heic()
    const big = safari(10_000, Math.ceil(HEIC_MAX_PIXELS / 10_000) + 1)
    expect(await heicAsJpeg(file, big.deps)).toBe(file)
    expect(big.calls.closed).toBe(1)
    expect(await heicAsJpeg(file, safari(100, 100, new Blob([], { type: 'image/jpeg' })).deps)).toBe(file)
    expect(await heicAsJpeg(file, safari(100, 100, new Blob(['x'], { type: 'image/png' })).deps)).toBe(file)
  })

  it('only HEIC files are touched, in order', async () => {
    const png = new File([new Uint8Array(8)], 'a.png', { type: 'image/png' })
    const { deps, calls } = safari(10, 10)
    const out = await convertHeicPhotos([png, heic('b.heif', '')], deps)
    expect(out[0]).toBe(png)
    expect(out[1]?.name).toBe('b.jpg')
    expect(calls.decoded).toBe(1)
    expect(isHeicFile({ name: 'x.jpg', type: 'image/jpeg' })).toBe(false)
    expect(jpegName('.heic')).toBe('photo.jpg')
  })
})
