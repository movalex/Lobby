// OWNER: WS2 (wave W, background removal; docs/WAVE-W-CONTRACTS.md §4). End to end in a browser: an editor right-clicks
// an image, picks "Remove background (beta)", the api queues the op, a worker removes the background in its child
// process, the api makes a NEW asset and version derived from the source, the stack's own preview worker makes its
// thumbnails, and the image element points at it in one undo step; a second tab sees the change; one undo puts the
// original back; a viewer is never offered it; no request leaves Lobby's origins; no data: or blob: URL is written.
//
// The worker that runs the op is apps/worker/test/remove-bg-e2e-worker.ts: the real apps/worker op path (client, loop, runner, child, sharp,
// onnxruntime-node) with the tiny synthetic model of apps/worker/test/tiny-onnx.ts in place of u2netp, whose approved
// file nobody has downloaded (its pin is null, so the stack's own worker reports no remove-bg capability). The stack's
// worker token is fixed for this file so both workers can use it.
//
//   E2E_PORT_BASE=<base> pnpm --filter @draftroom/e2e exec playwright test w2-remove-bg
import { type ChildProcess, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { clickItem, expect, select, test } from '../tests/support/canvas.ts'
import { pressUndo } from '../tests/support/excalidraw.ts'
import { makeImages } from '../tests/support/files.ts'
import { API_URL } from '../tests/support/ports.ts'
import { REPO_ROOT } from '../tests/support/stack.ts'
import {
  boxOf,
  expectLoadedImage,
  fileItems,
  imageItems,
  insertFiles,
  newItems,
  settleCamera,
} from './media-kit.ts'
import { foreignRequests } from './v2-kit.ts'

/** features/formats/flags.ts FORMATS_FLAG_KEYS.removeBackground (e2e declares no dependency on the web package) */
const FLAG_KEY = 'lobby.formatsRemoveBackground'
const TOKEN = randomBytes(32).toString('base64url')
const MENU_ROW = 'Remove background (beta)'

test.use({
  viewport: { width: 1440, height: 900 },
  apiEnv: { DRAFTROOM_WORKER_TOKEN: TOKEN },
  workerEnv: { DRAFTROOM_WORKER_TOKEN: TOKEN },
})

interface OpWorker {
  lines: string[]
  stop(): Promise<void>
}

/** Starts the op worker and waits until it has asked the api for an op once (the capability is then recorded). */
async function startOpWorker(): Promise<OpWorker> {
  const tmp = mkdtempSync(join(tmpdir(), 'drw-w2-'))
  const child: ChildProcess = spawn(
    process.execPath,
    [join(REPO_ROOT, 'apps/worker/test/remove-bg-e2e-worker.ts')],
    {
      env: {
        PATH: process.env.PATH ?? '',
        SYSTEMROOT: process.env.SYSTEMROOT ?? '',
        W2_API_URL: API_URL,
        W2_WORKER_TOKEN: TOKEN,
        W2_TMP_DIR: tmp,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    },
  )
  const lines: string[] = []
  child.stdout?.on('data', (b: Buffer) => lines.push(...b.toString('utf8').split(/\r?\n/).filter(Boolean)))
  child.stderr?.on('data', (b: Buffer) => lines.push(`stderr: ${b.toString('utf8').trim()}`))
  await expect
    .poll(() => lines.some((l) => l.includes('asked')), { timeout: 30_000, message: 'the op worker asked' })
    .toBe(true)
  return {
    lines,
    async stop() {
      child.stdin?.end()
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve()
        const t = setTimeout(() => {
          child.kill('SIGKILL')
          resolve()
        }, 5_000)
        child.once('exit', () => {
          clearTimeout(t)
          resolve()
        })
      })
      rmSync(tmp, { recursive: true, force: true, maxRetries: 3 })
    },
  }
}

/** The web switch on for this page (a dev-auth build reads it when the offer is drawn). */
const switchOn = (page: Page) => page.evaluate((key) => localStorage.setItem(key, '1'), FLAG_KEY)

async function placeImage(page: Page, board: string) {
  const [file] = await makeImages(page, [{ name: 'portrait.png', w: 640, h: 480, type: 'image/png' }])
  if (!file) throw new Error('no image')
  const before = new Set((await fileItems(page)).map((f) => f.id))
  await insertFiles(page, [file])
  const [img] = await newItems(page, imageItems, before, 1)
  if (!img) throw new Error('no image element')
  await expectLoadedImage(page, img.id, board)
  await settleCamera(page)
  return img
}

test('W2 Remove background: the image points at a new version without its background in one undo step; bob sees it; undo puts the original back', async ({
  canvasSession,
  board,
}) => {
  test.setTimeout(240_000)
  const worker = await startOpWorker()
  try {
    const a = await canvasSession('alice')
    const foreign = foreignRequests(a.page)
    await switchOn(a.page)
    const b = await canvasSession('bob')
    const v1 = await placeImage(a.page, board)

    await test.step('the context menu offers it on the image, and the op runs on the worker', async () => {
      await select(a.page, [v1.id])
      await clickItem(a.page, v1.id, { button: 'right' })
      const row = a.page.getByRole('menuitem', { name: MENU_ROW })
      await expect(row).toBeVisible()
      await row.click()
      await expect(a.page.getByTestId('remove-bg-done')).toBeVisible({ timeout: 90_000 })
      expect(worker.lines.some((l) => l.endsWith(' done') || l === '[w2-op-worker] done')).toBe(true)
    })

    const after = (await fileItems(a.page)).find((f) => f.id === v1.id)
    if (!after) throw new Error('the image is gone')
    await test.step('the same element, a NEW asset and version, the same box, nothing but ids written', async () => {
      expect(after.facts.versionId).not.toBe(v1.facts.versionId)
      expect(after.facts.assetId).not.toBe(v1.facts.assetId)
      expect(after.fileId).toBe(after.facts.versionId)
      expect(after.facts).toMatchObject({
        kind: 'image',
        mimeType: 'image/png',
        name: 'portrait (no background).png',
      })
      expect(boxOf(after)).toEqual(boxOf(v1))
      expect(JSON.stringify(after)).not.toMatch(/data:|blob:/)
      expect((await imageItems(a.page)).length).toBe(1)
      // the stack's preview worker made its thumbnails: the canvas shows the new version
      await expectLoadedImage(a.page, v1.id, board, 90_000)
      // the stored original is a PNG with an alpha channel (IHDR colour type 6), the source's size
      const png = await a.page.request.get(
        `/files/${after.facts.assetId}/${after.facts.versionId}/original?board=${board}`,
      )
      expect(png.status()).toBe(200)
      const bytes = await png.body()
      expect(bytes.subarray(1, 4).toString('latin1')).toBe('PNG')
      expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20), bytes[25]]).toEqual([640, 480, 6])
      // and the original's file is still there (kept, never overwritten)
      const orig = await a.page.request.get(
        `/files/${v1.facts.assetId}/${v1.facts.versionId}/original?board=${board}`,
      )
      expect(orig.status()).toBe(200)
    })

    await test.step('bob sees the new version on his canvas', async () => {
      await expect
        .poll(async () => (await fileItems(b.page)).find((f) => f.id === v1.id)?.facts.versionId, {
          timeout: 30_000,
        })
        .toBe(after.facts.versionId)
      await expectLoadedImage(b.page, v1.id, board, 90_000)
    })

    await test.step('one undo puts the original back, for both', async () => {
      await pressUndo(a.page)
      await expect
        .poll(async () => (await fileItems(a.page)).find((f) => f.id === v1.id)?.facts.versionId)
        .toBe(v1.facts.versionId)
      await expect
        .poll(async () => (await fileItems(b.page)).find((f) => f.id === v1.id)?.facts.versionId, {
          timeout: 30_000,
        })
        .toBe(v1.facts.versionId)
      const back = (await fileItems(a.page)).find((f) => f.id === v1.id)
      expect(back && boxOf(back)).toEqual(boxOf(v1))
    })

    await test.step('a viewer is not offered it', async () => {
      const c = await canvasSession('carol', { role: 'viewer' })
      await switchOn(c.page)
      await clickItem(c.page, v1.id, { button: 'right' })
      await expect(c.page.getByRole('menuitem', { name: MENU_ROW })).toHaveCount(0)
    })

    expect(foreign).toEqual([])
  } finally {
    await worker.stop()
  }
})
