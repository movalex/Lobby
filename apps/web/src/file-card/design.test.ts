import { DESIGN_PREVIEW_MESSAGES } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import type { AssetVersionMeta, DerivativeRecord } from '../assets/contract.ts'
import { makeMeta } from '../assets/test-fixtures.ts'
import {
  cardDesignFormat,
  DESIGN_PREVIEW_BADGE,
  designBadgeText,
  designHint,
  FLATTENED_DETAIL,
  isFlattenedPreview,
  isLowResolutionPreview,
} from './design.ts'
import { documentLabel } from './office.ts'

const PSD = 'image/vnd.adobe.photoshop'
const props = (name: string, mimeType = 'application/octet-stream', kind: 'pdf' | 'other' = 'pdf') => ({
  kind,
  name,
  mimeType,
})
const drv = (role: DerivativeRecord['role'], width: number): DerivativeRecord => ({
  id: `drv_${role}${'A'.repeat(16)}`,
  role,
  page: 1,
  width,
  height: Math.round(width / 1.5),
  mimeType: 'image/webp',
  bytes: 100,
  file: `${role}.webp`,
})
const ready = (o: Partial<AssetVersionMeta>) =>
  makeMeta({ kind: 'pdf', status: 'ready', derivatives: [drv('page', 1200), drv('thumb', 512)], ...o })

describe('design files on a card', () => {
  it('a ready PSD, TIFF or AI is a flattened preview with its type, never “editable”', () => {
    const psd = ready({ mimeType: PSD, name: 'poster.psd' })
    expect(isFlattenedPreview(psd, props('poster.psd'))).toBe(true)
    expect(cardDesignFormat(psd, props('poster.psd'))?.kind).toBe('psd')
    expect(designBadgeText(cardDesignFormat(psd, props('poster.psd')) ?? never())).toBe('Flattened preview · PSD')
    expect(documentLabel(psd, props('poster.psd'))).toBe('PSD')
    const tiff = ready({ mimeType: 'image/tiff', name: 'scan.tif' })
    expect(documentLabel(tiff, props('scan.tif'))).toBe('TIFF')
    // an Illustrator file is a PDF underneath: its .ai name says what it is
    const ai = ready({ mimeType: 'application/pdf', name: 'logo.ai' })
    expect(isFlattenedPreview(ai, props('logo.ai'))).toBe(true)
    expect(documentLabel(ai, props('logo.ai'))).toBe('AI')
    for (const text of [DESIGN_PREVIEW_BADGE, FLATTENED_DETAIL]) expect(text).not.toMatch(/editable/i)
  })

  it('a real PDF named .psd is a PDF: the confirmed type wins', () => {
    const m = ready({ mimeType: 'application/pdf', name: 'misnamed.psd' })
    expect(cardDesignFormat(m, props('misnamed.psd'))).toBeNull()
    expect(isFlattenedPreview(m, props('misnamed.psd'))).toBe(false)
    expect(documentLabel(m, props('misnamed.psd'))).toBe('PDF')
    expect(isFlattenedPreview(ready({ name: 'deck.pdf' }), props('deck.pdf'))).toBe(false)
  })

  it('before the worker answers, or after a failure, the upload’s type and name say; no badge yet', () => {
    for (const status of ['queued', 'processing', 'failed'] as const) {
      const m = makeMeta({ kind: 'pdf', status, mimeType: 'application/octet-stream', name: 'art.psd' })
      expect(cardDesignFormat(m, props('art.psd'))?.kind, status).toBe('psd')
      expect(isFlattenedPreview(m, props('art.psd')), status).toBe(false)
    }
    expect(cardDesignFormat(null, props('scan.TIFF'))?.kind).toBe('tiff')
    expect(cardDesignFormat(null, props('upload', PSD))?.kind).toBe('psd')
    // EPS (application/postscript without an .ai name) is not Illustrator
    expect(cardDesignFormat(null, props('logo.eps', 'application/postscript', 'other'))).toBeNull()
  })

  it('a PSD with only its thumbnail says it is a low-resolution preview', () => {
    const m = ready({ mimeType: PSD, name: 'flat.psd', derivatives: [drv('thumb', 160)] })
    expect(isLowResolutionPreview(m, props('flat.psd'))).toBe(true)
    expect(designHint(m, props('flat.psd'))).toBe(DESIGN_PREVIEW_MESSAGES.PSD_THUMBNAIL_ONLY)
    const full = ready({ mimeType: PSD, name: 'full.psd' })
    expect(isLowResolutionPreview(full, props('full.psd'))).toBe(false)
    expect(designHint(full, props('full.psd'))).toBeNull()
  })

  it('HEIC is an attachment with the hint, never a preview', () => {
    const m = makeMeta({ kind: 'other', status: 'ready', mimeType: 'image/heic', name: 'IMG_0001.HEIC' })
    const p = props('IMG_0001.HEIC', 'image/heic', 'other')
    expect(cardDesignFormat(m, p)?.kind).toBe('heic')
    expect(isFlattenedPreview(m, p)).toBe(false)
    expect(designHint(m, p)).toBe(DESIGN_PREVIEW_MESSAGES.HEIC_NO_PREVIEW)
    expect(designHint(null, p)).toBe(DESIGN_PREVIEW_MESSAGES.HEIC_NO_PREVIEW)
  })
})

function never(): never {
  throw new Error('no design format')
}
