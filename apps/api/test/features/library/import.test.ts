// Wave Q (WS2): importing a normalised `.excalidrawlib` (docs/WAVE-Q-CONTRACTS.md §6). Every item is checked as a
// save; bad, oversized and file-showing items are skipped and counted (never echoed); the licence note, the file name
// and the author are each item's source; the library's limit; who may import where; the rate limit; the audit row.

import {
  ImportLibraryResponse,
  LIBRARY_DEFAULT_LICENCE,
  LIBRARY_LIMITS,
  LIBRARY_RATE_LIMITS,
  LibraryItem,
} from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  answer,
  count,
  fillItems,
  image,
  itemUrl,
  LIB,
  type LibWorld,
  libraryWorld,
  rect,
  uploadTo,
} from './support.ts'

let w: LibWorld
beforeEach(async () => {
  w = await libraryWorld()
})
afterEach(() => w.api.close())

const body = (over: Record<string, unknown> = {}) => ({
  scope: 'workspace',
  fileName: 'flowchart-kit.excalidrawlib',
  items: [
    { name: 'Decision', elements: [rect('a'), rect('b', 0, 100)] },
    { name: 'Start', elements: [rect('c')] },
  ],
  ...over,
})
const imported = async (c: LibWorld['carol'], b: object) => {
  const res = await c.req('POST', `${LIB}/import`, b)
  expect(res.statusCode, res.body).toBe(200)
  return ImportLibraryResponse.parse(res.json())
}
const items = async () =>
  (
    await w.api.db.query<{ id: string; name: string; source: unknown; owner_id: string | null }>(
      'SELECT id, name, source, owner_id FROM library_items ORDER BY name',
    )
  ).rows

describe('importing a library', () => {
  it('creates an item per valid entry, with the licence note, file name and author as its source', async () => {
    const r = await imported(w.carol, body({ author: 'Jane' }))
    expect(r).toEqual({ created: 2, skipped: 0, warnings: [] })
    const rows = await items()
    expect(rows.map((r) => r.name)).toEqual(['Decision', 'Start'])
    for (const r of rows)
      expect(r.source).toEqual({
        kind: 'excalidrawlib',
        fileName: 'flowchart-kit.excalidrawlib',
        licence: LIBRARY_DEFAULT_LICENCE,
        author: 'Jane',
      })
    const d = LibraryItem.parse((await w.pat.req('GET', itemUrl(rows[0]?.id ?? ''))).json())
    expect(d).toMatchObject({
      sourceKind: 'excalidrawlib',
      elementCount: 2,
      createdBy: { id: w.carol.userId },
    })
    const audit = await w.api.db.query<{ detail: unknown; target: string }>(
      "SELECT detail, target FROM audit_events WHERE action = 'library.import'",
    )
    const detail = { scope: 'workspace', created: 2, skipped: 0 }
    expect(audit.rows).toEqual([{ target: 'workspace', detail }])
  })

  it('skips and counts what it cannot keep: invalid, too large, showing files; nothing is echoed', async () => {
    const v = await uploadTo(w, w.carol, w.source)
    const link = `https://example.com/${'a'.repeat(1000)}`
    const r = await imported(
      w.carol,
      body({
        licence: 'MIT',
        items: [
          { name: 'Fine', elements: [rect('a')] },
          { name: 'Evil <script>', elements: [rect('e', 0, 0, { type: 'iframe' })] },
          { name: 'Huge', elements: Array.from({ length: 250 }, (_, i) => rect(`h${i}`, i, 0, { link })) },
          { name: 'Picture', elements: [image('p', v)] },
        ],
      }),
    )
    expect(r).toEqual({
      created: 1,
      skipped: 3,
      warnings: [
        '1 item was not valid and left out.',
        '1 item was too large and left out.',
        '1 item shows files, which an imported library cannot carry: left out.',
      ],
    })
    expect(JSON.stringify(r)).not.toMatch(/Evil|script|Huge|Picture/)
    const kept = (await items()).map((i) => [i.name, (i.source as { licence: string }).licence])
    expect(kept).toEqual([['Fine', 'MIT']])
    expect(await count(w.api, 'library_item_files')).toBe(0)
  })

  it('refuses an item whose colours hold a url() (review fix): skipped as not valid, nothing stored of it', async () => {
    const r = await imported(
      w.carol,
      body({
        items: [
          { name: 'Fine', elements: [rect('a')] },
          {
            name: 'Beacon',
            elements: [rect('b', 0, 0, { backgroundColor: 'url(https://evil.example/x#p)' })],
          },
        ],
      }),
    )
    expect(r).toEqual({ created: 1, skipped: 1, warnings: ['1 item was not valid and left out.'] })
    expect((await items()).map((i) => i.name)).toEqual(['Fine'])
    const stored = await w.api.db.one<{ n: number }>(
      "SELECT count(*)::int AS n FROM library_items WHERE elements::text ILIKE '%url(%'",
    )
    expect(stored.n).toBe(0)
  })

  it('who: a creator into the workspace library, anyone into their own; the outsider 403 CREATOR_REQUIRED', async () => {
    expect(answer(await w.pat.req('POST', `${LIB}/import`, body()))).toBe('403 CREATOR_REQUIRED')
    await imported(w.pat, body({ scope: 'personal' }))
    expect((await items()).every((i) => i.owner_id === w.pat.userId)).toBe(true)
    // a folder of that scope only
    const noFolder = body({ folderId: 'lbf_nothing00000000000' })
    expect(answer(await w.carol.req('POST', `${LIB}/import`, noFolder))).toBe('400 BAD_REQUEST')
  })

  it('the library limit: fills what fits and counts the rest; full already: 409 LIBRARY_FULL', async () => {
    await fillItems(w.api, LIBRARY_LIMITS.personalItems - 1, { ownerId: w.dave.userId, by: w.dave.userId })
    expect(await imported(w.dave, body({ scope: 'personal' }))).toEqual({
      created: 1,
      skipped: 1,
      warnings: ['1 item was left out: the library is full.'],
    })
    const again = await w.dave.req('POST', `${LIB}/import`, body({ scope: 'personal' }))
    expect(answer(again)).toBe('409 LIBRARY_FULL')
  })

  it('caps the body (5 MB) and the items (500); 5 imports a minute per person', async () => {
    const tooMany = Array.from({ length: LIBRARY_LIMITS.importItems + 1 }, (_, i) => ({
      name: `I${i}`,
      elements: [rect('a')],
    }))
    expect((await w.carol.req('POST', `${LIB}/import`, body({ items: tooMany }))).statusCode).toBe(400)
    const pad = 'x'.repeat(LIBRARY_LIMITS.importBytes)
    expect((await w.carol.req('POST', `${LIB}/import`, body({ fileName: pad }))).statusCode).toBe(413)
    // the first counted (the 413 never reached the route); four more, then the sixth is refused
    for (let i = 0; i < LIBRARY_RATE_LIMITS.import.max - 1; i++) await imported(w.carol, body())
    expect(answer(await w.carol.req('POST', `${LIB}/import`, body()))).toBe('429 RATE_LIMITED')
  })
})
