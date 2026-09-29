// The Excalidraw side of B8's drill and "open in two browsers" rows, through O3's harness (from M1: the
// Excalidraw build's sync with O1's room, the spike board page with O2's engine, O3's facade). O4.
//
// Setup (§8.3 B8 "Opening the converted board in two browsers"): a restored or generated board's id has
// no api row in the stack's fresh PGlite, so a board row is created through the api under a NEW id and
// the board file is copied to that id's board path BEFORE the room opens; referenced files have no asset
// rows there, so images show Lobby's placeholder and still push nothing (E1).

import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { harness } from '../support/harness.ts'
import type { BrowserProcess, DevUser, SpikeBStack } from '../support/types.ts'
import type { AEdits, ExcalidrawSide } from './drill.ts'

/** O4's Excalidraw stack is 7905; the lead's integration pass runs these specs on its own SPIKE_B_PORT_BASE. */
export const EXCALIDRAW_BASE = Number(process.env.SPIKE_B_PORT_BASE ?? 7905)

/** Copies a board file (and its WAL) to `boardId`'s path in the stack's data dir, before its room opens. */
export function placeBoardFile(stack: SpikeBStack, source: string, boardId: string): string {
  const rooms = join(stack.dataDir, 'rooms')
  mkdirSync(rooms, { recursive: true })
  const target = join(rooms, `board-${boardId}.sqlite`)
  copyFileSync(source, target)
  if (existsSync(`${source}-wal`)) copyFileSync(`${source}-wal`, `${target}-wal`)
  return target
}

const facade = <T>(page: Page, fn: string, ...args: unknown[]): Promise<T> =>
  page.evaluate(
    ({ fn, args }) => {
      const f = (window as unknown as { lobbyCanvas: Record<string, (...a: unknown[]) => unknown> })
        .lobbyCanvas
      return f[fn]?.(...args) as T
    },
    { fn, args },
  )

async function waitSaved(page: Page, timeoutMs = 30_000): Promise<void> {
  await page.waitForFunction(
    () => {
      const s = (
        window as unknown as { lobbyCanvas?: { saveState(): { kind?: string } | string } }
      ).lobbyCanvas?.saveState()
      return s === 'saved' || (typeof s === 'object' && s?.kind === 'saved')
    },
    null,
    { timeout: timeoutMs, polling: 100 },
  )
}

/**
 * The drill's Excalidraw side on a running Excalidraw stack: A edits in its own browser through the
 * facade; `release` stops the stack's sync so the R0 stand-in can open the file; `rollForward` restarts it
 * and opens the board again (the room's open path runs the roll-forward, O1 calling O4's `prepare`).
 */
export function harnessSide(
  stack: SpikeBStack,
  user: DevUser,
  name = 'A',
): ExcalidrawSide & { close(): Promise<void> } {
  let browser: BrowserProcess | null = null
  let syncRunning = true
  const open = async (boardId: string) => {
    if (!syncRunning) {
      await stack.restartSync()
      syncRunning = true
    }
    browser ??= await harness.launchBrowser(stack, user, { name })
    await browser.openBoard(boardId)
  }
  return {
    convert: async (boardId) => {
      await open(boardId)
    },
    applyA: async (boardId, e: AEdits) => {
      await open(boardId)
      const page = (browser as BrowserProcess).page
      if (e.move) {
        const cur = await facade<{ x: number } | null>(page, 'get', e.move)
        if (cur) await facade(page, 'update', e.move, { x: cur.x + 60 })
      }
      if (e.recolor) await facade(page, 'update', e.recolor, { backgroundColor: e.color })
      if (e.remove) await facade(page, 'delete', e.remove)
      const createdId = await facade<string>(page, 'create', 'rectangle', {
        x: -9_000,
        y: -9_000,
        width: 120,
        height: 80,
      })
      await waitSaved(page)
      return { createdId }
    },
    release: async () => {
      if (browser) {
        await browser.close()
        browser = null
      }
      if (syncRunning) await stack.killSync('SIGINT')
      syncRunning = false
    },
    rollForward: async (boardId) => {
      await open(boardId)
    },
    close: async () => {
      await browser?.close()
      browser = null
    },
  }
}
