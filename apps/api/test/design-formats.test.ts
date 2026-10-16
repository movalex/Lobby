// Wave R (the foundation; docs/WAVE-R-CONTRACTS.md §6): the design-file table exists twice, in @draftroom/contracts
// (the web's file card, the api) and in @draftroom/dev-assets (the worker, which does not depend on contracts). They
// must agree; and until WS3 wires it, no upload is classified differently.
import { DESIGN_FORMAT_ROWS } from '@draftroom/contracts'
import { classifyUpload, DESIGN_FORMATS, maxUploadBytes } from '@draftroom/dev-assets'
import { describe, expect, it } from 'vitest'

describe('design formats', () => {
  it('contracts and dev-assets list the same rows', () => {
    expect(DESIGN_FORMATS.map((f) => ({ ...f }))).toEqual(
      DESIGN_FORMAT_ROWS.map(({ label: _label, ...row }) => row),
    )
  })

  it('the foundation changes no classification yet (WS3 does, with the worker)', () => {
    expect(classifyUpload('image/vnd.adobe.photoshop', 'art.psd')).toBe('other')
    expect(classifyUpload('image/tiff', 'scan.tif')).toBe('other')
    expect(classifyUpload('image/heic', 'IMG_0001.HEIC')).toBe('other')
    expect(maxUploadBytes('other', 'image/vnd.adobe.photoshop', 'art.psd')).toBe(250 * 1024 * 1024)
  })
})
