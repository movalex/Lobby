// K6-3 (wave K): one thumbnail upload per board when several people are on it. Two editors edit one board
// on the local stack for 2 minutes, with the clients' thumbnail waits shortened (a dev-auth build reads
// window.__lobbyThumbnailTiming: features/thumbnails/ported/capture.ts) so that each would upload every
// few seconds: the api's per-board window (THUMBNAIL_MIN_INTERVAL_MS, 30 s, unchanged) is then the limit,
// and the board stream's thumbnail.updated keeps the other client from meeting it. Not one PUT gets 429.
import type { Browser, BrowserContext, Page } from '@playwright/test'
import { signInContext } from '../tests/support/api.ts'
import { createNote, expect, expectSaved, test, updateItem, waitForCanvas } from '../tests/support/canvas.ts'
import type { TestUser } from '../tests/support/users.ts'

/** Each client would render 0.3 s after a change and upload 1 s after one, every 2 s at most. */
const TIMING = {
  renderQuietMs: 300,
  uploadQuietMs: 1_000,
  uploadMinGapMs: 2_000,
  remoteJitterMinMs: 2_000,
  remoteJitterMaxMs: 6_000,
}
const EDIT_MS = 120_000

interface Client {
  context: BrowserContext
  page: Page
  /** every thumbnail PUT's answer: its status, when, and the version of an accepted one */
  puts: { status: number; at: number }[]
  events: number
}

async function open(browser: Browser, board: string, user: TestUser): Promise<Client> {
  const context = await browser.newContext()
  await context.addInitScript((t) => {
    ;(window as unknown as { __lobbyThumbnailTiming?: unknown }).__lobbyThumbnailTiming = t
  }, TIMING)
  const page = await context.newPage()
  const client: Client = { context, page, puts: [], events: 0 }
  page.on('response', (r) => {
    if (r.request().method() === 'PUT' && /^\/api\/boards\/[^/]+\/thumbnail$/.test(new URL(r.url()).pathname))
      client.puts.push({ status: r.status(), at: Date.now() })
  })
  await signInContext(context, user.handle, user.name)
  await page.goto(`/b/${board}`)
  await waitForCanvas(page)
  // an editor with an account captures (viewers, commenters and guests never do)
  await expect(page.getByTestId('thumbnail-capture')).not.toHaveAttribute('data-state', 'off')
  return client
}

test('two editors on one board for 2 minutes with shortened waits: 0 thumbnail 429s, about one upload per 30 s window', async ({
  browser,
  board,
  users,
}) => {
  test.setTimeout(EDIT_MS + 120_000)
  const a = await open(browser, board, await users.get('alice'))
  const b = await open(browser, board, await users.grant(board, 'bob', 'editor'))
  try {
    const na = await createNote(a.page, { x: 0, y: 0, text: 'Alice’s note' })
    await expectSaved(a.page)
    const nb = await createNote(b.page, { x: 320, y: 0, text: 'Bob’s note' })
    await expectSaved(b.page)
    // both keep editing, each on their own rhythm, with short pauses (each pause would let them upload)
    const end = Date.now() + EDIT_MS
    for (let i = 0; Date.now() < end; i++) {
      await updateItem(a.page, na, { x: (i % 12) * 15 })
      await a.page.waitForTimeout(600 + (i % 4) * 300)
      await updateItem(b.page, nb, { y: (i % 9) * 15 })
      await b.page.waitForTimeout(900 + (i % 3) * 500)
    }
    // the last pictures go once their windows open (30 s plus the jitter at most)
    await a.page.waitForTimeout(45_000)
    const all = [...a.puts, ...b.puts].sort((x, y) => x.at - y.at)
    const accepted = all.filter((p) => p.status === 200)
    // positive control: both clients were due to upload all along, and uploads happened
    expect(accepted.length, JSON.stringify(all)).toBeGreaterThanOrEqual(3)
    expect(
      all.filter((p) => p.status === 429),
      JSON.stringify(all),
    ).toEqual([])
    expect(
      all.filter((p) => p.status !== 200),
      JSON.stringify(all),
    ).toEqual([])
    // the api's window (30 s, unchanged) between any two accepted uploads, whoever made them
    for (let i = 1; i < accepted.length; i++)
      expect((accepted[i]?.at ?? 0) - (accepted[i - 1]?.at ?? 0)).toBeGreaterThanOrEqual(29_000)
  } finally {
    await a.context.close()
    await b.context.close()
  }
})
