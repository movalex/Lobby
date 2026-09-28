import { describe, expect, it } from 'vitest'
import { confirmText, formatSize } from './download-originals.ts'

describe('F2-05: downloading several originals', () => {
  it('says how many files and how much before anything downloads', () => {
    expect(confirmText(37, 186 * 1024 * 1024)).toBe(
      '37 original files selected (about 186 MB). They download one after another; your browser may ask once to allow several downloads.',
    )
    expect(confirmText(2, 0)).toMatch(/^2 original files selected\. /)
  })
  it('sizes read as KB or MB', () => {
    expect(formatSize(300)).toBe('1 KB')
    expect(formatSize(2.4 * 1024 * 1024)).toBe('2 MB')
  })
})
