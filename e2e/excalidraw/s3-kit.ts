// Wave S, WS3 (media comments): helpers for the s3-* specs. The media comments switch is a dev-auth page's
// localStorage override (apps/web/src/features/review/flags.ts REVIEW_FLAG_KEYS.mediaComments), set by an init
// script so it holds across reloads; the review viewer opens from the selection bar's "Review".
import type { Page } from '@playwright/test'
import { type CanvasSession, expect, select, waitForCanvas } from '../tests/support/canvas.ts'

export const MEDIA_FLAG_KEY = 'lobby.reviewMedia'

/** Turns the media comments switch on for this session's pages (and reloads the board with it). */
export async function mediaCommentsOn(s: CanvasSession): Promise<void> {
  await s.context.addInitScript((key) => {
    try {
      localStorage.setItem(key, '1')
    } catch {}
  }, MEDIA_FLAG_KEY)
  await s.page.reload()
  await waitForCanvas(s.page)
}

export const viewer = (page: Page) => page.getByTestId('review-viewer')

/** Selects `id` and opens the review viewer on it through the selection bar's "Review". */
export async function openReview(page: Page, id: string): Promise<void> {
  await select(page, [id])
  await page.getByTestId('review-media').click()
  await expect(viewer(page)).toBeVisible()
}

export interface StoredThread {
  id: string
  anchor: { kind: string; versionId?: string; assetId?: string; timeMs?: number; page?: number }
  spot?: { u: number; v: number }
  comments: { body: string }[]
}

/** The board's threads as the api answers this page's user (same origin, the session cookie). */
export async function apiThreads(page: Page, board: string): Promise<StoredThread[]> {
  return page.evaluate(async (bid) => {
    const res = await fetch(`/api/boards/${bid}/threads?status=all`, { credentials: 'same-origin' })
    if (!res.ok) throw new Error(`threads ${res.status}`)
    return ((await res.json()) as { threads: StoredThread[] }).threads
  }, board)
}

/** POSTs a thread straight to the api (what a stale or hostile client could send); its status and error code. */
export async function postThread(
  page: Page,
  board: string,
  body: Record<string, unknown>,
): Promise<{ status: number; code: string | null }> {
  return page.evaluate(
    async ({ bid, payload }) => {
      const res = await fetch(`/api/boards/${bid}/threads`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(payload),
      })
      const json = (await res.json().catch(() => null)) as { error?: { code?: string } } | null
      return { status: res.status, code: json?.error?.code ?? null }
    },
    { bid: board, payload: body },
  )
}

/** Types a comment into the viewer's composer and posts it (Enter). */
export async function postInViewer(page: Page, text: string): Promise<void> {
  const box = page.getByTestId('rv-composer').locator('textarea')
  await expect(box).toBeFocused()
  await box.fill(text)
  await box.press('Enter')
  await expect(page.getByTestId('rv-composer')).toHaveCount(0)
}

/** The viewer's <video>: its playhead (s) and whether it is paused. */
export const videoState = (page: Page) =>
  page.getByTestId('rv-video-el').evaluate((v) => {
    const el = v as HTMLVideoElement
    return { t: el.currentTime, paused: el.paused, ready: el.readyState }
  })
