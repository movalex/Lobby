// Wave W (WS3, docs/WAVE-W-CONTRACTS.md §5): file hits in the palette's "In this workspace" and the dashboard's
// "Inside boards": where a hit is ("Page 3 · Brief.pdf · Board"), and where it opens (`?file=<ver>&page=<n>`). The
// hits of the board already open stay when they are inside a file ("On this board" searches the canvas only).

import type { SearchBoardGroup, SearchHit, SearchResponse } from '@draftroom/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import type { ApiClient } from '../../api/client.ts'
import {
  fileHitHref,
  fileHitLabel,
  fileOfHit,
  hitHref,
  searchApi,
  withoutFileHits,
} from '../../dashboard/search/content-search.ts'
import { fileHitToOpen, readFileHit } from '../../file-card/ported/open-file-hit.ts'
import { setFormatsOffer } from '../formats/flags.ts'
import { workspaceEntries } from './workspace-search.ts'

const VER = 'ver_0123456789abcdefghij'

const fileHit = (page: number, name = 'Brief.pdf', versionId = VER): SearchHit => ({
  kind: 'file',
  objectId: `file:${versionId}.p${page}`,
  pageId: null,
  cutStart: false,
  cutEnd: true,
  snippet: [
    { text: 'The ', hit: false },
    { text: 'pricing', hit: true },
    { text: ' is final', hit: false },
  ],
  file: { versionId, page, name },
})

const noteHit = (id: string): SearchHit => ({
  kind: 'note',
  objectId: `shape:${id}`,
  pageId: 'page:page',
  cutStart: false,
  cutEnd: false,
  snippet: [{ text: 'a note', hit: false }],
})

const group = (id: string, title: string, hits: SearchHit[]): SearchBoardGroup => ({
  board: { id, title, projectId: null, status: 'active' },
  hits,
  more: 0,
  truncated: false,
})

describe('file hits', () => {
  it('open the file at its page; the address round-trips through the board side', () => {
    expect(fileHitHref('b-board1', VER, 3)).toBe(`/b/b-board1?file=${VER}&page=3`)
    expect(hitHref('b-board1', fileHit(3))).toBe(`/b/b-board1?file=${VER}&page=3`)
    expect(readFileHit(`http://x${fileHitHref('b-board1', VER, 3)}`)).toEqual({ versionId: VER, page: 3 })
  })

  it('trust only a file field that agrees with the object id (else the board opens)', () => {
    expect(fileOfHit(fileHit(2))).toEqual({ versionId: VER, page: 2, name: 'Brief.pdf' })
    const other = { ...fileHit(2), file: { versionId: VER, page: 5, name: 'x' } }
    expect(fileOfHit(other)).toBeNull()
    expect(hitHref('b-board1', other)).toBe('/b/b-board1')
    // an older api: kind file, no file field (a file card's name): the board opens as before
    expect(hitHref('b-board1', { kind: 'file', objectId: 'shape:card1' })).toBe('/b/b-board1?el=card1')
  })

  it('say where they are, the name as text', () => {
    expect(fileHitLabel({ page: 3, name: 'Brief.pdf' })).toBe('Page 3 · Brief.pdf')
    expect(fileHitLabel({ page: 1, name: '  ' })).toBe('Page 1 · File')
    expect(fileHitLabel({ page: 1, name: 'a\n<b>' })).toBe('Page 1 · a <b>')
  })

  it('in the palette: "Page 3 · Brief.pdf · Board", this board kept for files only', () => {
    const opened: string[] = []
    const list = workspaceEntries(
      [
        group('brd-here', 'Here', [noteHit('a1'), fileHit(4, 'Here.pdf')]),
        group('brd-there', 'There', [fileHit(3)]),
      ],
      'brd-here',
      (href) => opened.push(href),
    )
    expect(list.map((e) => e.detail)).toEqual(['Page 4 · Here.pdf · Here', 'Page 3 · Brief.pdf · There'])
    expect(list[1]?.label).toBe('The pricing is final…')
    list[0]?.run()
    list[1]?.run()
    expect(opened).toEqual([`/b/brd-here?file=${VER}&page=4`, `/b/brd-there?file=${VER}&page=3`])
  })
})

describe('the fileSearch switch', () => {
  afterEach(() => setFormatsOffer(null))

  const answer = (): SearchResponse => ({
    terms: ['pricing'],
    groups: [
      group('brd-mixed', 'Mixed', [noteHit('a1'), fileHit(4, 'Here.pdf')]),
      group('brd-files', 'Files', [fileHit(3)]),
    ],
    totalBoards: 2,
    totalHits: 3,
    capped: false,
    pendingBoards: 0,
  })
  const fakeApi = (r: SearchResponse) => ({ request: async () => r }) as unknown as ApiClient

  it('on (the web switch and the api offer): hits inside files are shown and open the file', async () => {
    setFormatsOffer({ fileSearch: true })
    const r = await searchApi(fakeApi(answer())).search(
      'wsp_1',
      { status: 'active', projectId: null },
      'pricing',
    )
    expect(r.groups.flatMap((g) => g.hits.map((h) => h.objectId))).toEqual([
      'shape:a1',
      `file:${VER}.p4`,
      `file:${VER}.p3`,
    ])
    expect(fileHitToOpen(`http://x/b/brd-files?file=${VER}&page=3`)).toEqual({ versionId: VER, page: 3 })
  })

  it('off (no api offer, or the web switch off): no hit inside a file in search or the palette, and no opener', async () => {
    for (const webSwitchOff of [false, true]) {
      // the api not offering it; or the api offering it and the web switch off
      setFormatsOffer({ fileSearch: webSwitchOff })
      const searcher = webSwitchOff ? searchApi(fakeApi(answer()), () => false) : searchApi(fakeApi(answer()))
      const r = await searcher.search('wsp_1', { status: 'active', projectId: null }, 'pricing')
      expect(r.groups.map((g) => g.board.id)).toEqual(['brd-mixed'])
      expect(r.groups[0]?.hits.map((h) => h.objectId)).toEqual(['shape:a1'])
      expect(r).toMatchObject({ totalBoards: 1, totalHits: 1 })
      expect(workspaceEntries(r.groups, null).map((e) => e.detail)).toEqual(['Note · Mixed'])
    }
    setFormatsOffer({ fileSearch: false })
    expect(fileHitToOpen(`http://x/b/brd-files?file=${VER}&page=3`)).toBeNull()
    expect(fileHitToOpen(`http://x/b/brd-files?file=${VER}&page=3`, false)).toBeNull()
    expect(fileHitToOpen(`http://x/b/brd-files?file=${VER}&page=3`, true)).toEqual({
      versionId: VER,
      page: 3,
    })
  })

  it('an answer with no file hits is passed on as it came', () => {
    const r = { ...answer(), groups: [group('brd-a', 'A', [noteHit('a1')])] }
    expect(withoutFileHits(r)).toBe(r)
  })
})

describe('readFileHit', () => {
  it('reads a version and a page; a bad page is page 1; anything else is no link', () => {
    expect(readFileHit(`/b/x?file=${VER}`)).toEqual({ versionId: VER, page: 1 })
    expect(readFileHit(`/b/x?file=${VER}&page=0`)).toEqual({ versionId: VER, page: 1 })
    expect(readFileHit(`/b/x?file=${VER}&page=12345`)).toEqual({ versionId: VER, page: 1 })
    expect(readFileHit(`/b/x?file=${VER}&page=2abc`)).toEqual({ versionId: VER, page: 1 })
    expect(readFileHit('/b/x?file=ast_0123456789abcdefghij&page=2')).toBeNull()
    expect(readFileHit('/b/x?file=javascript:alert(1)')).toBeNull()
    expect(readFileHit('/b/x?el=a1')).toBeNull()
  })
})
