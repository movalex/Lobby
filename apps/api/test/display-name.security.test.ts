// FC-3 (docs/SECURITY-REVIEW-2026-09-27.md, A6): an uploaded file's display name keeps no bidirectional
// controls, which make a name read differently on screen than it is stored (an override in
// "invoice<RLO>fdp.exe" shows the tail reversed, so an .exe reads as a .pdf). The characters are built
// from code points here, never typed into the source.

import { sanitizeDisplayName } from '@draftroom/dev-assets/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createBoard, createTestApi, DEV_STUDIO, ORIGIN, type TestApi } from './helpers.ts'

const ch = (...codes: number[]) => String.fromCodePoint(...codes)
/** U+061C, U+200E/F, U+202A-U+202E, U+2066-U+2069 and the line and paragraph separators U+2028/9. */
const BIDI = [
  0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x2028,
  0x2029,
]

describe('sanitizeDisplayName', () => {
  it('strips every bidi control, wherever it sits in the name', () => {
    for (const cp of BIDI) {
      const c = ch(cp)
      expect(sanitizeDisplayName(`invoice${c}fdp.exe`), cp.toString(16)).toBe('invoicefdp.exe')
      expect(sanitizeDisplayName(`${c}a${c}b${c}.png`), cp.toString(16)).toBe('ab.png')
    }
    expect(sanitizeDisplayName(`report${ch(0x202e)}gnp.exe`)).toBe('reportgnp.exe')
    expect(sanitizeDisplayName(`${ch(0x2066, 0x2067, 0x2068, 0x2069)}x.txt`)).toBe('x.txt')
    // A name that was only controls falls back to "file", like an empty one.
    expect(sanitizeDisplayName(ch(...BIDI))).toBe('file')
  })

  it('keeps what it kept: path parts and C0 controls go, ordinary non-ASCII text stays', () => {
    const backslash = String.fromCharCode(92)
    expect(sanitizeDisplayName(['C:', 'Users', 'me', 'secret', 'deck.pdf'].join(backslash))).toBe('deck.pdf')
    expect(sanitizeDisplayName('../../a\u0000b.png')).toBe('ab.png')
    expect(sanitizeDisplayName('')).toBe('file')
    expect(sanitizeDisplayName('Résumé 2026 – 設計.pdf')).toBe('Résumé 2026 – 設計.pdf')
    // Right-to-left text itself is fine: only the invisible controls that reorder it are removed.
    expect(sanitizeDisplayName('تقرير.pdf')).toBe('تقرير.pdf')
    expect(sanitizeDisplayName(`ok${ch(0x200d)}${ch(0xfe0f)}.png`)).toBe(`ok${ch(0x200d)}${ch(0xfe0f)}.png`)
  })
})

describe('upload', () => {
  let api: TestApi
  beforeEach(async () => {
    api = await createTestApi()
  })
  afterEach(() => api.close())

  it('stores and returns the name without bidi controls', async () => {
    const bob = await api.login('bob')
    const boardId = await createBoard(bob, DEV_STUDIO, 'Files')
    const name = `invoice${ch(0x202e)}fdp.exe`
    const res = await api.app.inject({
      method: 'POST',
      url: `/api/boards/${boardId}/assets`,
      payload: Buffer.alloc(8, 1),
      headers: {
        origin: ORIGIN,
        cookie: bob.cookie,
        'content-type': 'application/octet-stream',
        'x-file-name': encodeURIComponent(name),
      },
    })
    expect(res.statusCode, res.body).toBe(201)
    expect(res.json().name).toBe('invoicefdp.exe')
    const stored = await api.db.query<{ name: string }>('SELECT name FROM asset_versions')
    expect(stored.rows.map((r) => r.name)).toEqual(['invoicefdp.exe'])
  })
})
