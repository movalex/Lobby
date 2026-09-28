import { describe, expect, it } from 'vitest'
import type { AssetVersionMeta } from '../assets/contract.ts'
import { makeMeta } from '../assets/test-fixtures.ts'
import { cardOfficeFormat, documentLabel, isConvertedPreview } from './office.ts'
import { pageAssetName } from './pdf-pages.ts'

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
const props = (name: string, mimeType = 'application/octet-stream', kind: 'pdf' | 'other' = 'pdf') => ({
  kind,
  name,
  mimeType,
})
const meta = (o: Partial<AssetVersionMeta>) => makeMeta({ kind: 'pdf', ...o })

describe('Office documents on a card', () => {
  it('a ready document confirmed as Office says so, and its pages are a converted preview', () => {
    const m = meta({ status: 'ready', mimeType: DOCX, name: 'Q3 plan.docx' })
    expect(isConvertedPreview(m)).toBe(true)
    expect(documentLabel(m, props('Q3 plan.docx'))).toBe('Word document')
    expect(documentLabel(meta({ status: 'ready', mimeType: PPTX }), props('deck.pptx'))).toBe(
      'PowerPoint presentation',
    )
  })

  it('a real PDF is a PDF, even when named .docx: the confirmed type wins, and there is no conversion note', () => {
    const m = meta({ status: 'ready', mimeType: 'application/pdf', name: 'misnamed.docx' })
    expect(isConvertedPreview(m)).toBe(false)
    expect(documentLabel(m, props('misnamed.docx'))).toBe('PDF')
  })

  it('before the worker confirms it, or after a failure, the upload’s name or type says what it is', () => {
    for (const status of ['queued', 'processing', 'failed'] as const) {
      const m = meta({ status, mimeType: 'application/octet-stream', name: 'budget.xlsx' })
      expect(isConvertedPreview(m), status).toBe(false)
      expect(documentLabel(m, props('budget.xlsx')), status).toBe('Excel spreadsheet')
    }
    expect(cardOfficeFormat(null, props('notes.odt'))?.ext).toBe('odt')
    expect(cardOfficeFormat(null, props('upload', DOCX))?.ext).toBe('docx')
    expect(documentLabel(null, props('scan.pdf', 'application/pdf'))).toBe('PDF')
    // Declared a PDF: a PDF until the worker says otherwise, whatever the name.
    expect(documentLabel(null, props('scan.docx', 'application/pdf'))).toBe('PDF')
  })

  it('attachments are never Office previews (a .docm stays a file)', () => {
    expect(cardOfficeFormat(null, props('macro.docm', 'application/octet-stream', 'other'))).toBeNull()
    expect(
      cardOfficeFormat(makeMeta({ kind: 'other', status: 'ready', mimeType: DOCX }), props('x.docx')),
    ).toBeNull()
  })

  it('pages placed on the board are named after the document without its extension', () => {
    expect(pageAssetName('Q3 plan.docx', 2, 'image/webp')).toBe('Q3 plan — page 2.webp')
    expect(pageAssetName('Board offsite.ODP', 1, 'image/webp')).toBe('Board offsite — page 1.webp')
    expect(pageAssetName('scan.pdf', 3, 'image/png')).toBe('scan — page 3.png')
  })
})
