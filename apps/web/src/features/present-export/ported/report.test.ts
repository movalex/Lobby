// RETRO-05b: what the PDF's results page and comments appendix hold, and how they are laid out (report.ts).
import type { CommentAnchor, CommentThread, VoteResult } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import {
  COMMENT_MAX_CHARS,
  commentsBlocks,
  countReportThreads,
  describeAnchor,
  describeElement,
  layoutReport,
  type Measure,
  oneLine,
  REPORT_PAGE_PX,
  type ReportBlock,
  reportThreads,
  resultRows,
  resultsBlocks,
  wrapText,
} from './report.ts'

// ---- fixtures ------------------------------------------------------------------------------------------------

const vote = (shapeId: string, count: number, rank: number): VoteResult => ({
  shapeId: `shape:${shapeId}`,
  count,
  rank,
})

interface FakeEl {
  id: string
  type: string
  isDeleted?: boolean
  frameId?: string | null
  name?: string
  customData?: { lobby?: { file?: { name?: string } } }
}
const BOARD: Record<
  string,
  { el: FakeEl; text?: string; box?: { x: number; y: number; width: number; height: number } }
> = {
  n1: { el: { id: 'n1', type: 'rectangle', frameId: 'f1' }, text: 'Ship the beta\nbefore the offsite' },
  n2: { el: { id: 'n2', type: 'rectangle', frameId: null }, text: 'More  coffee' },
  n3: { el: { id: 'n3', type: 'image', frameId: 'f1' }, text: '' },
  n4: {
    el: { id: 'n4', type: 'image', frameId: null, customData: { lobby: { file: { name: 'brief.pdf' } } } },
    text: '',
  },
  gone: { el: { id: 'gone', type: 'rectangle', isDeleted: true }, text: 'deleted' },
  f1: {
    el: { id: 'f1', type: 'frame', name: 'Roadmap' },
    text: '',
    box: { x: 0, y: 0, width: 800, height: 450 },
  },
  f2: {
    el: { id: 'f2', type: 'frame', name: '  ' },
    text: '',
    box: { x: 1000, y: 0, width: 800, height: 450 },
  },
}
const canvas = {
  get: (id: string) => BOARD[id]?.el ?? null,
  items: () => Object.values(BOARD).map((b) => b.el),
  bounds: (id: string) => BOARD[id]?.box ?? null,
  text: { of: (id: string) => BOARD[id]?.text ?? '' },
} as unknown as Parameters<typeof describeElement>[0]

const thread = (over: Partial<CommentThread> & { id: string }): CommentThread =>
  ({
    boardId: 'b-3k9x0q2m7a',
    anchor: { kind: 'shape', shapeId: 'shape:n1', u: 0.5, v: 0.5 },
    status: 'open',
    createdBy: { id: 'usr_aaaaaaaaaa', name: 'Alice Park', color: '#123456' },
    createdAt: '2026-10-02T10:00:00.000Z',
    updatedAt: '2026-10-02T10:00:00.000Z',
    resolvedBy: null,
    resolvedAt: null,
    visibility: 'everyone',
    comments: [
      {
        id: `cmt_${over.id}00000000`,
        threadId: over.id,
        author: { id: 'usr_aaaaaaaaaa', name: 'Alice Park', color: '#123456' },
        body: 'Looks good',
        mentions: [],
        createdAt: '2026-10-02T10:00:00.000Z',
        editedAt: null,
      },
    ],
    ...over,
  }) as CommentThread

const date = (iso: string) => iso.slice(0, 10)
const OPTS = { authorsHidden: false, teamOnlyIncluded: false, formatDate: date }

// ---- results -----------------------------------------------------------------------------------------------------

describe('the results page', () => {
  it('names each ranked item by its words, joined on one line, and the frame it sits in', () => {
    const { rows, missing } = resultRows(
      [vote('n1', 5, 1), vote('n2', 5, 1), vote('n3', 2, 3), vote('n4', 1, 4)],
      (id) => describeElement(canvas, id),
    )
    expect(missing).toBe(0)
    expect(rows).toEqual([
      { rank: 1, votes: 5, label: 'Ship the beta · before the offsite', where: '“Roadmap”' },
      { rank: 1, votes: 5, label: 'More coffee', where: null },
      { rank: 3, votes: 2, label: 'Image', where: '“Roadmap”' },
      { rank: 4, votes: 1, label: 'brief.pdf', where: null },
    ])
  })

  it('leaves out an item deleted since the reveal and says how many', () => {
    const { rows, missing } = resultRows([vote('n1', 3, 1), vote('gone', 2, 2), vote('nope', 1, 3)], (id) =>
      describeElement(canvas, id),
    )
    expect(rows.map((r) => r.label)).toEqual(['Ship the beta · before the offsite'])
    expect(missing).toBe(2)
    expect(resultsBlocks(rows, missing).at(-1)).toMatchObject({
      kind: 'text',
      text: '2 voted items were deleted from the board and are not listed.',
    })
  })

  it('has one item per row: #rank in the lead, the votes and the frame under the words; ties share a rank', () => {
    const blocks = resultsBlocks([
      { rank: 1, votes: 4, label: 'A', where: '“Roadmap”' },
      { rank: 1, votes: 4, label: 'B', where: null },
      { rank: 3, votes: 1, label: 'C', where: null },
    ])
    expect(blocks[0]).toMatchObject({
      kind: 'text',
      text: expect.stringContaining('3 items received votes (9 votes in total)'),
    })
    expect(blocks.slice(1)).toEqual([
      { kind: 'item', lead: '#1', title: 'A', meta: '4 votes · in “Roadmap”' },
      { kind: 'item', lead: '#1', title: 'B', meta: '4 votes' },
      { kind: 'item', lead: '#3', title: 'C', meta: '1 vote' },
    ])
  })

  it('has no page without results', () => {
    expect(resultsBlocks([])).toEqual([])
  })

  it('oneLine joins lines with " · ", squeezes spaces and bounds the length', () => {
    expect(oneLine('  a  b \n\n c\r\nd ')).toBe('a b · c · d')
    expect(Array.from(oneLine('x'.repeat(500), 20))).toHaveLength(20)
  })
})

// ---- comments ----------------------------------------------------------------------------------------------------

describe('the comments appendix', () => {
  const open1 = thread({ id: 'thr_open1' })
  const open2 = thread({
    id: 'thr_open2',
    createdAt: '2026-10-03T10:00:00.000Z',
    comments: [
      {
        id: 'cmt_open2first0',
        threadId: 'thr_open2',
        author: { id: 'usr_bbbbbbbbbb', name: 'Bob Chen', color: '#654321' },
        body: 'Hello @[Alice Park](usr_aaaaaaaaaa), see this',
        mentions: ['usr_aaaaaaaaaa'],
        createdAt: '2026-10-03T10:00:00.000Z',
        editedAt: null,
      },
      {
        id: 'cmt_open2second',
        threadId: 'thr_open2',
        author: { id: 'usr_aaaaaaaaaa', name: 'Alice Park', color: '#123456' },
        body: 'Done',
        mentions: [],
        createdAt: '2026-10-04T10:00:00.000Z',
        editedAt: null,
      },
    ],
  })
  const resolved = thread({ id: 'thr_res', status: 'resolved', createdAt: '2026-09-30T10:00:00.000Z' })
  const team = thread({ id: 'thr_team', visibility: 'team', createdAt: '2026-10-01T10:00:00.000Z' })
  const empty = thread({ id: 'thr_empty', comments: [] })
  const where = (a: CommentAnchor) => describeAnchor(canvas, a)

  it('lists open threads first (oldest first), then resolved, and prints mentions as @Name', () => {
    const list = reportThreads([resolved, open2, open1, empty], where, OPTS)
    expect(list.map((t) => [t.status, t.comments[0]?.text])).toEqual([
      ['open', 'Looks good'],
      ['open', 'Hello @Alice Park, see this'],
      ['resolved', 'Looks good'],
    ])
    expect(list[1]?.comments.map((c) => [c.author, c.date])).toEqual([
      ['Bob Chen', '2026-10-03'],
      ['Alice Park', '2026-10-04'],
    ])
  })

  it('leaves team-only threads out unless asked: a file made for a client must not carry them by accident', () => {
    expect(reportThreads([open1, team], where, OPTS)).toHaveLength(1)
    const withTeam = reportThreads([open1, team], where, { ...OPTS, teamOnlyIncluded: true })
    expect(withTeam.map((t) => t.teamOnly)).toEqual([false, true])
    expect(countReportThreads([open1, team, resolved], false)).toEqual({ open: 1, resolved: 1, teamOnly: 1 })
    expect(countReportThreads([open1, team, resolved], true)).toEqual({ open: 2, resolved: 1, teamOnly: 1 })
  })

  it('names nobody when the board hides note authors, and says so', () => {
    const o = { ...OPTS, authorsHidden: true }
    const list = reportThreads([open2], where, o)
    expect(list[0]?.comments.map((c) => c.author)).toEqual([null, null])
    const blocks = commentsBlocks(list, o)
    expect(blocks[0]).toMatchObject({ text: expect.stringContaining('hides note authors') })
    const all = JSON.stringify(blocks)
    expect(all).not.toContain('Bob Chen')
    // (a name typed inside a comment is the comment’s own words)
    expect(list[0]?.comments.every((c) => c.author === null)).toBe(true)
    expect(blocks.find((b) => b.kind === 'item')).toMatchObject({
      body: ['2026-10-03: Hello @Alice Park, see this', '2026-10-04: Done'],
    })
  })

  it('has "Open (n)" and "Resolved (n)" groups, a running number, and the place each thread sits', () => {
    const list = reportThreads([open1, open2, resolved, team], where, { ...OPTS, teamOnlyIncluded: true })
    const blocks = commentsBlocks(list, { ...OPTS, teamOnlyIncluded: true })
    expect(blocks[0]).toMatchObject({
      text: expect.stringMatching(
        /3 open threads and 1 resolved thread.*Team-only comments are included and marked/,
      ),
    })
    expect(blocks.filter((b) => b.kind === 'heading').map((b) => (b as { text: string }).text)).toEqual([
      'Open (3)',
      'Resolved (1)',
    ])
    const items = blocks.filter((b): b is Extract<ReportBlock, { kind: 'item' }> => b.kind === 'item')
    expect(items.map((i) => i.lead)).toEqual(['1', '2', '3', '4'])
    expect(items[0]?.title).toBe('On “Ship the beta · before the offsite”, in “Roadmap”')
    expect(items[0]?.body).toEqual(['Alice Park, 2026-10-02: Looks good'])
    expect(items.filter((i) => i.meta === 'Team only')).toHaveLength(1)
  })

  it('has no page without threads', () => {
    expect(commentsBlocks([], OPTS)).toEqual([])
  })

  it('cuts a very long comment', () => {
    const long = thread({
      id: 'thr_long',
      comments: [{ ...(open1.comments[0] as CommentThread['comments'][number]), body: 'w'.repeat(5000) }],
    })
    const list = reportThreads([long], where, OPTS)
    expect(Array.from(list[0]?.comments[0]?.text ?? '')).toHaveLength(COMMENT_MAX_CHARS)
  })

  it('names where a thread sits: an item, a page of a file, a frame, the board, or an item that is gone', () => {
    expect(where({ kind: 'shape', shapeId: 'shape:n2', u: 0, v: 0 })).toBe('On “More coffee”')
    expect(where({ kind: 'shape', shapeId: 'shape:n4', u: 0, v: 0 })).toBe('On “brief.pdf”')
    expect(
      where({
        kind: 'asset',
        shapeId: 'shape:n4',
        assetId: 'ast_aaaaaaaaaa',
        versionId: 'ver_aaaaaaaaaa',
        page: 3,
      }),
    ).toBe('On “brief.pdf”, page 3')
    expect(
      where({
        kind: 'asset',
        shapeId: 'shape:n3',
        assetId: 'ast_aaaaaaaaaa',
        versionId: 'ver_aaaaaaaaaa',
        timeMs: 75_000,
      }),
    ).toBe('On “Image”, at 1:15, in “Roadmap”')
    expect(where({ kind: 'point', x: 100, y: 100 })).toBe('In “Roadmap”')
    expect(where({ kind: 'point', x: 1100, y: 100 })).toBe('In an untitled frame')
    expect(where({ kind: 'point', x: 5000, y: 5000 })).toBe('On the board')
    expect(where({ kind: 'shape', shapeId: 'shape:gone', u: 0, v: 0 })).toBe('On an item that was removed')
    expect(where({ kind: 'shape', shapeId: 'shape:never', u: 0, v: 0 })).toBe('On an item that was removed')
  })
})

// ---- layout ------------------------------------------------------------------------------------------------------------

/** Every character is half its font size wide. */
const measure: Measure = (text, fontPx) => text.length * fontPx * 0.5
const A4 = REPORT_PAGE_PX.fit

describe('wrapping', () => {
  it('breaks at spaces, keeps blank lines, and cuts a word wider than the line by character', () => {
    const w = (s: string) => s.length
    expect(wrapText('aaa bbb ccc', 7, w)).toEqual(['aaa bbb', 'ccc'])
    expect(wrapText('one\n\ntwo', 20, w)).toEqual(['one', '', 'two'])
    expect(wrapText('abcdefghij', 4, w)).toEqual(['abcd', 'efgh', 'ij'])
    expect(wrapText('', 10, w)).toEqual([''])
  })
})

describe('the layout', () => {
  const items = (
    n: number,
    body = 'A comment that is long enough to take a line or two on a page.',
  ): ReportBlock[] =>
    Array.from({ length: n }, (_, i) => ({
      kind: 'item',
      lead: String(i + 1),
      title: `Item ${i + 1}`,
      body: [body],
    }))

  it('puts a short list on one page, inside the margins, with the lead in its own column', () => {
    const { pages, notShown } = layoutReport(items(3), measure, A4)
    expect(notShown).toBe(0)
    expect(pages).toHaveLength(1)
    const margin = Math.round(A4.width * 0.07)
    for (const l of pages[0]?.lines ?? []) {
      expect(l.x).toBeGreaterThanOrEqual(margin)
      expect(l.x + l.w).toBeLessThanOrEqual(A4.width - margin + 1)
      expect(l.y).toBeGreaterThanOrEqual(margin)
      expect(l.y + l.h).toBeLessThanOrEqual(A4.height - margin + 1e-6)
    }
    const leads = pages[0]?.lines.filter((l) => l.x === margin).map((l) => l.text)
    expect(leads).toEqual(['1', '2', '3'])
    // top to bottom, in reading order
    const ys = (pages[0]?.lines ?? []).map((l) => l.y)
    expect([...ys].sort((a, b) => a - b)).toEqual(ys)
  })

  it('wraps long text inside the content column', () => {
    const long = 'word '.repeat(200)
    const { pages } = layoutReport([{ kind: 'item', lead: '1', body: [long] }], measure, A4)
    const margin = Math.round(A4.width * 0.07)
    const body = pages.flatMap((p) => p.lines).filter((l) => l.x > margin)
    expect(body.length).toBeGreaterThan(5)
    for (const l of body) expect(l.x + l.w).toBeLessThanOrEqual(A4.width - margin + 1)
  })

  it('runs onto more pages, each item once, its title kept with its first line of text', () => {
    const { pages, notShown } = layoutReport(items(60), measure, A4)
    expect(notShown).toBe(0)
    expect(pages.length).toBeGreaterThan(1)
    const titles = pages.flatMap((p) => p.lines.filter((l) => l.text.startsWith('Item ')).map((l) => l.text))
    expect(titles).toEqual(Array.from({ length: 60 }, (_, i) => `Item ${i + 1}`))
    // no page ends on a title: the text under it is on the same page
    for (const p of pages) {
      const last = p.lines[p.lines.length - 1]
      expect(last?.text.startsWith('Item ')).toBe(false)
    }
    // every page starts at the top margin
    for (const p of pages) expect(p.lines[0]?.y).toBe(Math.round(A4.width * 0.07))
  })

  it('stops at the page limit and counts the items it did not draw', () => {
    const { pages, notShown } = layoutReport(items(60), measure, A4, { maxPages: 2 })
    expect(pages).toHaveLength(2)
    const drawn = pages.flatMap((p) => p.lines.filter((l) => l.text.startsWith('Item '))).length
    expect(drawn + notShown).toBe(60)
    expect(notShown).toBeGreaterThan(0)
  })

  it('has no page for no blocks, and gives every format its own page shape', () => {
    expect(layoutReport([], measure, A4).pages).toEqual([])
    expect(REPORT_PAGE_PX.fit.height).toBeGreaterThan(REPORT_PAGE_PX.fit.width)
    expect(REPORT_PAGE_PX.a4.width).toBeGreaterThan(REPORT_PAGE_PX.a4.height)
    expect(REPORT_PAGE_PX['16:9'].width / REPORT_PAGE_PX['16:9'].height).toBeCloseTo(16 / 9, 2)
  })

  it('draws an item that has only a lead', () => {
    const { pages } = layoutReport([{ kind: 'item', lead: '#1' }], measure, A4)
    expect(pages[0]?.lines.map((l) => l.text)).toEqual(['#1'])
  })
})
