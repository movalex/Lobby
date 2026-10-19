// Wave W (the integration; docs/WAVE-W-CONTRACTS.md §3.3, §9.1, §9.2): the DEPLOYED NAS preview worker, built from main
// 2f6f0479 (before wave W; its apps/worker is byte for byte the one in 7e5b4d6), against this api with every wave W
// switch on. It is the stack's own worker here, so every preview of this file goes through the old claim loop:
//  - it keeps making previews (an image, a 12-page PDF) through the unchanged preview protocol;
//  - it reports no capability (it has no ops client at all), so the api offers none of the three worker-backed
//    features (file search, deck import, background removal) and their routes answer as unknown routes; doc cards and
//    the admin page, which need no worker, are offered;
//  - a worker of this build that checks in (its start log names what it reports) turns file search and deck import
//    on within one claim, and Insert as slides then queues the op; background removal stays hidden (its model pin is
//    null, so no worker reports remove-bg).
//
// Needs the deployed worker's tree with its own install (E2E_OLD_WORKER_ENTRY, e.g. a copy of 7e5b4d6 or 2f6f0479 with
// `pnpm install`: <tree>/apps/worker/src/worker.ts). Without it the spec is skipped, saying so.
//
//   E2E_OLD_WORKER_ENTRY=<tree>/apps/worker/src/worker.ts E2E_PORT_BASE=<base> \
//     pnpm --filter @draftroom/e2e excalidraw -- w-compat-old-worker
import { type ChildProcess, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test } from '../tests/support/canvas.ts'
import { makeImages } from '../tests/support/files.ts'
import { makePdf } from '../tests/support/media-2.ts'
import { API_URL } from '../tests/support/ports.ts'
import { REPO_ROOT } from '../tests/support/stack.ts'
import { foreignRequests } from './ai-kit.ts'
import { cardItems, expectLoadedImage, fileCard, imageItems, insertFiles } from './media-kit.ts'

const OLD_WORKER_ENTRY = process.env.E2E_OLD_WORKER_ENTRY ? resolve(process.env.E2E_OLD_WORKER_ENTRY) : ''
const TOKEN = randomBytes(32).toString('base64url')

test.use({
  viewport: { width: 1440, height: 900 },
  workerEntry: OLD_WORKER_ENTRY,
  apiEnv: { DRAFTROOM_WORKER_TOKEN: TOKEN },
  workerEnv: { DRAFTROOM_WORKER_TOKEN: TOKEN },
})

const UNKNOWN = { error: { code: 'NOT_FOUND', message: 'Not found.' } }

/** Starts a worker of THIS build beside the stack's (old) one; resolves once it has said what it reports. */
async function startCurrentWorker(): Promise<{ lines: string[]; stop(): Promise<void> }> {
  const tmp = mkdtempSync(join(tmpdir(), 'drw-wcompat-'))
  const child: ChildProcess = spawn(process.execPath, [join(REPO_ROOT, 'apps/worker/src/worker.ts')], {
    env: {
      PATH: process.env.PATH ?? '',
      SYSTEMROOT: process.env.SYSTEMROOT ?? '',
      DRAFTROOM_API_URL: API_URL,
      DRAFTROOM_WORKER_TOKEN: TOKEN,
      WORKER_ID: 'w-compat-current',
      WORKER_TMP_DIR: tmp,
      WORKER_POLL_MS: '100',
      WORKER_POLL_MAX_MS: '500',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const lines: string[] = []
  child.stdout?.on('data', (b: Buffer) => lines.push(...b.toString('utf8').split(/\r?\n/).filter(Boolean)))
  child.stderr?.on('data', (b: Buffer) => lines.push(`stderr: ${b.toString('utf8').trim()}`))
  await expect
    .poll(() => lines.some((l) => l.includes('[worker] worker ops:')), {
      timeout: 30_000,
      message: 'the current worker said what it reports',
    })
    .toBe(true)
  return {
    lines,
    async stop() {
      await new Promise<void>((done) => {
        if (child.exitCode !== null) return done()
        const t = setTimeout(() => {
          child.kill('SIGKILL')
          done()
        }, 10_000)
        child.once('exit', () => {
          clearTimeout(t)
          done()
        })
        child.kill('SIGTERM')
      })
      rmSync(tmp, { recursive: true, force: true, maxRetries: 3 })
    },
  }
}

test('the deployed 2f6f0479 worker keeps making previews against this api, is handed no op, and the worker-backed features stay hidden until a capable worker checks in', async ({
  canvasSession,
  board,
  stack,
  users,
}) => {
  test.skip(
    !OLD_WORKER_ENTRY,
    'needs the deployed worker: set E2E_OLD_WORKER_ENTRY to its apps/worker/src/worker.ts (a tree with its own install)',
  )
  test.setTimeout(300_000)
  const api = await users.api('alice')
  const offer = async () =>
    ((await (await api.fetch('GET', '/api/auth/config')).json()) as { formats?: Record<string, boolean> })
      .formats

  await test.step('the stack runs the old worker: it starts without any word of worker ops', async () => {
    const logs = stack.worker.logs()
    expect(logs).toContain('[worker] started (api: ')
    expect(logs).not.toContain('worker ops')
  })

  const a = await canvasSession('alice')
  const foreign = foreignRequests(a.page)
  const [png] = await makeImages(a.page, [{ name: 'photo.png', w: 640, h: 480, type: 'image/png' }])
  if (!png) throw new Error('no image')
  await insertFiles(a.page, [await makePdf('Deck.pdf', 12), png])

  const photo = async () => (await imageItems(a.page)).find((i) => i.facts.name === 'photo.png')
  await expect.poll(async () => !!(await photo()), { timeout: 30_000 }).toBe(true)
  const image = await photo()
  if (!image) throw new Error('no image element')

  await test.step('its previews: the PDF card is ready, the image shows its display derivative', async () => {
    await expect(fileCard(a.page, 'Deck.pdf')).toHaveAttribute('data-status', 'ready', { timeout: 120_000 })
    await expectLoadedImage(a.page, image.id, board, 120_000)
  })
  const card = (await cardItems(a.page)).find((c) => c.facts.name === 'Deck.pdf')
  if (!card) throw new Error('no card')

  await test.step('no capable worker: the api offers doc cards and the admin page, not the three worker-backed ones', async () => {
    expect(await offer()).toEqual({
      docCards: true,
      removeBackground: false,
      fileSearch: false,
      deckImport: false,
      admin: true,
    })
    for (const [path, ver] of [
      ['render-pages', card.facts.versionId],
      ['remove-background', image.facts.versionId],
    ] as const) {
      const res = await api.fetch('POST', `/api/files/${ver}/${path}`, { boardId: board })
      expect(res.status(), path).toBe(404)
      expect(await res.json(), path).toEqual(UNKNOWN)
    }
    // the web offers no Insert as slides in the viewer
    await fileCard(a.page, 'Deck.pdf').getByTestId('file-card-view-pages').click()
    await expect(a.page.getByTestId('pdf-viewer')).toBeVisible()
    await expect(a.page.getByTestId('pdf-viewer-insert-slides')).toHaveCount(0)
    await a.page.keyboard.press('Escape')
    await expect(a.page.getByTestId('pdf-viewer')).toHaveCount(0)
  })

  const current = await startCurrentWorker()
  try {
    await test.step('a worker of this build checks in: file search and deck import are offered, background removal is not', async () => {
      const said = current.lines.find((l) => l.includes('[worker] worker ops:')) ?? ''
      expect(said).toContain('extract-text@1')
      expect(said).toContain('render-pages@1')
      expect(said).not.toMatch(/worker ops: [^(]*remove-bg/)
      await expect
        .poll(offer, { timeout: 60_000, intervals: [500, 1_000, 2_000] })
        .toEqual({ docCards: true, removeBackground: false, fileSearch: true, deckImport: true, admin: true })
      const bg = await api.fetch('POST', `/api/files/${image.facts.versionId}/remove-background`, {
        boardId: board,
      })
      expect(bg.status()).toBe(404)
      const pages = await api.fetch('POST', `/api/files/${card.facts.versionId}/render-pages`, {
        boardId: board,
      })
      expect(pages.status(), await pages.text()).toBe(202)
    })
  } finally {
    await current.stop()
  }

  await test.step('the old worker is still the stack worker, alive and never told of an op', async () => {
    expect(stack.worker.running()).toBe(true)
    expect(stack.worker.logs()).not.toMatch(/worker ops|\/api\/worker\/ops/)
  })
  expect(foreign).toEqual([])
})
