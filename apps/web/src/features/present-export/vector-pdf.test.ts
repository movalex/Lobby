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
    const today = { pagesKind: 'image', vectorOffered: false, lossless: false } as const
    expect(pdfSizeNote(PDF_SIZE_WARN_BYTES, today)).toBeNull()
    expect(pdfSizeNote(63 * 1024 * 1024, today)).toMatch(/^This PDF is 63 MB/)
  })
  it('the size advice names only options the dialog shows and that make the file smaller', () => {
    const big = 63 * 1024 * 1024
    const head = 'This PDF is 63 MB: too large for most email and chat attachments. For a smaller file, '
    // today's dialog (VECTOR_PDF off): there is no Pages choice to point at
    expect(pdfSizeNote(big, { pagesKind: 'image', vectorOffered: false, lossless: true })).toBe(
      `${head}export fewer frames or turn off Lossless images.`,
    )
    expect(pdfSizeNote(big, { pagesKind: 'image', vectorOffered: false, lossless: false })).toBe(
      `${head}export fewer frames.`,
    )
    // already on Image pages: never told to choose them
    expect(pdfSizeNote(big, { pagesKind: 'image', vectorOffered: true, lossless: true })).toBe(
      `${head}export fewer frames or turn off Lossless images.`,
    )
    expect(pdfSizeNote(big, { pagesKind: 'image', vectorOffered: true, lossless: false })).toBe(
      `${head}export fewer frames.`,
    )
    // on Vector pages: Image pages is a real, visible choice
    expect(pdfSizeNote(big, { pagesKind: 'vector', vectorOffered: true, lossless: true })).toBe(
      `${head}export fewer frames or choose Image pages without lossless images.`,
    )
    expect(pdfSizeNote(big, { pagesKind: 'vector', vectorOffered: true, lossless: false })).toBe(
      `${head}export fewer frames or choose Image pages.`,
    )
    // a vector kind without the offer (cannot happen: the dialog forces 'image') never names a hidden choice
    expect(pdfSizeNote(big, { pagesKind: 'vector', vectorOffered: false, lossless: false })).toBe(
      `${head}export fewer frames.`,
    )
  })
  it('the switch: on since the font engine landed (wave N.1); the dev keys only behind the local-dev guard', () => {
    expect(VECTOR_PDF).toBe(true)
    g.localStorage = { getItem: (k: string) => store.get(k) ?? null }
    expect(vectorPdfOffered(true)).toBe(true)
    expect(vectorPdfOffered(false)).toBe(true)
    store.set(VECTOR_PDF_DEV_PREVIEW_KEY, '1')
    expect(vectorPdfOffered(true)).toBe(true)
    // '0': today's image-pages-only dialog, for the specs that compare with it; dev only
    store.set(VECTOR_PDF_DEV_PREVIEW_KEY, '0')
    expect(vectorPdfOffered(true)).toBe(false)
    // a production build (no dev guard) never reads the key
    expect(vectorPdfOffered(false)).toBe(true)
    store.set(VECTOR_PDF_DEV_PREVIEW_KEY, 'off')
    expect(vectorPdfOffered(true)).toBe(true)
    g.localStorage = {
      getItem: () => {
        throw new Error('blocked')
      },
    }
    expect(vectorPdfOffered(true)).toBe(true)
  })
})
