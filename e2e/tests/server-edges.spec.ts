// Final-review fixes (key server-edges) that show in the browser:
//   R14: exports keep a revealed vote's results: the result badges are drawn into PNG / SVG / PDF (they
//     are an HTML overlay on the board, so tldraw's export alone left them out), the CSV gets a votes
//     column, and a sticky note's colour in the CSV is the palette's name (a default note is "Butter",
//     drawn yellow, never "black");
//   PL-V8: on a 390 px phone, app-wide notices sit below tldraw's top-left menu.
import type { BrowserContext, Page, TestInfo } from '@playwright/test'
import { signInContext } from './support/api.ts'
import { getShape, waitForBoard } from './support/board.ts'
import { downloadFrom, parseCsv, readPng, seedBoard } from './support/present-export.ts'
import { expect, test, type WorkshopSession, workshopState } from './support/workshops.ts'

const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }

const post = (s: WorkshopSession, path: string, body?: unknown) => s.api.fetch('POST', path, body ?? {})

async function ok(res: Promise<{ status(): number; text(): Promise<string> }>, status = 200) {
  const r = await res
  expect(r.status(), await r.text()).toBe(status)
}

async function shot(page: Page, name: string, testInfo: TestInfo) {
  await page.screenshot({ path: testInfo.outputPath(name) })
}

const FRAME = 'shape:r14-frame'
const SCOPE = 'shape:r14-scope'
const MEETINGS = 'shape:r14-meetings'
const QA = 'shape:r14-qa'

test('R14: a revealed vote’s results are in the PNG, SVG, PDF and CSV exports; the CSV names note colours as the palette does', async ({
  board,
  join,
}, testInfo) => {
  const a = await join('alice')
  const b = await join('bob', 'editor')
  await seedBoard(a.page, {
    frames: [{ id: FRAME, name: 'What to improve', x: 0, y: 0, w: 900, h: 420 }],
    notes: [
      { id: SCOPE, parentId: FRAME, x: 40, y: 80, text: 'Scope changed after planning', color: 'black' },
      { id: MEETINGS, parentId: FRAME, x: 320, y: 80, text: 'Too many meetings', color: 'black' },
      { id: QA, parentId: FRAME, x: 600, y: 80, text: 'Hand-off to QA was late', color: 'yellow' },
    ],
  })
  await expect.poll(() => getShape(b.page, QA)).not.toBeNull()

  const exportDialog = a.page.getByTestId('export-dialog')
  const openExport = async () => {
    await a.page.getByTestId('export-button').click()
    await expect(exportDialog).toBeVisible()
    await exportDialog.getByTestId('export-area-board').check()
  }
  const closeExport = async () => {
    await a.page.keyboard.press('Escape')
    await expect(exportDialog).toHaveCount(0)
  }

  await test.step('before any vote: the export has no badges and no votes column', async () => {
    await openExport()
    const svg = await downloadFrom(a.page, () => exportDialog.getByTestId('export-svg').click())
    expect(svg.bytes.toString('utf8')).not.toContain('data-dr-vote-results')
    const csv = await downloadFrom(a.page, () => exportDialog.getByTestId('export-csv').click())
    expect(parseCsv(csv.bytes.subarray(3).toString('utf8'))[0]).toEqual([
      'id',
      'type',
      'text',
      'frame',
      'color',
      'x',
      'y',
      'tags',
    ])
    await closeExport()
  })

  await test.step('a vote is run and revealed: the badges show on the board', async () => {
    await ok(
      post(a, `/api/boards/${board}/votes`, { votesPerPerson: 3, onePerObject: false, scope: 'board' }),
      201,
    )
    const sid = (await workshopState(a.api, board)).vote?.session.id ?? ''
    expect(sid).not.toBe('')
    for (const [s, shapeId] of [
      [b, SCOPE],
      [b, SCOPE],
      [a, SCOPE],
      [b, MEETINGS],
      [a, MEETINGS],
      [a, QA],
    ] as const)
      await ok(post(s, `/api/votes/${sid}/cast`, { shapeId, delta: 1 }))
    await ok(post(a, `/api/votes/${sid}/reveal`))
    await expect(a.page.locator(`[data-testid="vote-count"][data-shape-id="${SCOPE}"]`)).toHaveAttribute(
      'data-rank',
      '1',
    )
    await shot(a.page, 'r14-board-revealed.png', testInfo)
  })

  await test.step('SVG: one badge per voted note, on its corner, with the rank for the top 3', async () => {
    await openExport()
    const file = await downloadFrom(a.page, () => exportDialog.getByTestId('export-svg').click())
    const svg = file.bytes.toString('utf8')
    expect(svg).toContain('data-dr-vote-results')
    expect(svg).toContain('<title>3 votes, rank 1</title>')
    expect(svg).toContain('<title>2 votes, rank 2</title>')
    expect(svg).toContain('<title>1 vote, rank 3</title>')
    expect(svg.match(/data-dr-vote-badge="/g)).toHaveLength(3)
  })

  await test.step('PNG and PDF: made from the same SVG (the PNG is saved for a look)', async () => {
    const png = await downloadFrom(a.page, () => exportDialog.getByTestId('export-png').click())
    expect(readPng(png.bytes).width).toBeGreaterThan(0)
    const { writeFileSync } = await import('node:fs')
    writeFileSync(testInfo.outputPath('r14-export.png'), png.bytes)
    const pdf = await downloadFrom(a.page, () => exportDialog.getByTestId('export-pdf').click())
    expect(pdf.bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    writeFileSync(testInfo.outputPath('r14-export.pdf'), pdf.bytes)
  })

  await test.step('CSV: a votes column, and note colours as the palette names them', async () => {
    const file = await downloadFrom(a.page, () => exportDialog.getByTestId('export-csv').click())
    const rows = parseCsv(file.bytes.subarray(3).toString('utf8'))
    expect(rows[0]).toEqual(['id', 'type', 'text', 'frame', 'color', 'x', 'y', 'tags', 'votes'])
    const byId = new Map(rows.slice(1).map((r) => [r[0], r]))
    expect(byId.get(SCOPE)?.[4]).toBe('Butter')
    expect(byId.get(SCOPE)?.[8]).toBe('3')
    expect(byId.get(MEETINGS)?.[8]).toBe('2')
    expect(byId.get(QA)?.[4]).toBe('Marigold')
    expect(byId.get(QA)?.[8]).toBe('1')
    expect(byId.get(FRAME)?.[8]).toBe('')
    await closeExport()
  })

  await test.step('results hidden on this person’s board: the export leaves them out too', async () => {
    await a.page.getByTestId('dock-tab-voting').click()
    const panel = a.page.getByTestId('dock-panel-voting')
    await expect(panel).toBeVisible()
    await panel.getByTestId('vote-results-on-board').uncheck()
    await expect(a.page.getByTestId('vote-count')).toHaveCount(0)
    await openExport()
    const file = await downloadFrom(a.page, () => exportDialog.getByTestId('export-svg').click())
    expect(file.bytes.toString('utf8')).not.toContain('data-dr-vote-results')
    await closeExport()
  })
})

test('PL-V8: on a 390 px phone, an app-wide notice sits below tldraw’s top-left menu', async ({
  browser,
  board,
  join,
}, testInfo) => {
  const opened: BrowserContext[] = []
  try {
    const a = await join('alice')
    const b = await join('bob', 'editor')
    const context = await browser.newContext(PHONE)
    opened.push(context)
    await signInContext(context, 'alice', a.name)
    const phone = await context.newPage()
    await phone.goto(`/b/${board}`)
    await waitForBoard(phone)
    await expect(phone.getByTestId('timer-pill')).toHaveCount(1)

    // Bob raises a hand: the facilitator's phone shows "Bob … raised a hand." as an app-wide notice.
    await ok(post(b, `/api/boards/${board}/hand`, { raised: true }))
    const toast = phone.getByTestId('hand-toast')
    await expect(toast).toBeVisible()
    await shot(phone, 'pl-v8-phone-notice.png', testInfo)
    const notice = (await toast.boundingBox()) as { x: number; y: number; width: number; height: number }
    const menuBottom = await phone.evaluate(() => {
      let bottom = 0
      for (const el of document.querySelectorAll('.tlui-layout__top__left *')) {
        const r = el.getBoundingClientRect()
        if (r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden')
          bottom = Math.max(bottom, r.bottom)
      }
      return bottom
    })
    expect(menuBottom).toBeGreaterThan(0)
    expect(notice.y).toBeGreaterThanOrEqual(menuBottom)
    expect(notice.x).toBeGreaterThanOrEqual(0)
    expect(notice.x + notice.width).toBeLessThanOrEqual(PHONE.viewport.width)
    // Not squeezed into the right half of the screen (the region used to start at left: 50%).
    expect(notice.width).toBeGreaterThan(PHONE.viewport.width / 2)
  } finally {
    for (const c of opened) await c.close()
  }
})
