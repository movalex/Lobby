// WS3 (wave S): "Export comments": the comments CSV (escaped against spreadsheet formula injection), the Premiere-style
// marker list and the CMX3600 EDL, as golden files.
import type { CommentThread } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import {
  authorLabel,
  COMMENTS_CSV_HEADER,
  commentsCsv,
  commentsEdl,
  csvCell,
  cutText,
  EXPORT_TEXT_CHARS,
  exportFile,
  exportStem,
  markersCsv,
  oneLine,
} from './exports.ts'

const AST = 'ast_0123456789ab'
const V1 = 'ver_0123456789ab'
const ana = { id: 'usr_ana0000000', name: 'Ana (guest)', color: '#336699' }
const ben = { id: 'usr_ben0000000', name: 'Ben Client', color: '#993366', external: true }

function thread(
  id: string,
  at: { timeMs?: number; page?: number },
  bodies: [typeof ana, string][],
  over: Partial<CommentThread> = {},
): CommentThread {
  return {
    id,
    boardId: 'b1',
    anchor: { kind: 'asset', shapeId: 'shape:card', assetId: AST, versionId: V1, ...at },
    status: 'open',
    createdBy: bodies[0]?.[0] ?? ana,
    createdAt: '2026-10-16T10:00:00.000Z',
    updatedAt: '2026-10-16T10:00:00.000Z',
    resolvedBy: null,
    resolvedAt: null,
    visibility: 'everyone',
    comments: bodies.map(([author, body], i) => ({
      id: `cmt_${id}${i}`,
      threadId: id,
      author,
      body,
      mentions: [],
      createdAt: `2026-10-16T10:0${i}:00.000Z`,
      editedAt: null,
    })),
    ...over,
  } as CommentThread
}

describe('csv cells', () => {
  it('neutralises formulas and quotes what must be quoted', () => {
    expect(csvCell('=HYPERLINK("http://x","click")')).toBe('"\'=HYPERLINK(""http://x"",""click"")"')
    expect(csvCell('+1')).toBe("'+1")
    expect(csvCell('-2+3')).toBe("'-2+3")
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)")
    expect(csvCell('\t=1')).toBe("'\t=1")
    expect(csvCell('\r=1')).toBe('"\'\r=1"')
    expect(csvCell('a, b')).toBe('"a, b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('fine')).toBe('fine')
    expect(csvCell('a=b')).toBe('a=b')
    expect(csvCell(3)).toBe('3')
    expect(csvCell(null)).toBe('')
  })

  it('one line, cut to 120 characters, authors labelled', () => {
    expect(oneLine(' a\n\nb​‮ c ')).toBe('a b c')
    expect(cutText('x'.repeat(200))).toHaveLength(EXPORT_TEXT_CHARS)
    expect(cutText('x'.repeat(200)).endsWith('…')).toBe(true)
    expect(cutText('short')).toBe('short')
    expect(authorLabel(ana)).toBe('Ana (guest)')
    expect(authorLabel(ben)).toBe('Ben Client · External')
  })
})

const threads = [
  {
    thread: thread('thr_b', { timeMs: 12_400 }, [
      [ana, 'Logo bigger, please'],
      [ben, '=cmd|"/c calc"!A1'],
    ]),
    versionLabel: 'v2',
  },
  {
    thread: thread('thr_a', { timeMs: 1_000 }, [[ben, 'Line one\nline two @[Ana (guest)](usr_ana0000000)']]),
    versionLabel: 'v2',
  },
  {
    thread: thread('thr_p', { page: 3 }, [[ana, 'On the page']], {
      status: 'resolved',
      spot: { u: 0.25, v: 0.5 },
    }),
    versionLabel: 'v1',
  },
]

describe('the comments CSV', () => {
  it('one row per comment, every cell escaped (golden)', () => {
    const csv = commentsCsv(threads, 25)
    expect(csv.startsWith('﻿')).toBe(true)
    expect(csv.slice(1).split('\r\n')).toEqual([
      COMMENTS_CSV_HEADER.join(','),
      '1,v2,00:00:12:10,,,Ana (guest),Open,"Logo bigger, please",2026-10-16T10:00:00.000Z',
      '1,v2,00:00:12:10,,,Ben Client · External,Open,"\'=cmd|""/c calc""!A1",2026-10-16T10:01:00.000Z',
      '2,v2,00:00:01:00,,,Ben Client · External,Open,Line one line two @Ana (guest),2026-10-16T10:00:00.000Z',
      '3,v1,,3,"25%, 50%",Ana (guest),Resolved,On the page,2026-10-16T10:00:00.000Z',
      '',
    ])
    // no rate known: the clock
    expect(commentsCsv(threads, null)).toContain(',00:12.4,')
  })
})

describe('the marker list and the EDL', () => {
  it('a Premiere-style marker per timed thread, earliest first (golden)', () => {
    expect(markersCsv(threads, 25).slice(1).split('\r\n')).toEqual([
      'Marker Name,Description,In,Out,Duration,Marker Type',
      'Ben Client · External,Line one line two @Ana (guest),00:00:01:00,00:00:01:00,00:00:00:00,Comment',
      'Ana (guest),"Logo bigger, please (+1 reply)",00:00:12:10,00:00:12:10,00:00:00:00,Comment',
      '',
    ])
  })

  it('a CMX3600 EDL with one-frame events and locators (golden)', () => {
    const edl = commentsEdl(threads, { title: 'Trailer\nv2', clipName: 'trailer.mp4', fps: 25 })
    expect(edl.split('\r\n')).toEqual([
      'TITLE: Trailer v2',
      'FCM: NON-DROP FRAME',
      '',
      '001  AX       V     C        00:00:01:00 00:00:01:01 00:00:01:00 00:00:01:01',
      '* FROM CLIP NAME: trailer.mp4',
      '* LOC: 00:00:01:00 YELLOW  Ben Client · External: Line one line two @Ana (guest)',
      '',
      '002  AX       V     C        00:00:12:10 00:00:12:11 00:00:12:10 00:00:12:11',
      '* FROM CLIP NAME: trailer.mp4',
      '* LOC: 00:00:12:10 YELLOW  Ana (guest): Logo bigger, please (+1 reply)',
      '',
    ])
    // long comments are cut to one line of 120 characters
    const long = commentsEdl(
      [{ thread: thread('thr_l', { timeMs: 0 }, [[ana, 'word '.repeat(80)]]), versionLabel: 'v1' }],
      {
        title: 'T',
        clipName: 'c',
        fps: null,
      },
    )
    const loc = long.split('\r\n').find((l) => l.startsWith('* LOC:')) ?? ''
    expect(loc.length).toBeLessThanOrEqual('* LOC: 00:00:00:00 YELLOW  '.length + EXPORT_TEXT_CHARS)
  })

  it('file names from the file’s own name', () => {
    expect(exportStem('Trailer v2 (final).mp4')).toBe('Trailer v2 (final)')
    expect(exportStem('a/b:c*.pdf')).toBe('a_b_c_')
    expect(exportStem('...')).toBe('file')
    expect(exportFile('csv', 'cut.mp4')).toEqual({
      name: 'cut - comments.csv',
      type: 'text/csv;charset=utf-8',
    })
    expect(exportFile('markers', 'cut.mp4').name).toBe('cut - markers.csv')
    expect(exportFile('edl', 'cut.mp4')).toEqual({ name: 'cut.edl', type: 'text/plain;charset=utf-8' })
  })
})
