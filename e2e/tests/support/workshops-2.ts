// Helpers for the second workshops suite (reactions, raise hand, +1 on notes). Built on the first
// suite's instrumented sessions (support/workshops.ts: network log, API client per person), which
// stay untouched. Owned by the workshops-2 engineer.
import type { Locator, Page, TestInfo } from '@playwright/test'
import type { Api } from './api.ts'
import { edit, read } from './board.ts'
import { richText } from './editor.ts'
import { expect, reachableCenter, type WorkshopSession } from './workshops.ts'

// ---- canvas -------------------------------------------------------------------------------------------

export interface NoteSpec {
  id: string
  x: number
  y: number
  text: string
  parentId?: string
}

export async function addNotes(
  page: Page,
  notes: NoteSpec[],
  frame?: { id: string; x: number; y: number; w: number; h: number },
) {
  await edit(
    page,
    (ed, arg) => {
      if (arg.frame)
        ed.createShape({
          id: arg.frame.id,
          type: 'frame',
          x: arg.frame.x,
          y: arg.frame.y,
          props: { w: arg.frame.w, h: arg.frame.h, name: 'Ideas' },
        })
      ed.createShapes(
        arg.notes.map((n) => ({
          id: n.id,
          type: 'note',
          x: n.x,
          y: n.y,
          ...(n.parentId ? { parentId: n.parentId } : {}),
          props: { richText: n.rich },
        })),
      )
    },
    { notes: notes.map((n) => ({ ...n, rich: richText(n.text) })), frame: frame ?? null },
  )
}

/** Waits until every session holds the shapes (they arrive over the sync socket). */
export async function expectShapes(sessions: WorkshopSession[], ids: string[]) {
  for (const s of sessions)
    await expect
      .poll(() => read(s.page, (ed, list) => list.every((id) => !!ed.getShape(id)), ids), {
        message: `${s.user} has the shapes`,
      })
      .toBe(true)
}

/** The +1s stored in a note as `page` holds it. */
export const plusOnesIn = (page: Page, id: string) =>
  read(
    page,
    (ed, shapeId) => {
      const v = (ed.getShape(shapeId)?.meta as { plusOnes?: unknown } | undefined)?.plusOnes
      return Array.isArray(v) ? (v as string[]) : []
    },
    id,
  )

/**
 * The +1s the sync server stores for a note (`GET /api/boards/:bid/export` reads the room as the
 * server holds it), as `api`'s user.
 */
export async function plusOnesOnServer(api: Api, board: string, id: string): Promise<string[]> {
  const res = await api.fetch('GET', `/api/boards/${board}/export`)
  expect(res.status()).toBe(200)
  const archive = (await res.json()) as { records: { id: string; meta?: { plusOnes?: unknown } }[] }
  const v = archive.records.find((r) => r.id === id)?.meta?.plusOnes
  return Array.isArray(v) ? (v as string[]) : []
}

/** The +1 control or badge on a note (at most one per note). */
export const plusOne = (page: Page, id: string): Locator =>
  page.locator(`[data-testid="plusone"][data-shape-id="${id}"]`)

/** Moves the pointer onto the middle of a note (the select tool marks it hovered). */
export async function hoverNote(page: Page, id: string) {
  const c = await reachableCenter(page, id)
  await page.mouse.move(c.x - 5, c.y - 5)
  await page.mouse.move(c.x, c.y, { steps: 3 })
}

/** Hovers the note and clicks its +1 control, like a person. */
export async function clickPlusOne(page: Page, id: string) {
  await hoverNote(page, id)
  const control = plusOne(page, id)
  await expect(control).toHaveAttribute('data-active', 'true')
  await control.click()
}

// ---- reactions and hands ----------------------------------------------------------------------------

export async function openReactionBar(page: Page): Promise<Locator> {
  const bar = page.getByTestId('reaction-bar')
  if (!(await bar.isVisible())) await page.getByTestId('reactions-button').click()
  await expect(bar).toBeVisible()
  return bar
}

export async function closeReactionBar(page: Page) {
  const bar = page.getByTestId('reaction-bar')
  if (await bar.isVisible()) await page.keyboard.press('Escape')
  await expect(bar).toHaveCount(0)
}

export async function react(page: Page, emoji: string) {
  const bar = await openReactionBar(page)
  await bar.locator(`[data-testid="reaction-option"][data-emoji="${emoji}"]`).click()
}

/** Bursts on `page` from `userId` with `emoji` (they last two seconds). */
export const bursts = (page: Page, userId: string, emoji: string) =>
  page.locator(`[data-testid="reaction-burst"][data-user-id="${userId}"][data-emoji="${emoji}"]`)

/**
 * A screenshot with CSS animations left running (support/screenshots.ts `capture` finishes them,
 * which would show a reaction burst at its faded-out end).
 */
export async function captureLive(name: string, page: Page, testInfo: TestInfo) {
  const path = testInfo.outputPath(name)
  await page.screenshot({ path, animations: 'allow' })
  await testInfo.attach(name, { path, contentType: 'image/png' })
}

/** The CSS animation a burst runs (reduced motion runs a fade only). */
export const burstAnimation = (burst: Locator) => burst.evaluate((el) => getComputedStyle(el).animationName)

export async function setHand(page: Page, raised: boolean) {
  const bar = await openReactionBar(page)
  const toggle = bar.getByTestId('hand-toggle')
  await expect(toggle).toHaveAttribute('aria-pressed', raised ? 'false' : 'true')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', raised ? 'true' : 'false')
  await closeReactionBar(page)
}

export const handsChip = (page: Page) => page.getByTestId('hands-chip')

/** The queue rows' user ids, in order, from the popover (opened from the hands chip). */
export async function openQueue(page: Page): Promise<Locator> {
  const queue = page.getByTestId('hands-queue')
  if (!(await queue.isVisible())) await handsChip(page).click()
  await expect(queue).toBeVisible()
  return queue
}

export const queueIds = (queue: Locator) =>
  queue.getByTestId('hand-row').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-user-id')))

export interface ApiHands {
  hands: { userId: string; name: string; raisedAt: string }[]
}

/** The hands the API holds for the board, as `api`'s user sees them. */
export async function handsOnServer(api: Api, board: string): Promise<string[]> {
  const res = await api.fetch('GET', `/api/boards/${board}/workshop`)
  expect(res.status()).toBe(200)
  return ((await res.json()) as ApiHands).hands.map((h) => h.userId)
}
