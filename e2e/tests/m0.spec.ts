import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, type Page, test } from '@playwright/test'

const SYNC_PORT = process.env.E2E_SYNC_PORT ?? '5881'
const SERVER = resolve(import.meta.dirname, '../../apps/sync/src/server.ts')
const DATA_DIR = mkdtempSync(join(tmpdir(), 'dr-e2e-'))
const serverLog: string[] = []

type Shape = { id: string; type: string; props: Record<string, unknown> }
type EditorLike = {
  createShape(s: Record<string, unknown>): unknown
  updateShape(s: Record<string, unknown>): unknown
  getCurrentPageShapes(): Shape[]
  getCollaborators(): { userName: string }[]
}
declare global {
  interface Window {
    editor?: EditorLike
  }
}

async function startServer(): Promise<ChildProcess> {
  const child = spawn(process.execPath, [SERVER], {
    cwd: resolve(import.meta.dirname, '../../apps/sync'),
    env: {
      ...process.env,
      PORT: SYNC_PORT,
      HOST: '127.0.0.1',
      DRAFTROOM_DATA_DIR: DATA_DIR,
      DRAFTROOM_DEV_AUTH: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.on('data', (d) => serverLog.push(String(d)))
  child.stderr?.on('data', (d) => serverLog.push(`ERR ${d}`))
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${SYNC_PORT}/healthz`)).ok) return child
    } catch {}
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`sync server did not start: ${serverLog.join('')}`)
}

async function open(page: Page, room: string, user: string) {
  await page.goto(`/b/${room}?user=${user}`)
  await page.waitForFunction(() => window.editor !== undefined, undefined, { timeout: 30_000 })
}
const shapes = (p: Page) =>
  p.evaluate(() =>
    window.editor
      ?.getCurrentPageShapes()
      .map((s) => `${s.type}:${String(s.props.name ?? '')}`)
      .sort(),
  )

test('M0: two sessions, reload, SIGKILL+restart, offline edit reconnect', async ({ browser }) => {
  let server = await startServer()
  const room = `e2e-${Date.now()}`
  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
  const a = await ctxA.newPage()
  const b = await ctxB.newPage()
  await Promise.all([open(a, room, 'alice'), open(b, room, 'bob')])

  // 1. edits + presence both ways (custom shape proves the shared schema on client AND server)
  await a.evaluate(() =>
    window.editor?.createShape({
      id: 'shape:card1',
      type: 'dr-file-card',
      x: 100,
      y: 100,
      props: {
        name: 'deck.pdf',
        kind: 'pdf',
        status: 'ready',
        pageCount: 4,
        assetId: 'ast_0123456789',
        versionId: 'ver_0123456789',
        mimeType: 'application/pdf',
        sizeBytes: 2274,
      },
    }),
  )
  await expect(b.getByTestId('file-card')).toContainText('deck.pdf', { timeout: 15_000 })
  await b.evaluate(() => window.editor?.createShape({ type: 'geo', x: 400, y: 100 }))
  await expect.poll(() => shapes(a)).toEqual(['dr-file-card:deck.pdf', 'geo:'])
  await expect
    .poll(() => a.evaluate(() => window.editor?.getCollaborators().map((c) => c.userName)))
    .toContain('bob')

  // 2. reload preserves content
  await a.reload()
  await a.waitForFunction(() => window.editor !== undefined)
  await expect.poll(() => shapes(a)).toEqual(['dr-file-card:deck.pdf', 'geo:'])

  // 3. SIGKILL the server (B already rendered both edits => both were committed before broadcast)
  server.kill('SIGKILL')
  await new Promise((r) => server.once('exit', r))
  await expect(a.getByTestId('conn-status')).toHaveAttribute('data-state', 'offline', { timeout: 15_000 })
  // offline edit on A (kept as a speculative change, pushed on reconnect)
  await a.evaluate(() =>
    window.editor?.updateShape({
      id: 'shape:card1',
      type: 'dr-file-card',
      props: { name: 'renamed-offline' },
    }),
  )
  server = await startServer()
  await expect(a.getByTestId('conn-status')).toHaveAttribute('data-state', 'online', { timeout: 20_000 })
  await expect(b.getByTestId('conn-status')).toHaveAttribute('data-state', 'online', { timeout: 20_000 })
  // 4. reconnect: A's offline edit reaches B, nobody is rolled back to an older board
  await expect.poll(() => shapes(b), { timeout: 15_000 }).toEqual(['dr-file-card:renamed-offline', 'geo:'])
  await expect.poll(() => shapes(a)).toEqual(['dr-file-card:renamed-offline', 'geo:'])
  // fresh session after the restart loads from SQLite
  const ctxC = await browser.newContext()
  const c = await ctxC.newPage()
  await open(c, room, 'carol')
  await expect.poll(() => shapes(c)).toEqual(['dr-file-card:renamed-offline', 'geo:'])

  await Promise.all([ctxA.close(), ctxB.close(), ctxC.close()])
  server.kill('SIGKILL')
  expect(serverLog.join('')).not.toMatch(/room error|Error:/)
})
