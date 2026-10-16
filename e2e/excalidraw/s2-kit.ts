// Wave S, WS2 (versions and compare): helpers of the s2-* specs. The versions switch is off in the shipped build
// (apps/web/src/features/review/flags.ts); a dev-auth page turns it on with localStorage, set here by an init script
// before the board reloads, so every page of the spec runs the feature.
//
//   E2E_PORT_BASE=<base> pnpm --filter @draftroom/e2e exec playwright test -c excalidraw/playwright.config.ts s2-
import type { Page } from '@playwright/test'
import { type CanvasSession, canvasCall, expect, select, waitForCanvas } from '../tests/support/canvas.ts'
import type { FilePayload } from '../tests/support/files.ts'
import { type FileItem, fileItems } from './media-kit.ts'

/** apps/web/src/features/review/flags.ts REVIEW_FLAG_KEYS.versions (that module reads the page's build flags). */
export const VERSIONS_FLAG_KEY = 'lobby.reviewVersions'

/** Turns the versions switch on for every page of the session's context and reloads its board. */
export async function withVersions(s: CanvasSession): Promise<CanvasSession> {
  await s.context.addInitScript((key) => {
    try {
      localStorage.setItem(key, '1')
    } catch {
      // a blocked store keeps the shipped switch (off): the spec then fails on the missing chip
    }
  }, VERSIONS_FLAG_KEY)
  await s.page.reload()
  await waitForCanvas(s.page)
  await expect.poll(async () => (await canvasCall(s.page, 'me'))?.uid).toBe(s.id)
  return s
}

/** The element `id` as a file element (its facts), polled until `pick` says yes. */
export async function fileOf(page: Page, id: string, pick: (f: FileItem) => boolean, timeout = 60_000) {
  let found: FileItem | undefined
  await expect
    .poll(
      async () => {
        found = (await fileItems(page)).find((f) => f.id === id)
        return !!found && pick(found)
      },
      { timeout, message: `element ${id} as expected` },
    )
    .toBe(true)
  return found as FileItem
}

/** The chip of element `id` (the "v3" on its card or image). */
export const chipOf = (page: Page, id: string) => page.locator(`[data-lobby-version-chip="${id}"]`)

/** "Upload new version" from the selection bar: picks `file` for element `id`; resolves when the element shows it. */
export async function uploadNewVersion(page: Page, id: string, file: FilePayload): Promise<FileItem> {
  const before = (await fileItems(page)).find((f) => f.id === id)
  await select(page, [id])
  const chooser = page.waitForEvent('filechooser')
  await page.getByTestId('media-new-version').click()
  await (await chooser).setFiles(file)
  return fileOf(page, id, (f) => f.facts.name === file.name && f.facts.versionId !== before?.facts.versionId)
}

/** An upload from inside the page (the session's cookie, same origin) with X-Lobby-Supersedes: status and body. */
export function rawSupersede(page: Page, board: string, versionId: string, name = 'raw.png') {
  return page.evaluate(
    async ({ board, versionId, name }) => {
      const png = Uint8Array.from(
        atob(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        ),
        (c) => c.charCodeAt(0),
      )
      const res = await fetch(`/api/boards/${board}/assets`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'image/png', 'X-File-Name': name, 'X-Lobby-Supersedes': versionId },
        body: new Blob([png], { type: 'image/png' }),
      })
      return {
        status: res.status,
        body: (await res.json().catch(() => null)) as Record<string, unknown> | null,
      }
    },
    { board, versionId, name },
  )
}

/** The version list of `assetId` as the api answers it to this page. */
export function listVersions(page: Page, board: string, assetId: string) {
  return page.evaluate(
    async ({ board, assetId }) => {
      const res = await fetch(`/api/boards/${board}/asset-versions/${assetId}`, {
        credentials: 'same-origin',
      })
      return {
        status: res.status,
        body: (await res.json().catch(() => null)) as {
          latestVersionId: string
          versions: { n: number; versionId: string; name: string }[]
        } | null,
      }
    },
    { board, assetId },
  )
}
