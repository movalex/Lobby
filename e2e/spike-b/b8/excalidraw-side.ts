// The Excalidraw side of B8's drill and "open in two browsers" rows, through O3's harness (the Excalidraw
// build's sync with O1's room and its conversion on open, the spike board page with O2's engine, O3's
// facade). O4.
//
// Setup (§8.3 B8 "Opening the converted board in two browsers"): a restored or generated board's id has
// no api row in the stack's fresh PGlite, so a board row is created through the api under a NEW id and
// the board file is copied to that id's board path BEFORE the room opens; referenced files have no asset
// rows there, so images show Lobby's placeholder and still push nothing (E1).

import { existsSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { copyBoardFileSelfContained } from '../../../apps/sync/src/backup/checkpoint.ts'
import { compareIndexThenId, isValidKey } from '../../../apps/web/src/canvas/sync/index-keys.ts'
import type { O3BrowserProcess } from '../support/browsers.ts'
import { canvasOf, harness, waitSaved } from '../support/harness.ts'
import type { DevUser, PushLog, SpikeBStack } from '../support/types.ts'
import type { AEdits, AResult, ExcalidrawSide } from './drill.ts'

/** O4's Excalidraw stack is 7905; the lead's integration pass runs these specs on its own SPIKE_B_PORT_BASE. */
export const EXCALIDRAW_BASE = Number(process.env.SPIKE_B_PORT_BASE ?? 7905)
/**
 * The drill's stacks evict an idle room after 1 s, so `release` can wait for the room to close its board
 * file (SQLite checkpoints and removes the WAL on the last close) before the sync process is stopped: the
 * stand-in then opens a file the Excalidraw sync closed cleanly, as after a deploy's graceful stop.
 */
export const DRILL_SYNC_ENV = { IDLE_EVICT_MS: '1000' } as const

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export const boardFile = (stack: SpikeBStack, boardId: string) =>
  join(stack.dataDir, 'rooms', `board-${boardId}.sqlite`)

/**
 * Copies a board file (with its WAL, checkpointed into the copy) to `boardId`'s path in the stack's data
 * dir, before its room opens. Refuses when a file is already there (the room would have opened it as a new
 * board).
 */
export function placeBoardFile(stack: SpikeBStack, source: string, boardId: string): string {
  const rooms = join(stack.dataDir, 'rooms')
  mkdirSync(rooms, { recursive: true })
  const target = boardFile(stack, boardId)
  if (existsSync(target)) throw new Error(`a board file already exists for ${boardId}`)
  copyBoardFileSelfContained(source, target)
  return target
}

/** How one `release` stopped the sync: clean when no WAL was left beside the files it opened. */
export interface Release {
  readonly clean: boolean
  /** the files that still had a WAL at the timeout (`board` or `born-after`) and its bytes */
  readonly left: readonly string[]
}

/** Waits until no WAL file is left beside each path (its room closed the file). */
async function waitClosed(paths: ReadonlyMap<string, string>, timeoutMs = 20_000): Promise<Release> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const left = [...paths].filter(([, p]) => existsSync(`${p}-wal`))
    if (!left.length) return { clean: true, left: [] }
    if (Date.now() > deadline)
      return { clean: false, left: left.map(([label, p]) => `${label} ${statSync(`${p}-wal`).size}`) }
    await sleep(100)
  }
}

const near = (a: unknown, b: number) => typeof a === 'number' && Math.abs(a - b) < 0.01

/**
 * The z-order keys as a client sees them (live elements AND tombstones, in (index, id) order, the array
 * `updateScene` gets): every key valid and strictly above the one before it, and every label after its
 * container. Returns the problems as ids and reasons only; empty when the order needs no re-key (a re-key
 * would bump a confirmed element's version on the client and push it back).
 */
export function indexProblems(elements: readonly Record<string, unknown>[]): string[] {
  const els = elements.map((e) => ({
    id: String(e.id),
    index: (e.index as string | null) ?? null,
    containerId: (e.containerId as string | null | undefined) ?? null,
  }))
  const sorted = [...els].sort((a, b) => compareIndexThenId(a as never, b as never))
  const pos = new Map(sorted.map((e, i) => [e.id, i]))
  const out: string[] = []
  sorted.forEach((e, i) => {
    if (!isValidKey(e.index)) out.push(`${e.id} invalid`)
    const prev = sorted[i - 1]
    if (prev && e.index !== null && prev.index !== null && e.index <= prev.index)
      out.push(`${e.id} (${e.index}) not above ${prev.id} (${prev.index})`)
    if (e.containerId && (pos.get(e.containerId) ?? -1) > i) out.push(`${e.id} before its container`)
  })
  return out
}

/** A push log's ops as ids, kinds, group and field NAMES only (never values): the evidence of a push. */
export async function opSummary(log: PushLog): Promise<string[]> {
  const keys = (v: unknown) => (v && typeof v === 'object' ? Object.keys(v as object).sort() : [])
  return (await log.ops()).map((op) =>
    op.k === 'c'
      ? `c ${op.el.id} ${op.el.type}`
      : `p ${op.id} ${[
          ...Object.entries(op.g ?? {}).map(([g, f]) => `${g}{${keys(f).join(',')}}`),
          ...(op.c ? [`c{${keys(op.c).join(',')}}`] : []),
          ...(op.b ? ['b'] : []),
          ...(op.fit ? [`fit{${keys(op.fit).join(',')}}`] : []),
        ].join(' ')}`,
  )
}

/**
 * Waits until the tab shows Saved; on the timeout returns what it shows instead (the state, the pending
 * count and the last reject's code: no content), so the drill reports an edit that did not save.
 */
async function settled(page: Page, timeoutMs = 30_000): Promise<string | null> {
  try {
    await waitSaved(page, timeoutMs)
    return null
  } catch {
    const s = await canvasOf(page).saveState()
    return `${s.state} pending ${s.pending}${s.lastReject ? ` reject ${s.lastReject.code}` : ''}`
  }
}

/**
 * Waits until the tab's server clock has not moved for `quietMs` (the room sent no `changes` since), up to
 * `timeoutMs`. Returns the clock when the tab was welcomed and when it went quiet: a difference means the
 * room wrote after the open (on the heavy board: its images' file checks).
 */
async function quiet(
  page: Page,
  quietMs = 1_500,
  timeoutMs = 20_000,
): Promise<{ at: number; quiet: number }> {
  const c = canvasOf(page)
  const at = (await c.session()).clock
  let last = at
  let since = Date.now()
  const deadline = Date.now() + timeoutMs
  while (Date.now() - since < quietMs && Date.now() < deadline) {
    await sleep(100)
    const now = (await c.session()).clock
    if (now !== last) {
      last = now
      since = Date.now()
    }
  }
  return { at, quiet: last }
}

export interface HarnessSide extends ExcalidrawSide {
  close(): Promise<void>
  /** how each `release` stopped the sync: true when every room had closed its file first */
  readonly releases: Release[]
}

/**
 * The drill's Excalidraw side on a running Excalidraw stack (started with DRILL_SYNC_ENV): A edits in its
 * own browser through the facade, one edit at a time, each waited for until the tab shows Saved, then
 * checked in the test snapshot; `release` closes the browser, waits for the room to close the board file
 * and stops the stack's sync so the R0 stand-in can open the file; `rollForward` restarts it and opens the
 * board again (the room's open path runs the roll-forward: O1 calling O4's `prepare`), and
 * `afterRollForward` checks that A's browser converges with the test snapshot and pushed nothing.
 */
export function harnessSide(stack: SpikeBStack, user: DevUser, name = 'A'): HarnessSide {
  let browser: O3BrowserProcess | null = null
  let rec: PushLog | null = null
  let syncRunning = true
  /** the boards this sync process opened since the last release (the ones whose room must close) */
  const opened = new Set<string>()
  const releases: Release[] = []
  /** the rolled-forward board's key problems, read through the test snapshot before A's tab opens it */
  let rfIndexProblems: string[] | null = null
  let rollForwards = 0
  let rfTrigger: 'snapshot-route' | 'joiner' = 'joiner'
  let born: string | null = null
  const open = async (boardId: string) => {
    if (!syncRunning) {
      await stack.restartSync()
      syncRunning = true
    }
    browser ??= await harness.launchBrowser(stack, user, { name })
    rec = await harness.recordPushes(browser.page)
    opened.add(boardId)
    await browser.openBoard(boardId)
  }
  const page = () => (browser as O3BrowserProcess).page
  return {
    releases,
    convert: async (boardId) => {
      await open(boardId)
    },
    bornAfter: async () => {
      // a board created on the spike's Excalidraw build: a new board through the api, opened in A's
      // browser (the room creates its file with lb_* tables only), one element stored
      const { boardId } = await stack.createBoard({ owner: user })
      born = boardId
      await open(boardId)
      await quiet(page())
      const id = await canvasOf(page()).create('rectangle', { x: 0, y: 0, width: 100, height: 60 })
      await waitSaved(page())
      const snap = await harness.readSnapshot(stack, boardId)
      if (!snap.elements.some((e) => e.id === id && !e.isDeleted))
        throw new Error('the born-after board: its element was not stored')
      return boardId
    },
    applyA: async (boardId, e: AEdits): Promise<AResult> => {
      const t0 = Date.now()
      await open(boardId)
      const c = canvasOf(page())
      // A edits a quiet board, one edit at a time, each until Saved: no server frame (the room's own writes
      // after the open, or an ack of A's previous edit) can arrive between an edit's scene update and its
      // change event, O2's open lost-edit race (M3.md), which B8 does not measure (b9-probe-lost-edit does)
      const clock = await quiet(page())
      let movedTo: number | null = null
      const unsaved: Record<string, string | null> = {}
      if (e.move) {
        const cur = await c.get(e.move)
        if (cur) {
          movedTo = cur.x + 60
          await c.update(e.move, { x: movedTo })
          unsaved.move = await settled(page())
        }
      }
      if (e.recolor) {
        await c.update(e.recolor, { backgroundColor: e.color })
        unsaved.recolor = await settled(page())
      }
      if (e.remove) {
        await c.delete(e.remove)
        unsaved.remove = await settled(page())
      }
      const createdId = await c.create('rectangle', { x: -9_000, y: -9_000, width: 120, height: 80 })
      unsaved.create = await settled(page())
      const ms = Date.now() - t0
      // stored? (the room's test snapshot, live elements and tombstones)
      const snap = await harness.readSnapshot(stack, boardId)
      const byId = new Map(snap.elements.map((x) => [x.id, x as unknown as Record<string, unknown>]))
      const stored: Record<string, boolean> = {
        create: byId.get(createdId)?.isDeleted === false,
      }
      if (e.move) stored.move = movedTo !== null && near(byId.get(e.move)?.x, movedTo)
      if (e.recolor) stored.recolor = byId.get(e.recolor)?.backgroundColor === e.color
      if (e.remove) stored.remove = byId.get(e.remove)?.isDeleted === true
      const notSaved = Object.fromEntries(Object.entries(unsaved).filter(([, v]) => v !== null)) as Record<
        string,
        string
      >
      return {
        createdId,
        stored,
        ...(Object.keys(notSaved).length ? { notSaved } : {}),
        ms,
        pushes: rec ? await rec.count() : null,
        clock,
      }
    },
    release: async () => {
      if (browser) {
        await browser.close()
        browser = null
        rec = null
      }
      if (syncRunning) {
        releases.push(
          await waitClosed(
            new Map([...opened].map((id) => [id === born ? 'born-after' : 'board', boardFile(stack, id)])),
          ),
        )
        opened.clear()
        await stack.killSync()
      }
      syncRunning = false
    },
    rollForward: async (boardId) => {
      // Odd cycles: the test snapshot route, which waits for the same preparation as a joiner (O1), runs
      // the roll-forward, and its output is read before any tab could re-key or push anything; then A's
      // tab opens the prepared board. Even cycles: A's tab is the joiner that triggers it (held with
      // PREPARING, admitted when ready), and the keys are read from the snapshot after it converged.
      rollForwards++
      rfIndexProblems = null
      if (rollForwards % 2 === 1) {
        rfTrigger = 'snapshot-route'
        if (!syncRunning) {
          await stack.restartSync()
          syncRunning = true
        }
        const snap = await harness.readSnapshot(stack, boardId)
        rfIndexProblems = indexProblems(snap.elements as unknown as Record<string, unknown>[])
      } else rfTrigger = 'joiner'
      await open(boardId)
    },
    afterRollForward: async (boardId) => {
      const b = browser as O3BrowserProcess
      const conv = await harness.converged(stack, boardId, [b], { timeoutMs: 60_000 })
      return {
        converged: conv.ok,
        pushes: rec ? await rec.count() : -1,
        ops: rec ? await opSummary(rec) : [],
        trigger: rfTrigger,
        indexProblems:
          rfIndexProblems ?? indexProblems(conv.snapshot.elements as unknown as Record<string, unknown>[]),
        snapshotHash: conv.snapshot.hash,
        elements: conv.snapshot.elements.length,
      }
    },
    close: async () => {
      await browser?.close()
      browser = null
    },
  }
}
