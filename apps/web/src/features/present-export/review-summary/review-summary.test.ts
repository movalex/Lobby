// Wave S (WS4): the review summary PDF in Node. The model (who, when, the last 10 events, every open thread, the guest
// footnote), the layout (cover, one or two pages per item, the 60-page limit, the footnote), the SVG the vector path
// draws (read back by the vector reading with no problems), and the PDF itself: real text, the picture as an image
// object, the bookmarks.
import {
  type CommentThread,
  REVIEW_GUEST_FOOTNOTE,
  REVIEW_SUMMARY,
  type ReviewEvent,
  type ReviewItem,
  type ReviewRound,
  type ReviewSummaryModel,
} from '@draftroom/contracts'
import { PDFDict, PDFDocument, PDFName, PDFRawStream, PDFStream } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { createPdfBuilder } from '../pdf-build.ts'
import { readScene } from '../vector/svg-scene.ts'
import { layoutSummary, type MeasureText, SUMMARY_PAGE, type SummaryPicture } from './layout.ts'
import { buildSummaryModel, eventText, type SummaryEntry } from './model.ts'
import { pageToSvg, xmlText } from './svg.ts'

const measure: MeasureText = (text, size, bold) => text.length * size * (bold ? 0.58 : 0.52)
const fmt = (iso: string) => iso.slice(0, 10)

const item = (n: number, over: Partial<ReviewItem> = {}): ReviewItem => ({
  id: `rvi_item${String(n).padStart(10, '0')}`,
  boardId: 'b-board123',
  elementId: `el${n}`,
  kind: 'frame',
  assetId: null,
  label: `Item ${n}`,
  position: null,
  roundId: null,
  status: 'pending',
  statusSeq: 0,
  statusBy: null,
  statusAt: null,
  statusVersionId: null,
  createdAt: '2026-10-10T10:00:00.000Z',
  removedAt: null,
  ...over,
})

const guestAna = { id: 'usr_ana0000000001', name: 'Ana', kind: 'guest' as const, external: false }
const bob = { id: 'usr_bob0000000001', name: 'Bob Stone', kind: 'account' as const, external: false }
const carol = { id: 'usr_carol00000001', name: 'Carol', kind: 'account' as const, external: true }

const event = (n: number, over: Partial<ReviewEvent> = {}): ReviewEvent => ({
  id: `rve_event${String(n).padStart(9, '0')}`,
  itemId: `rvi_item${String(1).padStart(10, '0')}`,
  roundId: null,
  kind: 'status',
  status: 'approved',
  previousStatus: 'pending',
  reason: 'set',
  versionId: null,
  threadId: null,
  actor: bob,
  itemCount: null,
  createdAt: `2026-10-1${n % 10}T10:00:00.000Z`,
  seq: n,
  ...over,
})

const thread = (
  id: string,
  comments: { name: string; text: string; external?: boolean }[],
  over: Partial<CommentThread> = {},
): CommentThread =>
  ({
    id,
    boardId: 'b-board123',
    anchor: { kind: 'shape', shapeId: 'shape:el1', u: 0.5, v: 0.5 },
    status: 'open',
    visibility: 'everyone',
    createdBy: { id: 'usr_x', name: comments[0]?.name ?? 'x', color: '#000000' },
    createdAt: '2026-10-11T10:00:00.000Z',
    updatedAt: '2026-10-11T10:00:00.000Z',
    comments: comments.map((c, i) => ({
      id: `cmt_${id}_${i}`,
      threadId: id,
      author: { id: 'usr_x', name: c.name, color: '#000000', ...(c.external ? { external: true } : {}) },
      body: c.text,
      mentions: [],
      createdAt: `2026-10-11T1${i}:00:00.000Z`,
      editedAt: null,
    })),
    ...over,
  }) as unknown as CommentThread

const round: ReviewRound = {
  id: 'rvr_round00000001',
  boardId: 'b-board123',
  number: 2,
  title: 'Round 2',
  openedBy: bob,
  openedAt: '2026-10-14T09:00:00.000Z',
  closedAt: null,
  checkpointId: null,
}

function model(over: Partial<Parameters<typeof buildSummaryModel>[0]> = {}): ReviewSummaryModel {
  const entries: SummaryEntry[] = [
    {
      item: item(1, {
        status: 'approved',
        statusBy: guestAna,
        statusAt: '2026-10-15T12:00:00.000Z',
        kind: 'file',
        assetId: 'ast_asset0000001',
      }),
      label: 'Key art A',
      version: { n: 3, of: 3 },
    },
    {
      item: item(2, { status: 'changes_requested', statusBy: carol, statusAt: '2026-10-15T13:00:00.000Z' }),
      label: 'Key art B',
    },
    { item: item(3), label: 'Teaser' },
  ]
  const threads = [
    thread('thr_a', [
      { name: 'Ana (guest)', text: 'Love the colour' },
      { name: 'Bob Stone', text: 'Thanks!' },
    ]),
    thread('thr_team', [{ name: 'Bob Stone', text: 'internal only' }], { visibility: 'team' }),
  ]
  return buildSummaryModel({
    boardTitle: 'Pitch wall',
    round,
    entries,
    events: new Map([
      [
        entries[0]?.item.id as string,
        Array.from({ length: 14 }, (_, i) => event(14 - i, i === 13 ? { actor: guestAna } : {})),
      ],
    ]),
    threads,
    threadsOf: (e) =>
      e.item.id === entries[0]?.item.id ? threads.filter((t) => t.visibility !== 'team') : [],
    resolvedOf: (e) => (e.item.id === entries[0]?.item.id ? 2 : 0),
    generatedBy: 'Bob Stone',
    now: new Date('2026-10-16T08:00:00.000Z'),
    formatDate: fmt,
    formatDateTime: fmt,
    ...over,
  })
}

describe('the summary model', () => {
  it('names who and when as the contracts do: a guest with "(guest)", an outside account with "External"', () => {
    const m = model()
    expect(m.items[0]).toMatchObject({
      label: 'Key art A',
      status: 'approved',
      by: 'Ana (guest)',
      at: '2026-10-15T12:00:00.000Z',
      version: 'v3 of 3',
    })
    expect(m.items[1]).toMatchObject({ by: 'Carol · External', version: null })
    expect(m.items[2]).toMatchObject({ by: null, at: null, status: 'pending' })
    expect(m.cover).toMatchObject({
      boardTitle: 'Pitch wall',
      roundTitle: 'Round 2',
      openedAt: round.openedAt,
      closedAt: null,
      generatedBy: 'Bob Stone',
      counts: { approved: 1, changes_requested: 1, pending: 1 },
    })
  })

  it('keeps the last REVIEW_SUMMARY.historyRows events, newest first, as text', () => {
    const m = model()
    expect(m.items[0]?.history).toHaveLength(REVIEW_SUMMARY.historyRows)
    expect(m.items[0]?.history[0]).toBe('2026-10-14 · Bob Stone: Approved')
  })

  it('prints every open thread with its replies, counts the resolved, and never prints a team-only thread', () => {
    const m = model()
    expect(m.items[0]?.threads).toEqual([
      {
        author: 'Ana (guest)',
        lines: ['Ana (guest), 2026-10-11: Love the colour', 'Bob Stone, 2026-10-11: Thanks!'],
      },
    ])
    expect(m.items[0]?.resolvedThreads).toBe(2)
    expect(JSON.stringify(m)).not.toContain('internal only')
  })

  it('adds the guest footnote when a guest appears anywhere, and not otherwise', () => {
    expect(model().footnote).toBe(REVIEW_GUEST_FOOTNOTE)
    const clean = buildSummaryModel({
      boardTitle: 'B',
      round: null,
      entries: [{ item: item(1, { status: 'approved', statusBy: bob }), label: 'One' }],
      events: new Map(),
      threads: [],
      threadsOf: () => [],
      resolvedOf: () => 0,
      generatedBy: 'Bob',
      now: new Date('2026-10-16T08:00:00.000Z'),
    })
    expect(clean.footnote).toBeNull()
    expect(clean.cover.roundTitle).toBeNull()
  })

  it('writes round and reset events in words', () => {
    expect(eventText(event(1, { reason: 'new_version', status: 'pending', actor: guestAna }), fmt)).toBe(
      '2026-10-11 · Back to awaiting review: a new version was uploaded by Ana (guest)',
    )
    expect(eventText(event(2, { kind: 'added', status: null, reason: null }), fmt)).toBe(
      '2026-10-12 · Added to review by Bob Stone',
    )
  })
})

const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg=='
const picture: SummaryPicture = { dataUrl: `data:image/png;base64,${PNG_B64}`, width: 800, height: 450 }

describe('the summary layout', () => {
  it('has a cover page first (title, round, counts, contents) and one page per item', () => {
    const { pages, notShown } = layoutSummary(model(), () => picture, measure, { formatDate: fmt })
    expect(notShown).toBe(0)
    expect(pages).toHaveLength(1 + 3)
    expect(pages[0]?.title).toBe('Review summary')
    const text = (i: number) =>
      pages[i]?.ops.flatMap((o) => (o.t === 'text' ? [o.text] : [])).join('\n') as string
    expect(text(0)).toContain('Pitch wall')
    expect(text(0)).toContain('Round 2')
    expect(text(0)).toContain('1 Approved')
    expect(text(0)).toContain('1 Changes requested')
    expect(text(0)).toContain('1 Awaiting review')
    expect(text(0)).toContain('1. Key art A')
    expect(text(0)).toContain('Generated by Bob Stone on 2026-10-16')
    expect(text(0)).toContain(REVIEW_GUEST_FOOTNOTE)
    expect(pages[1]?.title).toBe('Key art A')
    expect(text(1)).toContain('Item 1 of 3')
    expect(text(1)).toContain('Approved')
    expect(text(1)).toContain('Ana (guest) · 2026-10-15')
    expect(text(1)).toContain('Version v3 of 3')
    expect(text(1)).toContain('Open comments (1)')
    expect(text(1)).toContain('Love the colour')
    expect(text(1)).toContain('Thanks!')
    expect(text(1)).toContain('2 resolved comments not printed.')
    // the picture is on the page, inside it
    const image = pages[1]?.ops.find((o) => o.t === 'image')
    expect(image).toMatchObject({ t: 'image' })
    if (image?.t === 'image') {
      expect(image.x).toBeGreaterThanOrEqual(SUMMARY_PAGE.margin)
      expect(image.x + image.w).toBeLessThanOrEqual(SUMMARY_PAGE.width - SUMMARY_PAGE.margin)
      expect(image.h).toBeLessThanOrEqual(380 * 1.5)
    }
    expect(text(2)).toContain('No open comments.')
    expect(text(3)).toContain('Awaiting review')
    // an item without a picture says so
    const bare = layoutSummary(model(), () => null, measure, { formatDate: fmt })
    expect(bare.pages[3]?.ops.some((o) => o.t === 'text' && o.text.includes('No preview'))).toBe(true)
  })

  it('every op stays on the page, and a page that names a guest ends with the footnote', () => {
    const { pages } = layoutSummary(model(), () => picture, measure, { formatDate: fmt })
    for (const p of pages) {
      for (const o of p.ops) {
        if (o.t === 'text') {
          expect(o.x).toBeGreaterThanOrEqual(SUMMARY_PAGE.margin)
          expect(o.y).toBeLessThanOrEqual(SUMMARY_PAGE.height)
        } else {
          expect(o.x).toBeGreaterThanOrEqual(0)
          expect(o.x + o.w).toBeLessThanOrEqual(SUMMARY_PAGE.width)
          expect(o.y + o.h).toBeLessThanOrEqual(SUMMARY_PAGE.height)
        }
      }
      const names = p.ops.some(
        (o) => o.t === 'text' && o.text.includes('(guest)') && o.text !== REVIEW_GUEST_FOOTNOTE,
      )
      const foot = p.ops.some((o) => o.t === 'text' && o.text === REVIEW_GUEST_FOOTNOTE)
      if (names) expect(foot).toBe(true)
    }
  })

  it('a long thread list runs onto a second page of the item, and past two pages it is counted, not lost silently', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      author: `Reviewer ${i}`,
      lines: [`Reviewer ${i}, 2026-10-11: ${'a long remark '.repeat(12)}`],
    }))
    const m: ReviewSummaryModel = {
      ...model(),
      items: [{ ...(model().items[1] as ReviewSummaryModel['items'][number]), threads: many }],
    }
    const { pages, cutThreads } = layoutSummary(m, () => picture, measure, { formatDate: fmt })
    const itemPages = pages.slice(1)
    expect(itemPages.length).toBe(REVIEW_SUMMARY.pagesPerItem)
    expect(itemPages[1]?.title).toBe('Key art B (continued)')
    expect(cutThreads).toBeGreaterThan(0)
    const last = itemPages[itemPages.length - 1]?.ops
      .flatMap((o) => (o.t === 'text' ? [o.text] : []))
      .join('\n')
    expect(last).toMatch(/\d+ more open comments? (is|are) not shown here/)
    // the first page holds the first comments in order
    const first = itemPages[0]?.ops.flatMap((o) => (o.t === 'text' ? [o.text] : [])).join('\n') as string
    expect(first.indexOf('Reviewer 0')).toBeGreaterThan(-1)
    expect(first.indexOf('Reviewer 1,')).toBeGreaterThan(first.indexOf('Reviewer 0'))
  })

  it('never passes the page limit: the items that do not fit are counted and the cover says so', () => {
    const one = model().items[2] as ReviewSummaryModel['items'][number]
    const m: ReviewSummaryModel = { ...model(), items: Array.from({ length: 75 }, () => one) }
    const { pages, notShown } = layoutSummary(m, () => null, measure, { formatDate: fmt })
    expect(pages.length).toBeLessThanOrEqual(REVIEW_SUMMARY.maxPages)
    expect(notShown).toBeGreaterThan(0)
    const cover = pages[0]?.ops.flatMap((o) => (o.t === 'text' ? [o.text] : [])).join('\n') as string
    // the contents list is long enough to need further cover pages: the note sits on the last of them
    const coverPages = pages.filter((p) => p.title.startsWith('Review summary'))
    const lastCover = coverPages[coverPages.length - 1]?.ops
      .flatMap((o) => (o.t === 'text' ? [o.text] : []))
      .join('\n')
    expect(lastCover).toMatch(new RegExp(`${notShown} more items? (is|are) not printed`))
    expect(cover).toContain('1. Teaser')
  })
})

describe('the summary page as an SVG for the vector path', () => {
  it('escapes text and reads back with no problems', () => {
    expect(xmlText('A & B <c> "d"\u0000')).toBe('A &amp; B &lt;c&gt; &quot;d&quot;')
    const m = model()
    const first = m.items[0] as ReviewSummaryModel['items'][number]
    const risky: ReviewSummaryModel = { ...m, items: [{ ...first, label: 'Cut <2> & "final"' }] }
    const { pages } = layoutSummary(risky, () => picture, measure, { formatDate: fmt })
    for (const page of pages) {
      const scene = readScene(pageToSvg(page))
      expect(scene.problems).toEqual([])
      expect(scene.viewBox).toMatchObject({ width: SUMMARY_PAGE.width, height: SUMMARY_PAGE.height })
    }
    const text = readScene(pageToSvg(pages[1] as never))
      .leaves.filter((l) => l.el.name === 'text')
      .map((l) => l.el.children.join(''))
    expect(text.some((t) => t.includes('Cut <2> & "final"'))).toBe(true)
  })
})

async function inflate(bytes: Uint8Array): Promise<string> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'))
  return new Response(stream).text()
}

describe('the summary PDF', () => {
  it('is made of vector pages: real text for every status, name and comment, the picture an image object, one bookmark per page', async () => {
    const { pages } = layoutSummary(model(), () => picture, measure, { formatDate: fmt })
    const b = await createPdfBuilder({
      title: 'Pitch wall - Review summary',
      vector: { deps: { fetchFace: async () => null } },
    })
    for (const page of pages) {
      const out = await b.addVectorPage({
        title: page.title,
        widthPx: page.width,
        heightPx: page.height,
        svg: pageToSvg(page),
      })
      expect(out, page.title).toEqual({ vector: true })
    }
    const bytes = await b.finish()
    const doc = await PDFDocument.load(bytes)
    expect(doc.getPageCount()).toBe(pages.length)
    let content = ''
    let images = 0
    for (const page of doc.getPages()) {
      const c = page.node.Contents()
      const streams = c instanceof PDFStream ? [c] : c ? c.asArray().map((r) => doc.context.lookup(r)) : []
      for (const s of streams)
        if (s instanceof PDFRawStream)
          content += `${await inflate(s.contents).catch(() => new TextDecoder().decode(s.contents))}\n`
      const xo = page.node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict)
      for (const [, ref] of xo?.entries() ?? []) {
        const x = doc.context.lookup(ref)
        if (x instanceof PDFRawStream && x.dict.get(PDFName.of('Subtype')) === PDFName.of('Image')) images++
      }
    }
    const hex = (s: string) =>
      [...s].map((ch) => ch.charCodeAt(0).toString(16).padStart(2, '0').toUpperCase()).join('')
    for (const word of ['Approved', 'Changes requested', 'Awaiting review', 'Love the colour', 'Round 2'])
      expect(content, word).toContain(hex(word))
    expect(content).not.toContain('3 Tr') // not the invisible layer of image pages
    expect(images).toBeGreaterThan(0)
    // every name that appears in the summary is in the text layer
    expect(content).toContain(hex('Ana (guest)'))
    expect(content).toContain(hex('Carol'))
    const outlines = doc.catalog.lookup(PDFName.of('Outlines'))
    expect(outlines).toBeTruthy()
  })
})
