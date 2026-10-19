// Wave V (V2, WS3): the join card's QR (golden matrices of the pinned qrcode-generator 2.0.4 at level M, drawn as one
// inline SVG path on a white quiet zone of 4, never a data:/blob: URL or an external reference), what the card shows,
// which link the Facilitate menu's card picks, the code field, and when each offer shows.
import type { PendingInvitation } from '@draftroom/contracts'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import type { CanvasFeatureContext } from '../../canvas/api/index.ts'
import { LIVE_FLAG_KEYS, setLiveSwitches } from '../live/index.ts'
import { feature, joinCodeEntryShown } from './index.tsx'
import { HaveACode, JoinCodeField } from './JoinField.tsx'
import JoinPage, { invitePathOf } from './JoinPage.tsx'
import { expiresLabel, hostOf, joinPathOf, joinTarget, workshopLinksToShow } from './model.ts'
import { JoinCard, QrSvg } from './QrCard.tsx'
import { QR_QUIET_ZONE, qrMatrix, qrPath, qrSide, qrVersion } from './qr.ts'
import { ShowQrRow } from './ShowQr.tsx'

const rows = (m: boolean[][]) => m.map((r) => r.map((d) => (d ? '#' : '.')).join(''))

// Golden matrices (qrcode-generator 2.0.4, level M, byte mode): a library change that moves a module fails here.
const LOBBY_M = [
  '#######..##.#.#######',
  '#.....#.#####.#.....#',
  '#.###.#..##...#.###.#',
  '#.###.#..##...#.###.#',
  '#.###.#.##..#.#.###.#',
  '#.....#...#.#.#.....#',
  '#######.#.#.#.#######',
  '...........##........',
  '#.#.#.#....#....#..#.',
  '.##.##..#.#...#...##.',
  '.....###..#.#...##.##',
  '#.##....##....#....#.',
  '.##.####.#..#.#.#.##.',
  '........#..#.#.#.#.#.',
  '#######....#.###...##',
  '#.....#..#.###.##....',
  '#.###.#.#.##.###..###',
  '#.###.#..##...##.#.#.',
  '#.###.#.#.#.#...#...#',
  '#.....#...#...#....#.',
  '#######.##..#.#..####',
]
const JOIN_URL = 'https://lobby.example/j/ABCD2345'
const JOIN_URL_M = [
  '#######.###..###.####.#######',
  '#.....#.###..#..#.....#.....#',
  '#.###.#...###...#...#.#.###.#',
  '#.###.#.#.#.#.##.###..#.###.#',
  '#.###.#...###.#.#..##.#.###.#',
  '#.....#..#.#.#.######.#.....#',
  '#######.#.#.#.#.#.#.#.#######',
  '........##..#..####..........',
  '#.##.###.....#.#..##..#..#.##',
  '.#..##.#..#..###..###.###...#',
  '..#####..#..##..##..#.###.##.',
  '.#.##..#.#..#...#.#####.....#',
  '#.....##.#.#..##...#.#...##..',
  '#....#....#...#.##.#..#...###',
  '#.#...#.#....#.###.#.#..#.###',
  '####.#..#...#.#.#.#..##.#..#.',
  '#....########.##.##..#.###.#.',
  '..#.....##..#.#.#...#..#.###.',
  '#..#.#####...######.#..#..#..',
  '..#.#......#.##.###..#..#.#..',
  '.######....#.##...#.#######..',
  '........#.#.#.....#.#...#####',
  '#######.###...#..####.#.##.#.',
  '#.....#.#..#.##.....#...##..#',
  '#.###.#..#..#..####.#####.##.',
  '#.###.#.###..#.#.#####.###..#',
  '#.###.#.#.##..#..#.#.#.#..#.#',
  '#.....#...#.......#.###.##.#.',
  '#######.###.###.#..##...#..#.',
]

/** The 7×7 finder pattern every QR has at three corners (the structure, whatever the library). */
function finderAt(m: boolean[][], top: number, left: number): boolean {
  for (let r = 0; r < 7; r++)
    for (let c = 0; c < 7; c++) {
      const ring = r === 0 || r === 6 || c === 0 || c === 6
      const core = r >= 2 && r <= 4 && c >= 2 && c <= 4
      if (m[top + r]?.[left + c] !== (ring || core)) return false
    }
  return true
}

describe('qrMatrix (qr.ts)', () => {
  it('matches the golden matrices at level M', () => {
    expect(rows(qrMatrix('LOBBY'))).toEqual(LOBBY_M)
    expect(rows(qrMatrix(JOIN_URL, 'M'))).toEqual(JOIN_URL_M)
  })

  it('a join URL is a small code (version 3 here, 4 for a longer host); a full invite URL a larger one', () => {
    expect(qrVersion(qrMatrix(JOIN_URL))).toBe(3)
    expect(qrVersion(qrMatrix('https://draftroom-web.onrender.com/j/7K3MQ9XP'))).toBe(4)
    expect(qrVersion(qrMatrix(`http://127.0.0.1:5173/invite/${'a'.repeat(43)}`))).toBe(5)
  })

  it('has the finder patterns at three corners and the timing pattern between them', () => {
    for (const text of ['LOBBY', JOIN_URL, `https://x.example/invite/${'b'.repeat(43)}`]) {
      const m = qrMatrix(text)
      const n = m.length
      expect(m.every((r) => r.length === n)).toBe(true)
      expect(finderAt(m, 0, 0)).toBe(true)
      expect(finderAt(m, 0, n - 7)).toBe(true)
      expect(finderAt(m, n - 7, 0)).toBe(true)
      for (let i = 8; i < n - 8; i++) {
        expect(m[6]?.[i]).toBe(i % 2 === 0)
        expect(m[i]?.[6]).toBe(i % 2 === 0)
      }
    }
  })

  it('encodes text outside ASCII once, as UTF-8; refuses empty and oversized text', () => {
    expect(rows(qrMatrix('https://lobby.example/j/É'))).not.toEqual(
      rows(qrMatrix('https://lobby.example/j/E')),
    )
    expect(() => qrMatrix('')).toThrow()
    expect(() => qrMatrix('x'.repeat(513))).toThrow()
  })

  it('qrPath draws each run of dark modules as one rectangle, shifted by the quiet zone', () => {
    const m = [
      [true, true, false],
      [false, true, true],
    ]
    expect(qrPath(m)).toBe('M4 4h2v1h-2zM5 5h2v1h-2z')
    expect(qrPath(m, 0)).toBe('M0 0h2v1h-2zM1 1h2v1h-2z')
    expect(qrSide(m)).toBe(m.length + 2 * QR_QUIET_ZONE)
  })
})

describe('the QR svg and the join card', () => {
  it('is one inline svg: a white square and one black path; no data:, blob:, href, image, canvas or script', () => {
    const html = renderToStaticMarkup(createElement(QrSvg, { text: JOIN_URL, label: 'QR code to join' }))
    expect(html.startsWith('<svg')).toBe(true)
    expect(html).toContain(`data-join-url="${JOIN_URL}"`)
    expect(html).toContain('viewBox="0 0 37 37"') // 29 modules + 2 × 4
    expect(html).toContain('<rect width="37" height="37" fill="#ffffff"></rect>')
    expect(html.match(/<path /g)).toHaveLength(1)
    expect(html).toContain('fill="#000000"')
    expect(html).toContain('role="img"')
    expect(html).toContain('aria-label="QR code to join"')
    const withoutUrl = html
      .replace(`data-join-url="${JOIN_URL}"`, '')
      .replace('http://www.w3.org/2000/svg', '')
    for (const banned of ['data:', 'blob:', 'href', '<image', '<canvas', '<script', 'url(', 'http'])
      expect(withoutUrl, banned).not.toContain(banned)
  })

  it('the card shows the QR of the code’s URL, the code in large type, where to type it and the expiry', () => {
    const at = new Date(Date.now() + 2 * 60 * 60_000).toISOString()
    const target = joinTarget(
      { url: 'https://lobby.example/invite/tok', expiresAt: at },
      { code: 'ABCD2345', display: 'ABCD-2345', joinUrl: JOIN_URL, expiresAt: at },
    )
    const html = renderToStaticMarkup(
      createElement(JoinCard, { target, title: 'Kickoff', onClose: () => {} }),
    )
    expect(html).toContain('data-testid="join-card"')
    expect(html).toContain(`data-join-url="${JOIN_URL}"`)
    expect(html).toContain('>ABCD-2345<')
    expect(html).toContain('<strong>lobby.example</strong>')
    expect(html).toContain('Kickoff')
    expect(html).toMatch(/data-testid="join-card-expiry">Expires /)
    // without a code: the full invite URL, no code line
    const noCode = renderToStaticMarkup(
      createElement(JoinCard, {
        target: joinTarget({ url: 'https://lobby.example/invite/tok', expiresAt: at }, null),
        title: 'Kickoff',
        note: 'Scan the QR to join.',
        onClose: () => {},
      }),
    )
    expect(noCode).toContain('data-join-url="https://lobby.example/invite/tok"')
    expect(noCode).not.toContain('join-card-code')
    expect(noCode).toContain('Scan the QR to join.')
  })
})

describe('the model', () => {
  const inv = (over: Partial<PendingInvitation>): PendingInvitation => ({
    id: 'inv_0123456789abcdefghij',
    kind: 'review',
    role: 'editor',
    createdAt: '2026-10-18T10:00:00.000Z',
    expiresAt: '2026-10-18T13:00:00.000Z',
    createdBy: { id: 'usr_a', name: 'A' },
    uses: 0,
    maxUses: null,
    url: 'https://lobby.example/invite/t',
    maxExpiresAt: null,
    allowGuests: true,
    email: null,
    ...over,
  })

  it('joinTarget: the code’s URL and display when there is one, else the full link', () => {
    const link = { url: 'https://lobby.example/invite/t', expiresAt: '2026-10-18T13:00:00.000Z' }
    expect(joinTarget(link, null)).toEqual({
      qrText: link.url,
      display: null,
      host: 'lobby.example',
      expiresAt: link.expiresAt,
    })
    const t = joinTarget(link, {
      code: 'ABCD2345',
      display: '',
      joinUrl: JOIN_URL,
      expiresAt: link.expiresAt,
    })
    expect(t).toMatchObject({ qrText: JOIN_URL, display: 'ABCD-2345', host: 'lobby.example' })
    expect(hostOf('not a url')).toBe('not a url')
    expect(hostOf('http://127.0.0.1:5173/j/X')).toBe('127.0.0.1:5173')
  })

  it('workshopLinksToShow: open editor links with a URL, newest first', () => {
    const now = Date.parse('2026-10-18T12:00:00.000Z')
    const list = [
      inv({ id: 'inv_old0000000000000000a', createdAt: '2026-10-18T09:00:00.000Z' }),
      inv({ id: 'inv_new0000000000000000a', createdAt: '2026-10-18T11:00:00.000Z' }),
      inv({ id: 'inv_review00000000000000', role: 'commenter' }),
      inv({ id: 'inv_nourl00000000000000a', url: null }),
      inv({ id: 'inv_expired0000000000000', expiresAt: '2026-10-18T11:59:00.000Z' }),
      inv({ id: 'inv_single0000000000000a', kind: 'invite' }),
    ]
    expect(workshopLinksToShow(list, now).map((l) => l.id)).toEqual([
      'inv_new0000000000000000a',
      'inv_old0000000000000000a',
    ])
  })

  it('expiresLabel: the time today, the weekday and time on another day, Expired once past', () => {
    const now = new Date(2026, 9, 18, 12, 0)
    expect(expiresLabel(new Date(2026, 9, 18, 14, 30).toISOString(), now, 'en-GB')).toBe('Expires 14:30')
    expect(expiresLabel(new Date(2026, 9, 19, 9, 0).toISOString(), now, 'en-GB')).toBe('Expires Mon 09:00')
    expect(expiresLabel(new Date(2026, 9, 18, 11, 0).toISOString(), now)).toBe('Expired')
    expect(expiresLabel('nonsense', now)).toBe('')
  })

  it('joinPathOf and invitePathOf: a typed code to /j/CODE (as the api reads it), a token to /invite/', () => {
    expect(joinPathOf('abcd-2345')).toBe('/j/ABCD2345')
    expect(joinPathOf(' ab cd 23 45 ')).toBe('/j/ABCD2345')
    expect(joinPathOf('ABCU-2345')).toBeNull()
    expect(joinPathOf('')).toBeNull()
    expect(invitePathOf('a-b_c')).toBe('/invite/a-b_c')
  })
})

describe('the offers', () => {
  const store = new Map<string, string>()
  const g = globalThis as { localStorage?: unknown }
  const had = g.localStorage
  afterEach(() => {
    store.clear()
    setLiveSwitches(null)
    g.localStorage = had
  })
  /** a dev-auth page with the web switch on (LIVE_FLAG_KEYS), and the api's as given */
  const on = (server: boolean) => {
    g.localStorage = { getItem: (k: string) => store.get(k) ?? null }
    store.set(LIVE_FLAG_KEYS.joinCodes, '1')
    setLiveSwitches({ joinCodes: server })
  }
  const ctx = (creator: boolean | undefined) =>
    ({
      me: creator === undefined ? {} : { access: { creator, reason: 'dev', email: null } },
    }) as unknown as CanvasFeatureContext

  it('"Show join code" shows to a creator facilitator with both switches on; never to a guest, a participant or a non-creator', () => {
    const input = { ctx: ctx(true), guest: false, facilitator: true }
    expect(joinCodeEntryShown(input)).toBe(false) // shipped off
    on(false)
    expect(joinCodeEntryShown(input)).toBe(false) // the api's switch off
    on(true)
    expect(joinCodeEntryShown(input)).toBe(true)
    expect(joinCodeEntryShown({ ...input, ctx: ctx(undefined) })).toBe(true) // an api before domain access
    expect(joinCodeEntryShown({ ...input, ctx: ctx(false) })).toBe(false)
    expect(joinCodeEntryShown({ ...input, guest: true })).toBe(false)
    expect(joinCodeEntryShown({ ...input, facilitator: false })).toBe(false)
  })

  it('the feature: one screen overlay for the card (shown while presenting too) and the entry registered on mount', () => {
    expect(feature.id).toBe('join')
    expect(feature.overlays?.map((o) => [o.id, o.layer, o.focusMode])).toEqual([
      ['join-card', 'screen', 'show'],
    ])
    const off = feature.onMount?.({} as CanvasFeatureContext)
    expect(typeof off).toBe('function')
    off?.()
  })

  it('"Have a code?" and the Share dialog’s Show QR row draw nothing while join codes are off', () => {
    const link = {
      id: 'inv_0123456789abcdefghij',
      kind: 'review',
      role: 'editor',
      createdAt: '2026-10-18T10:00:00.000Z',
      expiresAt: '2099-10-18T13:00:00.000Z',
      createdBy: { id: 'usr_a', name: 'A' },
      uses: 0,
      maxUses: null,
      url: 'https://lobby.example/invite/t',
      maxExpiresAt: null,
      allowGuests: true,
      email: null,
      joinCode: {
        code: 'ABCD2345',
        display: 'ABCD-2345',
        joinUrl: JOIN_URL,
        expiresAt: '2099-10-18T13:00:00.000Z',
      },
    } as PendingInvitation
    expect(renderToStaticMarkup(createElement(HaveACode))).toBe('')
    expect(renderToStaticMarkup(createElement(ShowQrRow, { boardId: 'b-abcdef', link }))).toBe('')
    on(true)
    expect(renderToStaticMarkup(createElement(HaveACode))).toContain('Have a code?')
    const row = renderToStaticMarkup(createElement(ShowQrRow, { boardId: 'b-abcdef', link }))
    expect(row).toContain('data-testid="workshop-link-show-qr"')
    expect(row).toContain('>ABCD-2345<')
    // a manager who is not shown the URL is not shown the QR either
    expect(
      renderToStaticMarkup(createElement(ShowQrRow, { boardId: 'b-abcdef', link: { ...link, url: null } })),
    ).toBe('')
  })

  it('the /j/ page: a malformed code says so with a field; a good one starts resolving', () => {
    const bad = renderToStaticMarkup(createElement(JoinPage, { code: 'ABCU-2345' }))
    expect(bad).toContain('data-reason="malformed"')
    expect(bad).toContain('data-testid="join-page-field"')
    expect(renderToStaticMarkup(createElement(JoinPage, { code: 'abcd-2345' }))).toContain(
      'data-testid="join-resolving"',
    )
    expect(renderToStaticMarkup(createElement(JoinCodeField, { label: 'Join code' }))).toContain(
      'placeholder="ABCD-2345"',
    )
  })
})
