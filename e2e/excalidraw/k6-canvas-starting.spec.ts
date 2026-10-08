// K6-1 (wave K): the deploy case on the local stack. The api restarts while it cannot reach sync (here: sync
// is down), so it does not know which canvas sync runs. The open board's reconnects ask for tickets and are
// told 503 CANVAS_STARTING with Retry-After (the page retries them quickly and stays "connecting"), never 409
// NEW_CANVAS ("made on the new canvas", the old ~30 s stall and its error screen). Once sync is back, the
// api's start-up asks (or the next ticket) find it and the board is online again, still editable.
import type { Response } from '@playwright/test'
import { createNote, expect, expectSaved, test } from '../tests/support/canvas.ts'

interface TicketAnswer {
  status: number
  code: string | null
  retryAfter: string | null
}

test('an api restarted while sync is down answers tickets 503 CANVAS_STARTING (never 409 NEW_CANVAS); the board is online again once sync is back', async ({
  canvasSession,
  stack,
}) => {
  test.setTimeout(180_000)
  const a = await canvasSession('alice')
  const conn = a.page.getByTestId('conn-status')
  await expect(conn).toHaveAttribute('data-state', 'online')
  const tickets: TicketAnswer[] = []
  a.page.on('response', (r: Response) => {
    if (r.request().method() !== 'POST' || !/^\/api\/boards\/[^/]+\/ticket$/.test(new URL(r.url()).pathname))
      return
    void r
      .json()
      .catch(() => null)
      .then((body: { error?: { code?: string } } | null) =>
        tickets.push({
          status: r.status(),
          code: body?.error?.code ?? null,
          retryAfter: r.headers()['retry-after'] ?? null,
        }),
      )
  })

  try {
    // the deploy: sync not reachable, and a new api process (its engine is unknown until sync answers)
    await stack.sync.kill()
    await stack.api.restart()
    await expect(conn).toHaveAttribute('data-state', /connecting|offline/, { timeout: 30_000 })
    await expect
      .poll(() => tickets.filter((t) => t.status === 503 && t.code === 'CANVAS_STARTING').length, {
        timeout: 60_000,
        message: 'a ticket answered 503 CANVAS_STARTING',
      })
      .toBeGreaterThan(0)
    const starting = tickets.find((t) => t.code === 'CANVAS_STARTING')
    expect(starting?.retryAfter).toBe('2')
    // retried, not given up on: no error screen, no "made on the new canvas"
    await expect(a.page.getByTestId('board-load-error')).toHaveCount(0)
    await expect(conn).not.toHaveAttribute('data-state', 'error')
  } finally {
    await stack.sync.start()
  }
  await expect(conn).toHaveAttribute('data-state', 'online', { timeout: 45_000 })
  expect(tickets.filter((t) => t.status === 409 || t.code === 'NEW_CANVAS')).toEqual([])
  // and the board is still this build's own: a note saves
  await createNote(a.page, { x: 60, y: 60, text: 'After the deploy' })
  await expectSaved(a.page)
})
