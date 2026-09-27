import { PDFDocument } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { createPdfBuilderOffThread } from './pdf-client.ts'

const PNG = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
)

describe('createPdfBuilderOffThread', () => {
  it('falls back to the main thread when there is no Worker (and still builds the PDF)', async () => {
    expect(typeof (globalThis as { Worker?: unknown }).Worker).toBe('undefined')
    const builder = await createPdfBuilderOffThread({ title: 'Deck' })
    expect(builder.offThread).toBe(false)
    await builder.addPage({ title: 'One', widthPx: 800, heightPx: 600, image: { bytes: PNG, type: 'png' } })
    expect(builder.pageCount).toBe(1)
    const doc = await PDFDocument.load(await builder.finish())
    builder.dispose() // after finish: a no-op
    expect(doc.getPageCount()).toBe(1)
    expect(doc.getTitle()).toBe('Deck')
  })
})
