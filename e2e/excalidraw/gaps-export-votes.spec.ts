// GAP PASS (browser-test gaps on the Excalidraw canvas): a revealed vote's RESULTS in the exports (R14).
//
// WAVE-3.md §5 says the Export dialog is ported with "CSV with tags and votes", and the ported export has a
// badges part (features/present-export/ported/badges.ts: the overlay's result badges drawn into the SVG and
// onto bitmaps, as the tldraw page does since the final review's R14). No Excalidraw spec exports a board
// with a revealed vote: present-export-files never votes, workshops-voting only checks the CSV gate for a
// limited viewer. The tldraw suite's server-edges R14 is ported here on the workshops kit.
//
//   E2E_PORT_BASE=<base> pnpm --filter @draftroom/e2e excalidraw gaps-export-votes
import { writeFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { downloadFrom, parseCsv, readPng } from '../tests/support/present-export.ts'
import { workshopState } from '../tests/support/workshops.ts'
import { openBoardExport } from './present-kit.ts'
import {
  expect,
  expectItemsEverywhere,
  post,
  seed,
  test,
  type WorkshopCanvasSession,
} from './workshops-kit.ts'

const FRAME = 'r14-frame'
const SCOPE = 'r14-scope'
const MEETINGS = 'r14-meetings'
const QA = 'r14-qa'
const CSV_HEADER = ['id', 'type', 'text', 'frame', 'color', 'x', 'y', 'tags']

async function ok(res: Promise<{ status(): number; text(): Promise<string> }>, status = 200) {
  const r = await res
  expect(r.status(), await r.text()).toBe(status)
}

test('R14 on the new canvas: a revealed vote’s badges are in the SVG (and the PNG and PDF are made from it), the CSV gets a votes column, and hiding the results on my board hides them in my export', async ({
  join,
  board,
}, testInfo) => {
  const a = await join('alice')
  const b = await join('bob', 'editor')
  await seed(a.page, {
    frames: [{ id: FRAME, name: 'What to improve', x: 0, y: 0, w: 900, h: 420 }],
    notes: [
      { id: SCOPE, frameId: FRAME, x: 40, y: 80, text: 'Scope changed after planning' },
      { id: MEETINGS, frameId: FRAME, x: 320, y: 80, text: 'Too many meetings' },
      { id: QA, frameId: FRAME, x: 600, y: 80, text: 'Hand-off to QA was late' },
    ],
  })
  await expectItemsEverywhere([a, b], [FRAME, SCOPE, MEETINGS, QA])

  const dialog = a.page.getByTestId('export-dialog')
  const openExport = async (page: Page) => {
    await openBoardExport(page) // K3-3: Board menu ▸ Export ▸ Export…
    await expect(dialog).toBeVisible()
    await dialog.getByTestId('export-area-board').check()
  }
  const closeExport = async (page: Page) => {
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
  }
  const svgText = async () =>
    (await downloadFrom(a.page, () => dialog.getByTestId('export-svg').click())).bytes.toString('utf8')
  const csvRows = async () => {
    const file = await downloadFrom(a.page, () => dialog.getByTestId('export-csv').click())
    return parseCsv(file.bytes.subarray(3).toString('utf8'))
  }

  await test.step('before any vote: no badges in the SVG and no votes column', async () => {
    await openExport(a.page)
    expect(await svgText()).not.toContain('data-dr-vote-results')
    expect((await csvRows())[0]).toEqual(CSV_HEADER)
    await closeExport(a.page)
  })

  await test.step('a vote is run and revealed: the badges show on the board', async () => {
    await ok(
      post(a, `/api/boards/${board}/votes`, { votesPerPerson: 3, onePerObject: false, scope: 'board' }),
      201,
    )
    const sid = (await workshopState(a.api, board)).vote?.session.id ?? ''
    expect(sid).toMatch(/^vot_/)
    const casts: [WorkshopCanvasSession, string][] = [
      [b, SCOPE],
      [b, SCOPE],
      [a, SCOPE],
      [b, MEETINGS],
      [a, MEETINGS],
      [a, QA],
    ]
    for (const [s, id] of casts)
      await ok(post(s, `/api/votes/${sid}/cast`, { shapeId: `shape:${id}`, delta: 1 }))
    await ok(post(a, `/api/votes/${sid}/reveal`))
    await expect(a.page.locator(`[data-testid="vote-count"][data-shape-id$="${SCOPE}"]`)).toHaveAttribute(
      'data-rank',
      '1',
    )
    await expect(b.page.locator(`[data-testid="vote-count"][data-shape-id$="${SCOPE}"]`)).toHaveAttribute(
      'data-rank',
      '1',
    )
  })

  await test.step('SVG: one badge per voted note, with the rank for the top 3', async () => {
    await openExport(a.page)
    const svg = await svgText()
    expect(svg).toContain('data-dr-vote-results')
    expect(svg).toContain('<title>3 votes, rank 1</title>')
    expect(svg).toContain('<title>2 votes, rank 2</title>')
    expect(svg).toContain('<title>1 vote, rank 3</title>')
    expect(svg.match(/data-dr-vote-badge="/g)).toHaveLength(3)
  })

  await test.step('PNG and PDF are made (the PNG is kept for a look)', async () => {
    const png = await downloadFrom(a.page, () => dialog.getByTestId('export-png').click())
    expect(readPng(png.bytes).width).toBeGreaterThan(0)
    writeFileSync(testInfo.outputPath('gaps-r14-export.png'), png.bytes)
    const pdf = await downloadFrom(a.page, () => dialog.getByTestId('export-pdf').click())
    expect(pdf.bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-')
  })

  await test.step('CSV: a votes column with the counts; the frame has none', async () => {
    const rows = await csvRows()
    expect(rows[0]).toEqual([...CSV_HEADER, 'votes'])
    const byId = new Map(rows.slice(1).map((r) => [r[0], r]))
    expect(byId.get(SCOPE)?.[8]).toBe('3')
    expect(byId.get(MEETINGS)?.[8]).toBe('2')
    expect(byId.get(QA)?.[8]).toBe('1')
    expect(byId.get(FRAME)?.[8]).toBe('')
    await closeExport(a.page)
  })

  await test.step('results hidden on this person’s board: the export leaves them out too', async () => {
    const panel = a.page.getByTestId('dock-panel-voting')
    if (!(await panel.isVisible())) {
      const toggle = a.page.getByTestId('dock-rail-toggle')
      if (await toggle.isVisible()) await toggle.click()
      await a.page.getByTestId('dock-tab-voting').click()
    }
    await expect(panel).toBeVisible()
    await panel.getByTestId('vote-results-on-board').uncheck()
    await expect(a.page.getByTestId('vote-count')).toHaveCount(0)
    await openExport(a.page)
    expect(await svgText()).not.toContain('data-dr-vote-results')
    await closeExport(a.page)
    // bob still sees the results (the switch is per person)
    await expect(b.page.locator(`[data-testid="vote-count"][data-shape-id$="${SCOPE}"]`)).toHaveAttribute(
      'data-rank',
      '1',
    )
  })
})
