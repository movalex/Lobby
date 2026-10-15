// Wave Q (the integration): the Library tab's import of an `.excalidrawlib`: the normaliser's refusals in words, the
// import posted with the scope and folder chosen, what was created and left out said as counts, an api refusal in the
// library's own words.
import { describe, expect, it } from 'vitest'
import type { NormaliseLibraryResult } from '../../canvas/library/index.ts'
import { LibraryRequestError } from './client.ts'
import { importedText, importLibraryFile, refusalText } from './import.ts'

const W = 'wsp_0123456789abcdefghij'
const file = new File(['{}'], 'kit.excalidrawlib', { type: 'application/json' })

const ok = (skipped = 0): NormaliseLibraryResult =>
  ({
    ok: true,
    input: { scope: 'personal', fileName: 'kit.excalidrawlib', items: [{ name: 'A', elements: [] }] },
    report: { itemsSkipped: skipped },
    warnings: [],
  }) as unknown as NormaliseLibraryResult

describe('importing a library file', () => {
  it('posts what the normaliser made, with the scope and folder chosen, and counts what was created and left out', async () => {
    const seen: unknown[] = []
    const r = await importLibraryFile(
      W,
      file,
      { scope: 'personal', folderId: 'lbf_0123456789abcdefghij' },
      {
        normalise: async (_f, opts) => {
          seen.push(opts)
          return ok(1)
        },
        post: async (wid, input) => {
          seen.push([wid, input.fileName])
          return { created: 3, skipped: 1, warnings: [] }
        },
      },
    )
    expect(seen).toEqual([
      { scope: 'personal', folderId: 'lbf_0123456789abcdefghij' },
      [W, 'kit.excalidrawlib'],
    ])
    expect(r).toEqual({
      ok: true,
      created: 3,
      skipped: 2,
      text: 'Imported 3 items to your library. 2 items could not be used.',
    })
    expect(importedText({ created: 1, skipped: 0, warnings: [] }, 0, 'workspace')).toBe(
      'Imported 1 item to the workspace library.',
    )
  })

  it('says why a file was refused, and posts nothing', async () => {
    for (const code of ['too-large', 'not-a-library', 'empty', 'nothing-usable'] as const) {
      let posted = false
      const r = await importLibraryFile(
        W,
        file,
        { scope: 'personal', folderId: null },
        {
          normalise: async () => ({ ok: false, code }),
          post: async () => {
            posted = true
            return { created: 0, skipped: 0, warnings: [] }
          },
        },
      )
      expect(r).toEqual({ ok: false, text: refusalText(code) })
      expect(posted).toBe(false)
    }
    // a reader that throws is a file that is not a library
    expect(
      await importLibraryFile(
        W,
        file,
        { scope: 'personal', folderId: null },
        {
          normalise: async () => {
            throw new Error('boom')
          },
        },
      ),
    ).toEqual({ ok: false, text: refusalText('not-a-library') })
  })

  it('an api refusal is said in the library’s words', async () => {
    const r = await importLibraryFile(
      W,
      file,
      { scope: 'workspace', folderId: null },
      {
        normalise: async () => ok(),
        post: async () => {
          throw new LibraryRequestError('CREATOR_REQUIRED', 403)
        },
      },
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.text).toMatch(/needs a work address/)
  })
})
