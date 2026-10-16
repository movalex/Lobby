// Design files on the upload route (wave R): Photoshop, Illustrator and TIFF uploads are kind 'pdf' (flattened-page
// previews) only while DRAFTROOM_DESIGN_PREVIEWS is on. Off (the default, until the NAS preview worker runs the wave R
// build), they are plain attachments with the attachment limit, exactly as before wave R. The flag itself is read by
// createApiServer (dev-assets setDesignPreviews); these tests drive the route plugin through that switch.
import { type AssetVersionMeta, LIMITS, setDesignPreviews } from '@draftroom/dev-assets'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { parseRaw, rawExchange, startApp, type TestApp, upload, uploadHead } from './helpers.ts'

let t: TestApp
beforeAll(async () => {
  t = await startApp()
})
afterAll(async () => {
  await t.stop()
})
beforeEach(() => {
  t.auth.roles = { 'board-a': 'editor' }
})
afterEach(() => setDesignPreviews(false))

const body = Buffer.from('stand-in design bytes: the api never looks inside, the worker does')
const FILES = [
  ['image/vnd.adobe.photoshop', 'art.psd'],
  ['application/octet-stream', 'scan.TIF'],
  ['image/tiff', 'scan'],
  ['application/illustrator', 'logo.ai'],
] as const

describe('design uploads', () => {
  it('on: PSD, AI and TIFF are kind pdf, queued for the preview worker', async () => {
    setDesignPreviews(true)
    for (const [type, name] of FILES) {
      const res = await upload(t.port, { type, name, body })
      expect(res.status, name).toBe(201)
      expect(res.json<AssetVersionMeta>(), name).toMatchObject({ kind: 'pdf', status: 'queued' })
    }
  })

  it('off: PSD, AI and TIFF are kind other, as before wave R', async () => {
    setDesignPreviews(false)
    for (const [type, name] of FILES) {
      const res = await upload(t.port, { type, name, body })
      expect(res.status, name).toBe(201)
      expect(res.json<AssetVersionMeta>(), name).toMatchObject({ kind: 'other' })
    }
  })

  it('the 413 follows the flag: TIFF files at 100 MB when on, the attachment limit when off', async () => {
    setDesignPreviews(true)
    const on = parseRaw(
      await rawExchange(t.port, (s) =>
        s.write(uploadHead({ type: 'image/tiff', name: 'huge.tif', length: 100 * 1024 * 1024 + 1 })),
      ),
    )
    expect(on.status).toBe(413)
    expect(on.json.error).toEqual({
      code: 'TOO_LARGE',
      message: 'The file is larger than the 100 MB limit for TIFF files.',
    })
    setDesignPreviews(false)
    const off = parseRaw(
      await rawExchange(t.port, (s) =>
        s.write(uploadHead({ type: 'image/tiff', name: 'huge.tif', length: LIMITS.maxBytes.other + 1 })),
      ),
    )
    expect(off.status).toBe(413)
    expect(off.json.error).toEqual({
      code: 'TOO_LARGE',
      message: 'The file is larger than the 250 MB limit for files.',
    })
  })
})
