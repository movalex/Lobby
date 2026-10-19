// OWNER: WS5 (wave V, the session summary; docs/WAVE-V-CONTRACTS.md §5). The summary in a real browser, against the
// real api (every wave V switch on: e2e/tests/support/stack.ts) and sync; the summary's web switch is set the way a
// dev-auth page may (localStorage `lobby.liveSummary`, features/live/flags.ts).
//  1. The switch: off, Wrap up and the Export dialog are exactly as before wave V (no source section, no Session
//     results section); on, the dialog offers Session results. Runs on any branch.
//  2. The session (skipped, saying so, until WS1's activity routes have landed on the branch under test; the breakouts
//     part also needs WS4's): a poll and a word cloud whose words a spreadsheet would read as formulas, answered by two
//     people and revealed, and breakouts; then Wrap up with the AI call refused: the polls and scales, word clouds and
//     breakouts sections are there all the same, name nobody, and go into the Recap frame; the session results CSV is
//     a download (the download rule) whose cells never start a formula and which names nobody; nothing leaves
//     Lobby's origins (the e2e network assertion).
//
//   E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/v4-session-summary.spec.ts --project=chromium --workers=1
import type { Page } from '@playwright/test'
import {
  activitiesPath,
  activityActionPath,
  activityPath,
  breakoutActionPath,
  breakoutsPath,
} from '../../packages/contracts/src/index.ts'
import type { Api } from '../tests/support/api.ts'
import { expectSaved, items, saveState } from '../tests/support/canvas.ts'
import { collectDownloads, downloadFrom } from '../tests/support/present-export.ts'
import { aiRunRequests, foreignRequests } from './ai-kit.ts'
import { focusCanvas } from './navigation-kit.ts'
import { openBoardExport } from './present-kit.ts'
import { expect, reloadBoard, seed, test } from './workshops-kit.ts'

test.use({ viewport: { width: 1440, height: 900 } })

const SUMMARY_KEY = 'lobby.liveSummary'
/** Every wave V web switch (features/live/flags.ts LIVE_FLAG_KEYS), as the integration ships them on. */
const LIVE_FLAG_KEYS = ['lobby.liveActivities', 'lobby.liveJoinCodes', 'lobby.liveBreakouts', SUMMARY_KEY]
const setSummary = (page: Page, on: boolean) =>
  page.evaluate(([k, v]) => localStorage.setItem(k as string, v as string), [SUMMARY_KEY, on ? '1' : '0'])

/** What a spreadsheet would evaluate: = + - @ (or a fullwidth form), also after spaces, or a leading tab or CR. */
const FORMULA = /^(?:[\t\r]|\s*[=+\-@＝＋－＠])/u

/** A small RFC 4180 reader (quoted fields, doubled quotes, CRLF records). */
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

/** Ctrl+K, "Wrap up", the command: the recap panel, done. */
async function wrapUp(page: Page) {
  await focusCanvas(page)
  await page.keyboard.press('ControlOrMeta+k')
  await expect(page.getByTestId('command-palette')).toBeVisible()
  await page.getByTestId('command-palette-input').fill('Wrap up')
  await page.locator('[data-testid="command-palette-option"][data-entry-id="cmd:ai.recap"]').click()
  const cont = page.getByTestId('ai-notice-continue')
  const done = page.locator('[data-testid="recap-panel"][data-status="done"]')
  await expect(cont.or(done).first()).toBeVisible({ timeout: 20_000 })
  if (await cont.isVisible()) await cont.click()
  await expect(done).toBeVisible({ timeout: 20_000 })
  return done
}

async function closeRecap(page: Page) {
  await page.getByTestId('recap-panel').getByRole('button', { name: 'Close recap' }).click()
  await expect(page.getByTestId('recap-panel')).toHaveCount(0)
}

const json = async <T>(r: Awaited<ReturnType<Api['fetch']>>, want: number): Promise<T> => {
  expect(r.status(), await r.text()).toBe(want)
  return (await r.json()) as T
}

test('v4: the summary switch off leaves Wrap up and the Export dialog as before wave V; on, the dialog offers Session results', async ({
  join,
}) => {
  const a = await join('alice')
  const foreign = foreignRequests(a.page)
  await seed(a.page, { notes: [{ id: 'v4-n1', x: 0, y: 0, text: 'An idea' }] })

  await test.step('off: no source section in Wrap up, no Session results in the Export dialog', async () => {
    await setSummary(a.page, false)
    const panel = await wrapUp(a.page)
    await expect(panel.locator('[data-testid^="recap-source-"]')).toHaveCount(0)
    await closeRecap(a.page)
    await openBoardExport(a.page)
    await expect(a.page.getByTestId('export-session-csv-section')).toHaveCount(0)
    await a.page.keyboard.press('Escape')
    await expect(a.page.getByTestId('export-dialog')).toHaveCount(0)
  })

  await test.step('on: the Export dialog offers Session results (the api runs live activities)', async () => {
    await setSummary(a.page, true)
    await openBoardExport(a.page)
    const section = a.page.getByTestId('export-session-csv-section')
    await expect(section).toBeVisible()
    await expect(section.getByTestId('export-session-csv')).toBeEnabled()
    await a.page.keyboard.press('Escape')
  })
  expect(foreign).toEqual([])
})

test('v4: a poll, a word cloud and breakouts in Wrap up without AI, in the Recap frame, and as a formula-safe CSV that names nobody', async ({
  join,
  board,
  users,
}) => {
  const alice = await users.api('alice')
  const landed = {
    activities: (await alice.fetch('GET', activityPath(board))).status() === 200,
    breakouts: (await alice.fetch('GET', breakoutsPath(board))).status() === 200,
  }
  test.skip(
    !landed.activities,
    'the wave V activity routes have not landed on this branch (WS1 lands them; the sources are WS2’s and WS4’s)',
  )
  test.setTimeout(180_000)
  const a = await join('alice')
  const bobUser = await users.grant(board, 'bob', 'editor')
  const carolUser = await users.grant(board, 'carol', 'editor')
  const bob = await users.api('bob')
  const carol = await users.api('carol')
  const foreign = foreignRequests(a.page)
  const downloads = collectDownloads(a.page)
  // every wave V web switch on (the sources of WS2 and WS4 are offered with their features)
  await a.page.evaluate((keys) => {
    for (const k of keys) localStorage.setItem(k, '1')
  }, LIVE_FLAG_KEYS)
  await reloadBoard(a)
  // the session's first edit: Wrap up's window starts there (window.ts sessionSince; WS2's sources keep what ran since)
  await seed(a.page, { notes: [{ id: 'v4-agenda', x: -400, y: 0, text: 'Agenda' }] })

  await test.step('a poll with formula-like options: answered by bob and carol, revealed', async () => {
    type St = { activity: { id: string } }
    const aid = (
      await json<St>(
        await alice.fetch('POST', activitiesPath(board), {
          kind: 'poll',
          prompt: '=1+2 which city?',
          config: { options: ['+Lisbon', '-Oslo', '@Rome'] },
        }),
        201,
      )
    ).activity.id
    await json(
      await bob.fetch('POST', activityActionPath(aid, 'answer'), { answer: { kind: 'poll', choices: [0] } }),
      200,
    )
    await json(
      await carol.fetch('POST', activityActionPath(aid, 'answer'), {
        answer: { kind: 'poll', choices: [1] },
      }),
      200,
    )
    await json(await alice.fetch('POST', activityActionPath(aid, 'reveal')), 200)
  })

  await test.step('a word cloud: case variants group, a formula-like word, revealed', async () => {
    type St = { activity: { id: string } }
    const aid = (
      await json<St>(
        await alice.fetch('POST', activitiesPath(board), {
          kind: 'words',
          prompt: 'One word for the brief',
          config: { maxWords: 3 },
        }),
        201,
      )
    ).activity.id
    await json(
      await bob.fetch('POST', activityActionPath(aid, 'answer'), {
        answer: { kind: 'words', words: ['Bold', '=cmd|calc'] },
      }),
      200,
    )
    await json(
      await carol.fetch('POST', activityActionPath(aid, 'answer'), {
        answer: { kind: 'words', words: ['bold'] },
      }),
      200,
    )
    await json(await alice.fetch('POST', activityActionPath(aid, 'reveal')), 200)
  })

  if (landed.breakouts)
    await test.step('breakouts in two frames, dealt out, then ended', async () => {
      await seed(a.page, {
        frames: [
          { id: 'v4-g1', x: 0, y: 600, w: 600, h: 400, name: 'Group 1' },
          { id: 'v4-g2', x: 700, y: 600, w: 600, h: 400, name: 'Group 2' },
        ],
      })
      type Br = { session: { id: string } }
      const brk = (
        await json<Br>(
          await alice.fetch('POST', breakoutsPath(board), {
            groups: [
              { name: 'Group 1', frameId: 'shape:v4-g1' },
              { name: 'Group 2', frameId: 'shape:v4-g2' },
            ],
            mode: 'auto',
          }),
          201,
        )
      ).session.id
      await json(await alice.fetch('POST', breakoutActionPath(brk, 'end')), 200)
    })
  else
    test.info().annotations.push({
      type: 'breakouts',
      description: 'not run: the breakout routes have not landed on this branch (WS4)',
    })

  // the AI call refused (as an api without AI would): the sources' sections never go through it
  await a.page.route('**/api/boards/*/ai/run', (r) =>
    r.fulfill({
      status: 503,
      contentType: 'application/json',
      body: '{"error":{"code":"AI_OFF","message":"Off."}}',
    }),
  )
  const runs = aiRunRequests(a.page)
  const names = [bobUser.name, carolUser.name]

  await test.step('Wrap up: the polls, word clouds and breakouts sections are there without AI, and name nobody', async () => {
    const panel = await wrapUp(a.page)
    await expect(panel).toHaveAttribute('data-ai', 'false')
    const polls = panel.getByTestId('recap-source-activities')
    await expect(polls).toBeVisible()
    await expect(polls).toContainText('which city')
    const words = panel.getByTestId('recap-source-word-clouds')
    await expect(words).toBeVisible()
    await expect(words).toContainText(/bold/i)
    if (landed.breakouts) await expect(panel.getByTestId('recap-source-breakouts')).toBeVisible()
    const text = await panel.innerText()
    for (const n of names) expect(text, `the panel names ${n}`).not.toContain(n)
    test.info().annotations.push({ type: 'ai/run requests', description: String(runs.length) })
  })

  await test.step('Add as Recap frame: the sections are on the board, with no server rejection', async () => {
    await a.page.getByTestId('recap-add').click()
    await expectSaved(a.page)
    expect((await saveState(a.page)).lastReject).toBeNull()
    const frame = (await items(a.page)).find(
      (e) => e.type === 'frame' && String(e.name).startsWith('Recap · '),
    )
    expect(frame).toBeTruthy()
    const inFrame = (await items(a.page)).filter((e) => e.frameId === frame?.id && e.type === 'text')
    const words = inFrame.map((e) => String(e.originalText ?? e.text ?? '')).join('\n')
    expect(words).toContain('which city')
    expect(words.toLowerCase()).toContain('bold')
    for (const n of names) expect(words).not.toContain(n)
    await closeRecap(a.page)
  })

  await test.step('Session results (CSV): a download whose cells never start a formula, and which names nobody', async () => {
    await openBoardExport(a.page)
    const dialog = a.page.getByTestId('export-dialog')
    const file = await downloadFrom(a.page, () => dialog.getByTestId('export-session-csv').click())
    expect(file.name).toMatch(/ - Session results\.csv$/)
    expect([...file.bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    const text = file.bytes.subarray(3).toString('utf8')
    const cells = readCsv(text).flat()
    for (const c of cells) expect(c, JSON.stringify(c)).not.toMatch(FORMULA)
    for (const w of ['=1+2 which city?', '+Lisbon', '-Oslo', '@Rome', '=cmd|calc'])
      expect(cells, w).toContain(`'${w}`)
    expect(cells).toContain('Bold')
    expect(text).not.toMatch(/usr_/)
    for (const n of names) expect(text).not.toContain(n)
    await expect(dialog.getByTestId('export-status')).toContainText('Session results.csv')
    await a.page.keyboard.press('Escape')
    expect(downloads).toEqual([file.name])
  })
  expect(foreign).toEqual([])
})

test('v4: the wave V pages ask nothing of any other origin: /j/<code> signed out, and the board with every wave V switch on', async ({
  browser,
  join,
}) => {
  await test.step('/j/<code>, signed out, on a phone, with the join codes switch on', async () => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    })
    try {
      await context.addInitScript((keys) => {
        for (const k of keys) localStorage.setItem(k, '1')
      }, LIVE_FLAG_KEYS)
      const page = await context.newPage()
      const foreign = foreignRequests(page)
      await page.goto('/j/ABCD-2345')
      await page.waitForLoadState('networkidle')
      // whatever the page says (WS3's page; the unknown-address screen before it lands), it is a Lobby page
      await expect(page.locator('body')).not.toBeEmpty()
      expect(foreign).toEqual([])
    } finally {
      await context.close()
    }
  })

  await test.step('the board with every wave V switch on: the Facilitate menu, Wrap up and the Export dialog', async () => {
    const a = await join('alice')
    const foreign = foreignRequests(a.page)
    await a.page.evaluate((keys) => {
      for (const k of keys) localStorage.setItem(k, '1')
    }, LIVE_FLAG_KEYS)
    await a.page.reload()
    await expect(a.page.getByTestId('facilitate-button')).toBeAttached()
    await a.page.getByTestId('facilitate-button').click()
    await expect(a.page.getByTestId('facilitate-menu')).toBeVisible()
    await a.page.keyboard.press('Escape')
    await wrapUp(a.page)
    await closeRecap(a.page)
    await openBoardExport(a.page)
    await expect(a.page.getByTestId('export-session-csv-section')).toBeVisible()
    await a.page.keyboard.press('Escape')
    // the board keeps its event stream and socket open (never network-idle): a moment for late requests
    await a.page.waitForTimeout(1_000)
    expect(foreign).toEqual([])
  })
})
