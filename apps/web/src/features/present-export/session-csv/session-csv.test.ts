// Wave V (WS5): the Export dialog's "Session results (CSV)" (./csv.ts, ./Section.tsx).
//  - Formula-safe: no cell a spreadsheet reads starts with = + - @ (or a fullwidth form), a tab or a CR, after
//    unquoting; such text keeps its words behind a leading apostrophe.
//  - One row per option, value or word of a revealed activity (ranks, counts, shares; a scale's mean and median),
//    one row for an activity whose results are not out; oldest first; counts only, never a person.
//  - The section is offered only with the summary's switch and the api's activities switch on; it downloads through
//    ../download.ts, and with no activity it downloads nothing.
import { type ActivitySummary, ListActivitiesResponse } from '@draftroom/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CanvasFeatureContext, LobbyCanvas } from '../../../canvas/api/index.ts'
import { setAiCtx } from '../../ai/ported/runtime.ts'
// registers the section with the recap it belongs to
import '../../ai/recap/recap.ts'
import { LIVE_FLAG_KEYS, setLiveSwitches } from '../../live/index.ts'
import { exportSectionsFor } from '../ported/export-sections.ts'
import { numberCell, SESSION_CSV_HEADER, sessionCsv, sessionCsvRows } from './csv.ts'
import { downloadSessionCsv, SESSION_CSV_SECTION, sessionCsvOffered } from './Section.tsx'

const downloads = vi.hoisted(() => [] as { blob: Blob; name: string }[])
vi.mock('../download.ts', () => ({
  downloadBlob: (blob: Blob, name: string) => void downloads.push({ blob, name }),
}))

/** What a spreadsheet would evaluate: = + - @ (or a fullwidth form), also after spaces, or a leading tab or CR. */
const FORMULA = /^(?:[\t\r]|\s*[=+\-@＝＋－＠])/u
const NOW = Date.UTC(2026, 9, 18, 15, 0, 0)
const iso = (min: number) => new Date(NOW - min * 60_000).toISOString()
const base = (n: number, over: Record<string, unknown> = {}) => ({
  id: `act_000000000${n}`,
  boardId: 'b1',
  anonymous: true,
  resultsLive: false,
  status: 'revealed',
  createdBy: 'usr_facilitator01',
  createdAt: iso(60 - n),
  endsAt: null,
  closedAt: iso(50 - n),
  revealedAt: iso(50 - n),
  placedAt: null,
  ...over,
})

/**
 * As the api lists them (newest first). Not parsed: the CSV must be safe whatever text reaches it (the api's own rules
 * would already fold a tab or a CR in an option into a space).
 */
const LIST = [
  {
    activity: {
      ...base(5, { status: 'cancelled', revealedAt: null }),
      kind: 'poll',
      prompt: 'Dropped?',
      config: { options: ['a', 'b'] },
    },
    answered: 2,
    results: null,
  },
  {
    activity: {
      ...base(4, { status: 'open', closedAt: null, revealedAt: null, endsAt: iso(1) }),
      kind: 'words',
      prompt: 'Still open?',
      config: { maxWords: 3 },
    },
    answered: 3,
    results: null,
  },
  {
    activity: { ...base(3), kind: 'words', prompt: '@here one word', config: { maxWords: 3 } },
    answered: 4,
    results: {
      kind: 'words',
      answered: 4,
      words: [
        { text: '=cmd|calc', count: 3 },
        { text: 'bold', count: 3 },
        { text: 'warm, "cosy"', count: 1 },
      ],
      distinct: 3,
      hidden: 1,
    },
  },
  {
    activity: {
      ...base(2, { anonymous: false }),
      kind: 'scale',
      prompt: 'How ready are we?',
      config: { min: 1, max: 5, minLabel: '-not at all', maxLabel: 'Fully' },
    },
    answered: 4,
    results: { kind: 'scale', answered: 4, counts: [0, 1, 1, 0, 2], mean: 3.75, median: 4 },
  },
  {
    activity: {
      ...base(1),
      kind: 'poll',
      prompt: '=HYPERLINK("http://evil.example","Which city?")',
      config: {
        options: ['+Lisbon', '-Oslo', '\tTab', '\rReturn', '  =Spaced', '＝Fullwidth', 'Plain'],
        maxChoices: 2,
      },
    },
    answered: 10,
    results: { kind: 'poll', answered: 10, counts: [6, 6, 0, 1, 2, 3, 0] },
  },
] as unknown as ActivitySummary[]

/** A tiny RFC 4180 reader (quoted fields, doubled quotes, CRLF records): what a spreadsheet sees. */
function readCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"'
        i++
      } else if (c === '"') quoted = false
      else cell += c
    } else if (c === '"') quoted = true
    else if (c === ',') {
      row.push(cell)
      cell = ''
    } else if (c === '\r' && text[i + 1] === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
      i++
    } else cell += c
  }
  if (cell || row.length) rows.push([...row, cell])
  return rows
}

afterEach(() => {
  vi.unstubAllGlobals()
  setLiveSwitches(null)
  downloads.splice(0)
})

describe('the session CSV is formula-safe', () => {
  it('no cell starts with = + - @, a fullwidth form of them, a tab or a CR; the words stay behind an apostrophe', () => {
    const cells = readCsv(sessionCsv(LIST, NOW)).flat()
    for (const c of cells) expect(c, JSON.stringify(c)).not.toMatch(FORMULA)
    expect(cells).toContain(`'=HYPERLINK("http://evil.example","Which city?")`)
    for (const w of [
      '+Lisbon',
      '-Oslo',
      '\tTab',
      '\rReturn',
      '  =Spaced',
      '＝Fullwidth',
      '=cmd|calc',
      '@here one word',
    ])
      expect(cells, JSON.stringify(w)).toContain(`'${w.replace(/\r/g, '\n')}`)
    expect(cells).toContain('Plain')
    // quoting: a comma or a quote in a word is one cell
    expect(cells).toContain('warm, "cosy"')
  })

  it('numbers are written, never text: no -0, NaN or Infinity', () => {
    expect(numberCell(-0)).toBe('0')
    expect(numberCell(3.756)).toBe('3.76')
    expect(numberCell(Number.NaN)).toBe('')
    expect(numberCell(Number.POSITIVE_INFINITY)).toBe('')
    expect(numberCell(null)).toBe('')
  })
})

describe('the session CSV rows', () => {
  const rows = () => readCsv(sessionCsv(LIST, NOW))
  const of = (n: string) => rows().filter((r) => r[0] === n)

  it('has the header, CRLF records ending with CRLF, and the activities oldest first', () => {
    const text = sessionCsv(LIST, NOW)
    expect(text.endsWith('\r\n')).toBe(true)
    expect(rows()[0]).toEqual([...SESSION_CSV_HEADER])
    const order = [
      ...new Set(
        rows()
          .slice(1)
          .map((r) => `${r[0]} ${r[2]}`),
      ),
    ]
    expect(order.map((o) => o.split(' ')[0])).toEqual(['1', '2', '3', '4', '5'])
    expect(order[4]).toBe('5 Dropped?')
    for (const r of rows()) expect(r).toHaveLength(SESSION_CSV_HEADER.length)
  })

  it('a poll: one row per option by rank (ties share it), its count and share of the people who answered', () => {
    const poll = of('1')
    expect(poll.map((r) => [r[7], r[8], r[9], r[10]])).toEqual([
      ['1', "'+Lisbon", '6', '60'],
      ['1', "'-Oslo", '6', '60'],
      ['3', "'＝Fullwidth", '3', '30'],
      ['4', "'  =Spaced", '2', '20'],
      ['5', "'\nReturn", '1', '10'],
      ['6', "'\tTab", '0', '0'],
      ['6', 'Plain', '0', '0'],
    ])
    expect(poll[0]?.slice(1, 7)).toEqual([
      'Poll',
      `'=HYPERLINK("http://evil.example","Which city?")`,
      'Revealed',
      iso(59),
      'yes',
      '10',
    ])
  })

  it('a scale: one row per value with its end labels, and the mean and median', () => {
    expect(of('2').map((r) => [r[5], r[8], r[9], r[10], r[11], r[12]])).toEqual([
      ['no', '1 (-not at all)', '0', '0', '3.75', '4'],
      ['no', '2', '1', '25', '3.75', '4'],
      ['no', '3', '1', '25', '3.75', '4'],
      ['no', '4', '0', '0', '3.75', '4'],
      ['no', '5 (Fully)', '2', '50', '3.75', '4'],
    ])
  })

  it('a word cloud: one row per word by rank; open, closed (past its end) and cancelled ones say their results are not out', () => {
    expect(of('3').map((r) => [r[7], r[8], r[9]])).toEqual([
      ['1', "'=cmd|calc", '3'],
      ['1', 'bold', '3'],
      ['3', 'warm, "cosy"', '1'],
    ])
    // open, but past its end time: closed, as the api reports it
    expect(of('4').map((r) => [r[3], r[6], r[8], r[9]])).toEqual([['Closed', '3', 'Not revealed', '']])
    expect(of('5').map((r) => [r[3], r[8]])).toEqual([['Cancelled', 'Cancelled']])
    expect(sessionCsvRows([], NOW)).toEqual([])
  })

  it('counts only: no account id, not even the facilitator who started them', () => {
    expect(sessionCsv(LIST, NOW)).not.toMatch(/usr_/)
  })
})

describe('the Export dialog section', () => {
  const canvas = {} as LobbyCanvas
  const ctxWith = (activities: unknown[]) => {
    const request = vi.fn(async (_m: string, _p: string, o: { schema: { parse(v: unknown): unknown } }) =>
      o.schema.parse({ activities }),
    )
    return {
      request,
      ctx: {
        canvas,
        board: { id: 'b1', title: 'Launch' },
        api: { request },
      } as unknown as CanvasFeatureContext,
    }
  }
  const flags = (summary: boolean) =>
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (k === LIVE_FLAG_KEYS.summary ? (summary ? '1' : '0') : null),
    })

  it('is offered only with the summary switch AND the api running live activities', () => {
    const { ctx } = ctxWith([])
    setAiCtx(ctx)
    flags(false)
    setLiveSwitches({ activities: true })
    expect(sessionCsvOffered(canvas)).toBe(false)
    expect(exportSectionsFor(canvas).map((s) => s.id)).not.toContain('session-csv')
    flags(true)
    setLiveSwitches({ activities: false })
    expect(sessionCsvOffered(canvas)).toBe(false)
    setLiveSwitches({ activities: true })
    expect(sessionCsvOffered(canvas)).toBe(true)
    expect(SESSION_CSV_SECTION.id).toBe('session-csv')
    // registered with the recap (../../ai/recap/recap.ts): the dialog lists it while offered
    expect(exportSectionsFor(canvas).map((s) => s.id)).toContain('session-csv')
  })

  it('downloads "<board> - Session results.csv" from the activities route, with a byte-order mark', async () => {
    // what the route's own schema makes of them (the client parses every answer)
    const parsed = ListActivitiesResponse.parse({ activities: LIST }).activities
    const { ctx, request } = ctxWith(parsed)
    const said = await downloadSessionCsv(ctx, 'Launch', undefined, NOW)
    expect(request).toHaveBeenCalledWith('GET', '/api/boards/b1/activities', expect.anything())
    expect(said).toBe('Downloaded “Launch - Session results.csv” (5 activities).')
    expect(downloads).toHaveLength(1)
    expect(downloads[0]?.name).toBe('Launch - Session results.csv')
    const bytes = new Uint8Array((await downloads[0]?.blob.arrayBuffer()) ?? new ArrayBuffer(0))
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    const text = new TextDecoder().decode(bytes.slice(3))
    expect(text).toBe(sessionCsv(parsed, NOW))
    for (const c of readCsv(text).flat()) expect(c).not.toMatch(FORMULA)
  })

  it('with no activity it downloads nothing and says so', async () => {
    const { ctx } = ctxWith([])
    expect(await downloadSessionCsv(ctx, 'Launch', undefined, NOW)).toMatch(/nothing to export/)
    expect(downloads).toEqual([])
  })
})
