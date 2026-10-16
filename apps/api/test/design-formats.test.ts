// Wave R (docs/WAVE-R-CONTRACTS.md §6): the design-file table exists twice, in @draftroom/contracts (the web's file
// card, the api) and in @draftroom/dev-assets (the worker, which does not depend on contracts). They must agree. WS3
// wired classifyUpload and maxUploadBytes in the same change as the worker that previews these files.
import { DESIGN_FORMAT_ROWS, DESIGN_PREVIEW_CODES, DESIGN_PREVIEW_MESSAGES } from '@draftroom/contracts'
import { classifyUpload, DESIGN_FORMATS, LIMITS, maxUploadBytes } from '@draftroom/dev-assets'
import { describe, expect, it } from 'vitest'
import { uploadLimitLabel } from '../src/files/mime.ts'
import { FAILURE_MESSAGES, userFailure } from '../src/worker/protocol.ts'

const MiB = 1024 * 1024

describe('design formats', () => {
  it('contracts and dev-assets list the same rows', () => {
    expect(DESIGN_FORMATS.map((f) => ({ ...f }))).toEqual(
      DESIGN_FORMAT_ROWS.map(({ label: _label, ...row }) => row),
    )
  })

  it('Photoshop, Illustrator and TIFF files are previewed as pages (kind pdf); HEIC stays an attachment', () => {
    expect(classifyUpload('image/vnd.adobe.photoshop', 'art.psd')).toBe('pdf')
    expect(classifyUpload('', 'ART.PSD')).toBe('pdf')
    expect(classifyUpload('application/octet-stream', 'layout.ai')).toBe('pdf')
    expect(classifyUpload('application/illustrator', 'upload')).toBe('pdf')
    expect(classifyUpload('application/postscript', 'logo.ai')).toBe('pdf')
    expect(classifyUpload('image/tiff', 'scan.tif')).toBe('pdf')
    expect(classifyUpload('', 'scan.TIFF')).toBe('pdf')
    expect(classifyUpload('image/heic', 'IMG_0001.HEIC')).toBe('other')
    // application/postscript alone is EPS or PostScript: an attachment, never Illustrator
    expect(classifyUpload('application/postscript', 'logo.eps')).toBe('other')
    expect(classifyUpload('application/postscript', 'upload')).toBe('other')
    // a type or name that says image or PDF first keeps that kind
    expect(classifyUpload('image/png', 'art.psd')).toBe('image')
    expect(classifyUpload('application/pdf', 'art.psd')).toBe('pdf')
  })

  it('each design format has its own upload limit, and the 413 names it', () => {
    expect(maxUploadBytes('pdf', 'image/vnd.adobe.photoshop', 'art.psd')).toBe(200 * MiB)
    expect(maxUploadBytes('pdf', 'image/tiff', 'scan.tif')).toBe(100 * MiB)
    expect(maxUploadBytes('pdf', '', 'layout.ai')).toBe(LIMITS.maxBytes.pdf)
    expect(maxUploadBytes('other', 'image/heic', 'IMG_0001.heic')).toBe(LIMITS.maxBytes.pdf)
    // a PDF named .psd is a PDF (its limit; the worker decides by content anyway)
    expect(maxUploadBytes('pdf', 'application/pdf', 'art.psd')).toBe(LIMITS.maxBytes.pdf)
    expect(maxUploadBytes('pdf', 'application/pdf', 'scan.pdf')).toBe(LIMITS.maxBytes.pdf)
    expect(maxUploadBytes('other', '', 'notes.zip')).toBe(LIMITS.maxBytes.other)
    expect(uploadLimitLabel('pdf', '', 'art.psd')).toBe('PSD files')
    expect(uploadLimitLabel('pdf', 'image/tiff', 'scan.tif')).toBe('TIFF files')
    expect(uploadLimitLabel('other', 'image/heic', 'IMG_0001.heic')).toBe('HEIC files')
    expect(uploadLimitLabel('pdf', 'application/pdf', 'art.psd')).toBeNull()
  })

  it('the worker’s design codes reach users with the contracts’ words, never as INTERNAL', () => {
    expect(Object.values(DESIGN_PREVIEW_CODES).sort()).toEqual(Object.keys(DESIGN_PREVIEW_MESSAGES).sort())
    for (const [code, message] of Object.entries(DESIGN_PREVIEW_MESSAGES)) {
      expect(FAILURE_MESSAGES[code], code).toBe(message)
      expect(userFailure(code)).toEqual({ code, message })
    }
  })
})
