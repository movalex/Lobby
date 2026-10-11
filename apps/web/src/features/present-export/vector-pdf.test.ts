// N6-5: the vector PDF switch and the dialog's notes.
import { afterEach, describe, expect, it } from 'vitest'
import {
  imagePagesSentence,
  PDF_SIZE_WARN_BYTES,
  pdfSizeNote,
  VECTOR_PDF,
  VECTOR_PDF_DEV_PREVIEW_KEY,
  vectorPdfOffered,
} from './vector-pdf.ts'

const store = new Map<string, string>()
const g = globalThis as { localStorage?: Pick<Storage, 'getItem'> }
const had = g.localStorage
afterEach(() => {
  store.clear()
  g.localStorage = had
})

describe('vector PDF', () => {
  it('names exactly the pages that were drawn as images', () => {
    expect(imagePagesSentence([])).toBe('')
    expect(imagePagesSentence([3])).toBe('Page 3 was exported as an image')
    expect(imagePagesSentence([5, 3])).toBe('Pages 3 and 5 were exported as images')
    expect(imagePagesSentence([2, 3, 5, 3])).toBe('Pages 2, 3 and 5 were exported as images')
  })
  it('warns above 50 MB only', () => {
    expect(pdfSizeNote(PDF_SIZE_WARN_BYTES)).toBeNull()
    expect(pdfSizeNote(63 * 1024 * 1024)).toMatch(/^This PDF is 63 MB/)
  })
  it('the switch: off until the font engine lands; the dev preview only behind the local-dev guard', () => {
    expect(VECTOR_PDF).toBe(false)
    g.localStorage = { getItem: (k: string) => store.get(k) ?? null }
    expect(vectorPdfOffered(true)).toBe(false)
    store.set(VECTOR_PDF_DEV_PREVIEW_KEY, '1')
    expect(vectorPdfOffered(true)).toBe(true)
    // a production build (no dev guard) never reads the key
    expect(vectorPdfOffered(false)).toBe(false)
    g.localStorage = {
      getItem: () => {
        throw new Error('blocked')
      },
    }
    expect(vectorPdfOffered(true)).toBe(false)
  })
})
