// Wave W (WS3, docs/WAVE-W-CONTRACTS.md §5, §8.2): search inside files, and the leak matrix. A file page hits on a
// board only while that board is in the person's scope, its canvas shows the version and it may serve the version,
// all checked at query time. Over PGlite here, and over a real Postgres in scripts/nas-pg-api.sh (the same file:
// DRAFTROOM_TEST_DATABASE_URL), which is the authority on full-text behaviour.
//
// Dev Studio (alice owns it; bob, carol and dave are members; erin is not):
//   P  private, bob's; dave holds a viewer grant; a name-only guest joined it through a review link
//   W  shared with the workspace to view           Q  private, bob's (the guest has no grant on it)
// erin's own workspace has board X with a file of the same words.

import { SEARCH_HITS_PER_BOARD, SearchResponse } from '@draftroom/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseQuery } from '../../../src/features/search/query.ts'
import { rankedHits } from '../../../src/features/search/store.ts'
import { type Client, createBoard, DEV_STUDIO } from '../../helpers.ts'
import { type GuestClient, guestLink, joinAsGuest } from '../guests/support.ts'
import {
  addPdf,
  extract,
  type FileWorld,
  fileHitsOf,
  fileObject,
  fileWorld,
  place,
  searchFiles,
  type VersionRef,
} from './file-support.ts'
import { SearchResponse as SearchResponse7e5b4d6 } from './fixtures/search-7e5b4d6.ts'
import { note, searchRaw, touch } from './support.ts'

let w: FileWorld
let alice: Client
let bob: Client
let carol: Client
let dave: Client
let erin: Client
let guest: GuestClient
const b = { P: '', W: '', Q: '', X: '' }
const v: Record<string, VersionRef & { boardId: string; workspaceId: string }> = {}

beforeAll(async () => {
  w = await fileWorld()
  const { api } = w
  alice = await api.login('alice')
  bob = await api.login('bob')
  carol = await api.login('carol')
  dave = await api.login('dave')
  erin = await api.login('erin')
  await api.db.query('DELETE FROM workspace_members WHERE user_id = $1 AND workspace_id = $2', [
    erin.userId,
    DEV_STUDIO,
  ])
  b.P = await createBoard(bob, DEV_STUDIO, 'Plan P')
  b.W = await createBoard(bob, DEV_STUDIO, 'Shared W')
  b.Q = await createBoard(bob, DEV_STUDIO, 'Quiet Q')
  b.X = await createBoard(erin, erin.personalWorkspaceId, 'Foreign X')
  expect((await bob.req('PATCH', `/api/boards/${b.W}`, { visibility: 'workspace_view' })).statusCode).toBe(
    200,
  )
  expect(
    (await bob.req('PUT', `/api/boards/${b.P}/members/${dave.userId}`, { role: 'viewer' })).statusCode,
  ).toBe(200)
  guest = await joinAsGuest(api, (await guestLink(bob, b.P, { role: 'viewer' })).url, 'Sam')
  v.P = await addPdf(api, b.P, bob, 'Pricing brief.pdf')
  v.W = await addPdf(api, b.W, bob, 'Shared deck.pptx', {
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  })
  v.Q = await addPdf(api, b.Q, bob, 'Quiet.pdf')
  v.X = await addPdf(api, b.X, erin, 'Foreign.pdf', { workspaceId: erin.personalWorkspaceId })
  for (const [k, ver] of Object.entries(v)) {
    w.sync.setText(ver.boardId, [note(`${k}-note`, `a note on board ${k}`)])
    await extract(api, ver, {
      1: `Cover of ${k}`,
      2: `The aardvark pricing for board ${k} is final.`,
      3: `Appendix ${k}: more aardvark tables.`,
    })
    await place(w, ver.boardId, [ver])
  }
})

afterAll(async () => {
  await w.close()
})

const boardsWithFiles = (hits: string[]) => [...new Set(hits.map((h) => h.split(' ')[0]))].sort()

describe('file hits: what a hit says', () => {
  it('keeps kind file, names the version, the page and the file, with a marked snippet', async () => {
    const r = await searchFiles(bob, DEV_STUDIO, 'aardvark pricing')
    const g = r.groups.find((x) => x.board.id === b.P)
    const hit = g?.hits.find((h) => h.file)
    expect(hit).toMatchObject({
      kind: 'file',
      objectId: fileObject(v.P?.versionId as string, 2),
      pageId: null,
      file: { versionId: v.P?.versionId, page: 2, name: 'Pricing brief.pdf' },
    })
    expect(hit?.snippet.filter((s) => s.hit).map((s) => s.text.toLowerCase())).toEqual(
      expect.arrayContaining(['aardvark', 'pricing']),
    )
    // an Office document's text is found the same way (its pages come from its PDF conversion)
    expect(fileHitsOf(r)).toContain(`${b.W} ${fileObject(v.W?.versionId as string, 2)}`)
  })

  it('at most two file pages of a board among its five hits, after its own text; the rest counts in `more`', async () => {
    const extra = await addPdf(w.api, b.Q, bob, 'Many.pdf')
    await extract(w.api, extra, {
      // the file pages have the higher ts_rank: their tier, not their rank, puts them after the notes, and a cap
      // keeps them to two
      1: 'zymurgy zymurgy zymurgy one',
      2: 'zymurgy zymurgy zymurgy two',
      3: 'zymurgy zymurgy zymurgy three',
      4: 'zymurgy zymurgy zymurgy four',
    })
    w.sync.setText(b.Q, [
      note('q1', 'zymurgy note one'),
      note('q2', 'zymurgy note two'),
      note('q3', 'zymurgy note three'),
      note('q4', 'zymurgy note four'),
    ])
    await place(w, b.Q, [v.Q as VersionRef, extra])
    const r = await searchFiles(bob, DEV_STUDIO, 'zymurgy')
    const g = r.groups.find((x) => x.board.id === b.Q)
    expect(g?.hits).toHaveLength(SEARCH_HITS_PER_BOARD)
    // the board's own text first (3 notes), then its two best file pages (the slots a board keeps for them)
    expect(g?.hits.map((h) => (h.file ? 'file' : 'note'))).toEqual(['note', 'note', 'note', 'file', 'file'])
    expect(g?.more).toBe(8 - SEARCH_HITS_PER_BOARD)
    expect(r.totalHits).toBe(8)
  })

  it('a file page never outranks canvas text: boards matched on their text keep their order (review m4)', async () => {
    // three boards: two match on a sticky (one word each), one only through a long page that repeats the word
    const texty1 = await createBoard(bob, DEV_STUDIO, 'Texty one')
    const texty2 = await createBoard(bob, DEV_STUDIO, 'Texty two')
    const filey = await createBoard(bob, DEV_STUDIO, 'Filey')
    w.sync.setText(texty1, [note('t1', 'bilby')])
    w.sync.setText(texty2, [note('t2', 'a bilby and another bilby')])
    w.sync.setText(filey, [note('f0', 'nothing to see')])
    await touch(w.api, texty1)
    await touch(w.api, texty2)
    const long = await addPdf(w.api, filey, bob, 'Bilby report.pdf')
    await extract(w.api, long, { 1: `${'bilby habitat bilby diet '.repeat(40)}end` })
    await place(w, filey, [long])
    const r = await searchFiles(bob, DEV_STUDIO, 'bilby')
    const order = r.groups.map((g) => g.board.id)
    // the canvas boards first, in their order without file search (the two-word note ranks above the one-word one),
    // then the board found only through its file
    expect(order).toEqual([texty2, texty1, filey])
    expect(r.groups[2]?.hits.every((h) => h.file)).toBe(true)
    // with a page of one board's PDF only (Ask's call shape: canvas entries plus file pages), the same tiers
    const ranked = await rankedHits(w.api.db, {
      workspaceId: DEV_STUDIO,
      boardIds: [texty1, texty2, filey],
      query: parseQuery('bilby'),
      boards: 10,
      perBoard: 30,
      team: false,
      source: 'canvas',
      files: { maxPerBoard: 4 },
    })
    expect([...new Set(ranked.map((x) => x.board_id))]).toEqual([texty2, texty1, filey])
    // and the long page's raw rank is the highest of all: only its tier keeps it last
    const best = (id: string) => Math.max(...ranked.filter((x) => x.board_id === id).map((x) => x.rank))
    expect(best(filey)).toBeGreaterThan(best(texty2))
  })

  it('finds a CJK word at the start of a run of text (the simple configuration)', async () => {
    const cjk = await addPdf(w.api, b.Q, bob, '会議.pdf')
    await extract(w.api, cjk, { 1: '東京の会議 議事録', 2: 'その他' })
    await place(w, b.Q, [v.Q as VersionRef, cjk])
    const r = await searchFiles(bob, DEV_STUDIO, '東京')
    expect(fileHitsOf(r)).toEqual([`${b.Q} ${fileObject(cjk.versionId, 1)}`])
    expect(fileHitsOf(await searchFiles(bob, DEV_STUDIO, '議事録'))).toEqual([
      `${b.Q} ${fileObject(cjk.versionId, 1)}`,
    ])
  })

  it('a tab of the deployed web (7e5b4d6) parses the answer and keeps its hits', async () => {
    const res = await searchRaw(bob, DEV_STUDIO, 'aardvark')
    const old = SearchResponse7e5b4d6.parse(res.json())
    const files = old.groups.flatMap((g) => g.hits).filter((h) => h.objectId.startsWith('file:'))
    expect(files.length).toBeGreaterThan(0)
    for (const h of files) expect(h.kind).toBe('file')
  })
})

describe('the leak matrix', () => {
  it('a private board file never hits for a member without access, a stranger or another workspace', async () => {
    expect(boardsWithFiles(fileHitsOf(await searchFiles(alice, DEV_STUDIO, 'aardvark')))).toEqual(
      [b.P, b.W, b.Q].sort(),
    )
    expect(boardsWithFiles(fileHitsOf(await searchFiles(dave, DEV_STUDIO, 'aardvark')))).toEqual(
      [b.P, b.W].sort(),
    )
    const carolRes = await searchRaw(carol, DEV_STUDIO, 'aardvark')
    expect(boardsWithFiles(fileHitsOf(SearchResponseOf(carolRes.json())))).toEqual([b.W])
    expect(carolRes.body).not.toContain(v.P?.versionId)
    expect(carolRes.body).not.toContain('Pricing brief')
    // erin: Dev Studio does not exist for her; her own workspace finds only her own file
    expect((await searchRaw(erin, DEV_STUDIO, 'aardvark')).statusCode).toBe(404)
    expect(fileHitsOf(await searchFiles(erin, erin.personalWorkspaceId, 'aardvark'))).toEqual([
      `${b.X} ${fileObject(v.X?.versionId as string, 2)}`,
      `${b.X} ${fileObject(v.X?.versionId as string, 3)}`,
    ])
    for (const c of [alice, bob, carol, dave])
      expect((await searchRaw(c, DEV_STUDIO, 'aardvark')).body).not.toContain(v.X?.versionId)
  })

  it('a name-only guest finds only the files of the boards of their grants', async () => {
    const res = await guest.req('GET', `/api/workspaces/${DEV_STUDIO}/search?q=aardvark`)
    expect(res.statusCode, res.body).toBe(200)
    const r = SearchResponseOf(res.json())
    expect(boardsWithFiles(fileHitsOf(r))).toEqual([b.P])
    expect(res.body).not.toContain(v.W?.versionId)
    expect(res.body).not.toContain(v.Q?.versionId)
  })

  it('a person who loses access stops finding the file at once', async () => {
    const grant = await bob.req('PUT', `/api/boards/${b.Q}/members/${carol.userId}`, { role: 'viewer' })
    expect(grant.statusCode, grant.body).toBe(200)
    expect(boardsWithFiles(fileHitsOf(await searchFiles(carol, DEV_STUDIO, 'aardvark')))).toEqual(
      [b.W, b.Q].sort(),
    )
    expect((await bob.req('DELETE', `/api/boards/${b.Q}/members/${carol.userId}`)).statusCode).toBe(200)
    const after = await searchRaw(carol, DEV_STUDIO, 'aardvark')
    expect(after.body).not.toContain(v.Q?.versionId)
    expect(boardsWithFiles(fileHitsOf(SearchResponseOf(after.json())))).toEqual([b.W])
  })

  it('a file removed from the board stops hitting after the reindex; "Recently deleted" does not count', async () => {
    const board = await createBoard(bob, DEV_STUDIO, 'Removal R')
    const ver = await addPdf(w.api, board, bob, 'Removed.pdf')
    await extract(w.api, ver, { 1: 'quokka census' })
    await place(w, board, [ver])
    expect(fileHitsOf(await searchFiles(bob, DEV_STUDIO, 'quokka'))).toEqual([
      `${board} ${fileObject(ver.versionId, 1)}`,
    ])
    // the card is deleted: the canvas no longer shows it, only "Recently deleted" could bring it back
    await place(w, board, [], { deleted: [ver] })
    expect(fileHitsOf(await searchFiles(bob, DEV_STUDIO, 'quokka'))).toEqual([])
    expect(
      (await w.api.db.query('SELECT 1 FROM board_file_refs WHERE board_id = $1', [board])).rows,
    ).toHaveLength(0)
    // an image naming its version by fileId only (no file facts) still counts as placed
    await place(w, board, [], { versionsOnly: [ver.versionId] })
    expect(fileHitsOf(await searchFiles(bob, DEV_STUDIO, 'quokka'))).toHaveLength(1)
  })

  it('a version linked to a board but not placed on it does not hit; placed but not served does not either', async () => {
    const linked = await createBoard(bob, DEV_STUDIO, 'Linked L')
    const other = await createBoard(bob, DEV_STUDIO, 'Other O')
    const ver = await addPdf(w.api, other, bob, 'Linked.pdf')
    await extract(w.api, ver, { 1: 'wombat roster' })
    // board_asset_links: L may serve the file (made from content that showed it), but its canvas does not show it
    await w.api.db.query(
      `INSERT INTO board_asset_links (workspace_id, board_id, asset_id, version_id) VALUES ($1, $2, $3, $4)`,
      [DEV_STUDIO, linked, ver.assetId, ver.versionId],
    )
    w.sync.setText(linked, [note('l1', 'a note')])
    await touch(w.api, linked)
    expect(fileHitsOf(await searchFiles(bob, DEV_STUDIO, 'wombat'))).toEqual([])
    // placed on L too: now it hits there (served through the link)
    await place(w, linked, [ver])
    expect(fileHitsOf(await searchFiles(bob, DEV_STUDIO, 'wombat'))).toEqual([
      `${linked} ${fileObject(ver.versionId, 1)}`,
    ])
    // a third board whose canvas names the version but that may not serve it (no link, uploaded elsewhere)
    const stray = await createBoard(bob, DEV_STUDIO, 'Stray S')
    await place(w, stray, [ver])
    const r = await searchFiles(bob, DEV_STUDIO, 'wombat')
    expect(fileHitsOf(r)).toEqual([`${linked} ${fileObject(ver.versionId, 1)}`])
  })

  it('a canvas naming a version of another workspace records nothing', async () => {
    const board = await createBoard(bob, DEV_STUDIO, 'Cross C')
    await place(w, board, [v.X as VersionRef])
    await searchFiles(bob, DEV_STUDIO, 'aardvark')
    expect(
      (await w.api.db.query('SELECT 1 FROM board_file_refs WHERE board_id = $1', [board])).rows,
    ).toHaveLength(0)
  })

  it('a trashed board does not hit (and its refs go); restored, it is indexed again', async () => {
    const board = await createBoard(bob, DEV_STUDIO, 'Trash T')
    const ver = await addPdf(w.api, board, bob, 'Trash.pdf')
    await extract(w.api, ver, { 1: 'narwhal ledger' })
    await place(w, board, [ver])
    expect(fileHitsOf(await searchFiles(alice, DEV_STUDIO, 'narwhal'))).toHaveLength(1)
    expect((await bob.req('POST', `/api/boards/${board}/trash`)).statusCode).toBe(200)
    await w.indexer.idle()
    for (const c of [alice, bob]) {
      const res = await searchRaw(c, DEV_STUDIO, 'narwhal')
      expect(res.body).not.toContain(ver.versionId)
    }
    expect(
      (await w.api.db.query('SELECT 1 FROM board_file_refs WHERE board_id = $1', [board])).rows,
    ).toHaveLength(0)
    expect((await bob.req('POST', `/api/boards/${board}/restore`)).statusCode).toBe(200)
    expect(fileHitsOf(await searchFiles(alice, DEV_STUDIO, 'narwhal'))).toHaveLength(1)
  })

  it('an archived board hits only in the archived list', async () => {
    const board = await createBoard(bob, DEV_STUDIO, 'Archive A')
    const ver = await addPdf(w.api, board, bob, 'Archive.pdf')
    await extract(w.api, ver, { 1: 'pangolin minutes' })
    await place(w, board, [ver])
    expect((await bob.req('POST', `/api/boards/${board}/archive`)).statusCode).toBe(200)
    expect(fileHitsOf(await searchFiles(bob, DEV_STUDIO, 'pangolin'))).toEqual([])
    expect(fileHitsOf(await searchFiles(bob, DEV_STUDIO, 'pangolin', { status: 'archived' }))).toEqual([
      `${board} ${fileObject(ver.versionId, 1)}`,
    ])
  })

  it('a version whose text is not done never hits (mid-extraction pages stay hidden)', async () => {
    const board = await createBoard(bob, DEV_STUDIO, 'Pending N')
    const ver = await addPdf(w.api, board, bob, 'Pending.pdf')
    await w.api.db.query(
      `INSERT INTO file_text_pages (version_id, workspace_id, page, body, tsv)
       VALUES ($1, $2, 1, 'okapi draft', to_tsvector('simple', 'okapi draft'))`,
      [ver.versionId, DEV_STUDIO],
    )
    await place(w, board, [ver])
    expect(fileHitsOf(await searchFiles(bob, DEV_STUDIO, 'okapi'))).toEqual([])
  })

  it('the file collector deleting a version takes its text, state and refs with it (cascade)', async () => {
    const board = await createBoard(bob, DEV_STUDIO, 'Collect G')
    const ver = await addPdf(w.api, board, bob, 'Gone.pdf')
    await extract(w.api, ver, { 1: 'tapir inventory', 2: 'tapir again' })
    await place(w, board, [ver])
    expect(fileHitsOf(await searchFiles(bob, DEV_STUDIO, 'tapir'))).toHaveLength(2)
    await w.api.db.query('DELETE FROM worker_ops WHERE source_version_id = $1', [ver.versionId])
    await w.api.db.query('DELETE FROM asset_versions WHERE id = $1', [ver.versionId])
    const left = await w.api.db.one<{ pages: number; state: number; refs: number }>(
      `SELECT (SELECT count(*)::int FROM file_text_pages WHERE version_id = $1) AS pages,
              (SELECT count(*)::int FROM file_text_state WHERE version_id = $1) AS state,
              (SELECT count(*)::int FROM board_file_refs WHERE version_id = $1) AS refs`,
      [ver.versionId],
    )
    expect(left).toEqual({ pages: 0, state: 0, refs: 0 })
    expect(fileHitsOf(await searchFiles(bob, DEV_STUDIO, 'tapir'))).toEqual([])
  })
})

describe('with DRAFTROOM_FILE_SEARCH off', () => {
  it('searches canvas text only: stored file text is never read, refs are never fetched', async () => {
    const off = await fileWorld({ env: { DRAFTROOM_FILE_SEARCH: 'off' } })
    try {
      const owner = await off.api.login('owner')
      const board = await createBoard(owner, DEV_STUDIO, 'Off')
      const ver = await addPdf(off.api, board, owner, 'Off.pdf')
      await off.api.db.query(
        `INSERT INTO file_text_state (version_id, workspace_id, status, pages, bytes, extractor)
         VALUES ($1, $2, 'done', 1, 10, 'pdfjs-6.3.289')`,
        [ver.versionId, DEV_STUDIO],
      )
      await off.api.db.query(
        `INSERT INTO file_text_pages (version_id, workspace_id, page, body, tsv)
         VALUES ($1, $2, 1, 'ibex text', to_tsvector('simple', 'ibex text'))`,
        [ver.versionId, DEV_STUDIO],
      )
      await off.api.db.query(
        'INSERT INTO board_file_refs (board_id, workspace_id, version_id) VALUES ($1, $2, $3)',
        [board, DEV_STUDIO, ver.versionId],
      )
      off.sync.setText(board, [note('o1', 'ibex note')])
      await touch(off.api, board)
      const r = await searchFiles(owner, DEV_STUDIO, 'ibex')
      expect(r.groups.flatMap((g) => g.hits).map((h) => h.objectId)).toEqual(['shape:o1'])
      expect(off.sync.refsCalls).toEqual([])
    } finally {
      await off.close()
    }
  })
})

const SearchResponseOf = (json: unknown) => SearchResponse.parse(json)
