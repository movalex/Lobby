// The §8.4 measurement kit on a real spike B stack (docs/EXCALIDRAW-MIGRATION.md §8.4, same method as spike
// A14/A13: e2e/spike/fixtures/perf-kit.ts's headless shell with GPU flags, 1536x864 at DPR 1.25, 3 pans
// of 3 s per view plus a traced one): cold opens of the board route through the real stack, the camera
// hooks perf-kit's pan drives (on O3's facade side channel, i.e. on CanvasPort's viewport), and a remote
// writer (a raw Node socket with its own api ticket) for "with sync running".
import type { Browser, Page } from '@playwright/test'
import type { WireElement } from '../../../packages/canvas-schema/src/elements.ts'
import type { Ack } from '../../../packages/canvas-schema/src/protocol.ts'
import { openNodeSocket } from '../../load/seed.ts'
import { DPR, VIEWPORT } from '../../spike/fixtures/perf-kit.ts'
import { isForeign } from '../../spike/support/watch.ts'
import { signInContext } from '../../tests/support/api.ts'
import { waitBoardReady } from './browsers.ts'
import { apiTicket } from './seed.ts'
import type { O3Stack } from './stack.ts'
import type { DevUser } from './types.ts'

export interface OpenTiming {
  /** navigation start → the facade installed and the engine core's welcome applied */
  readonly readyMs: number
  /** → two animation frames later (the scene painted) */
  readonly paintedMs: number
  /** → document.fonts.ready */
  readonly fontsMs: number
  /** the ticket request as the page made it (resource timing), if seen */
  readonly ticketMs: number | null
  readonly elements: number
}

/** One cold open in a fresh context of `browser` (empty HTTP cache), signed in as `user`. */
export async function coldOpen(
  browser: Browser,
  stack: O3Stack,
  user: DevUser,
  boardId: string,
): Promise<OpenTiming> {
  const context = await browser.newContext({
    baseURL: stack.ports.webUrl,
    viewport: VIEWPORT,
    deviceScaleFactor: DPR,
  })
  try {
    await context.route(
      (u) => isForeign(u.href),
      (r) => r.abort('blockedbyclient'),
    )
    await signInContext(context, user.handle, user.name)
    const page = await context.newPage()
    const t0 = Date.now()
    await page.goto(`/b/${encodeURIComponent(boardId)}`)
    await waitBoardReady(page, 180_000)
    const readyMs = Date.now() - t0
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
    const paintedMs = Date.now() - t0
    await page.evaluate(() => document.fonts.ready.then(() => undefined))
    const fontsMs = Date.now() - t0
    const extra = await page.evaluate(() => {
      const t = performance
        .getEntriesByType('resource')
        .find((e) => /\/api\/boards\/[^/]+\/ticket/.test(e.name))
      return {
        ticketMs: t ? Math.round(t.duration) : null,
        elements: window.lobbyCanvas?.items().length ?? 0,
      }
    })
    return { readyMs, paintedMs, fontsMs, ...extra }
  } finally {
    await context.close()
  }
}

/** perf-kit's pan hooks (`__panStart/__panBy/__panEnd`) on the facade's camera (CanvasPort.viewport). */
export async function installCamera(page: Page): Promise<void> {
  await page.evaluate(() => {
    const h = window.__lobbyHarness
    if (!h) throw new Error('no __lobbyHarness on this page')
    const w = window as unknown as Record<string, unknown>
    let o = h.viewport()
    w.__panStart = () => {
      o = h.viewport()
    }
    w.__panBy = (dx: number, dy: number) => h.setViewport({ x: o.x - dx / o.zoom, y: o.y - dy / o.zoom })
    w.__panEnd = () => h.setViewport({ x: o.x, y: o.y })
  })
}

export type View = 'fit' | '0.25' | '1'

/** Sets a view: Lobby's whole-board fit, or zoom 0.25 / 1 on frame 0; returns the camera it got. */
export async function setView(
  page: Page,
  view: View,
  frame0: { x: number; y: number; width: number; height: number },
) {
  return page.evaluate(
    async ({ view, f }) => {
      const h = window.__lobbyHarness
      if (!h) throw new Error('no __lobbyHarness')
      const vp = h.viewport()
      if (view === 'fit') h.fit()
      else if (view === '0.25') {
        const z = 0.25
        h.setViewport({
          zoom: z,
          x: f.x + f.width / 2 - vp.width / z / 2,
          y: f.y + f.height / 2 - vp.height / z / 2,
        })
      } else h.setViewport({ zoom: 1, x: f.x - 20, y: f.y - 20 })
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      const after = h.viewport()
      const items = window.lobbyCanvas?.items() ?? []
      const visible = items.filter(
        (e) =>
          e.x + e.width >= after.x &&
          e.x <= after.x + after.width &&
          e.y + e.height >= after.y &&
          e.y <= after.y + after.height,
      ).length
      return { zoom: after.zoom, visible, total: items.length }
    },
    { view, f: frame0 },
  )
}

/**
 * A remote writer: its own session (a raw Node socket, the owner's api ticket, another tab) moving one
 * note and its label back and forth at `hz` for as long as it runs, from the stored versions (snapshot,
 * then acks). Returns stop(), which resolves with how many pushes were acked and their ack times.
 */
export async function remoteWriter(
  stack: O3Stack,
  user: DevUser,
  boardId: string,
  noteId: string,
  hz: number,
): Promise<{
  stop(): Promise<{ pushes: number; acked: number; ackMs: number[]; sentAt: Map<number, number> }>
}> {
  const { ticket } = await apiTicket(stack, user, boardId)
  const sock = await openNodeSocket(
    stack.ports.syncUrl,
    boardId,
    ticket,
    `o3-writer-${Date.now().toString(36)}`,
  )
  const snap = sock.welcome.reset ? await sock.snapshot() : null
  const byId = new Map<string, WireElement>((snap?.elements ?? []).map((e) => [e.id, e]))
  for (const op of sock.welcome.catchUp ?? []) if (op.k === 'c') byId.set(op.el.id, op.el)
  const note = byId.get(noteId)
  const labelId = (note?.boundElements ?? []).find((r) => r.type === 'text')?.id
  const label = labelId ? byId.get(labelId) : undefined
  if (!note) throw new Error(`writer: no note ${noteId}`)
  const v = new Map<string, number>([[noteId, note.version]])
  if (label) v.set(label.id, label.version)
  let seq = 0
  let clock = sock.welcome.clock
  let stopped = false
  let acked = 0
  const ackMs: number[] = []
  const sentAt = new Map<number, number>()
  let dx = 12
  const loop = (async () => {
    while (!stopped) {
      const s = ++seq
      const ops: unknown[] = [
        { k: 'p', id: noteId, pv: v.get(noteId), g: { pos: { x: note.x + dx, y: note.y } } },
      ]
      if (label)
        ops.push({
          k: 'p',
          id: label.id,
          pv: v.get(label.id),
          g: { layout: { x: label.x + dx, y: label.y } },
        })
      sentAt.set(s, Date.now())
      await sock.send({ type: 'push', seq: s, base: clock, ops } as never)
      const ack = (await sock.next('ack', 30_000)) as Ack
      clock = Math.max(clock, ack.clock)
      ackMs.push(Date.now() - (sentAt.get(ack.seq) ?? Date.now()))
      for (const r of ack.r) if (r.ok) v.set(r.id, r.v)
      acked++
      dx = -dx
      await new Promise((r) => setTimeout(r, 1_000 / hz))
    }
  })()
  return {
    async stop() {
      stopped = true
      await loop.catch(() => undefined)
      sock.close()
      return { pushes: seq, acked, ackMs, sentAt }
    },
  }
}
