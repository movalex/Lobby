// N1-4 (wave N, the review): a chunked cold open (CHUNKED_APPLY, turned on for this page: it ships off) whose socket is
// cut while the chunks go in. The core keeps the chunks already shown and asks for everything again at the next
// welcome (engine.ts abortChunks); the board page never presents that part of the board as the board: the skeleton
// covers it ('Reconnecting to board…') until the next welcome, which installs the whole board (one apply over the kept
// chunks). The tab is receive-only throughout: it pushes nothing.
import { expect, pushedOps, test, waitForCanvas } from '../tests/support/canvas.ts'
import { BIG_BOARD_ELEMENTS, seedBigBoard, speedFlags } from './support/big-board.ts'

interface Cut {
  cut: boolean
  appliedAtCut: number | null
  partialSeen: boolean
  coverText: string | null
}

test('N1-4: a chunked install cut short is covered until the next welcome, which brings the whole board', async ({
  canvasSession,
  board,
}) => {
  test.setTimeout(900_000)
  const a = await canvasSession('alice')
  const seeded = await seedBigBoard(a.page, board)
  expect(seeded.elements).toBe(BIG_BOARD_ELEMENTS)
  await speedFlags(a.context, { CHUNKED_APPLY: true })
  // the page's board socket, cut (a non-terminal close) at the first frame that shows a chunk
  await a.context.addInitScript(() => {
    const w = window as unknown as {
      __n1cut: Cut
      __n1sock?: WebSocket
      __lobbyBoard?: {
        api?: { getSceneElements(): readonly unknown[] }
        session: { snapshot: { applying?: boolean; partial?: boolean } }
      }
    }
    w.__n1cut = { cut: false, appliedAtCut: null, partialSeen: false, coverText: null }
    const Native = window.WebSocket
    class Captured extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        if (String(url).includes('/connect/')) w.__n1sock = this
      }
    }
    window.WebSocket = Captured as typeof WebSocket
    const tick = () => {
      const s = w.__lobbyBoard?.session.snapshot
      if (s?.applying && !w.__n1cut.cut && w.__n1sock) {
        w.__n1cut.cut = true
        w.__n1cut.appliedAtCut = w.__lobbyBoard?.api?.getSceneElements().length ?? null
        w.__n1sock.close(4000, 'e2e cut')
      }
      if (s?.partial) w.__n1cut.partialSeen = true
      if (w.__n1cut.partialSeen && w.__n1cut.coverText === null) {
        const cover = document.querySelector('[data-testid="sync-loading"]')
        if (cover) w.__n1cut.coverText = cover.textContent
      }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
  // a slower CPU (4x) while the board installs: the chunks span more frames, so the cut lands among them
  const cdp = await a.context.newCDPSession(a.page)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
  await a.page.goto(`/b/${board}?nocache=1`)
  await waitForCanvas(a.page, 300_000)
  // the next welcome brings the whole board: editable, all of it, the cover gone
  await a.page.waitForFunction(
    (n) => {
      const w = window as unknown as {
        lobbyCanvas?: { items(): unknown[]; saveState(): { state: string } }
        __lobbyBoard?: { session: { snapshot: { welcomed: boolean; readonly: boolean; partial?: boolean } } }
      }
      const s = w.__lobbyBoard?.session.snapshot
      return (
        !!s &&
        s.welcomed &&
        !s.readonly &&
        !s.partial &&
        (w.lobbyCanvas?.items().length ?? 0) >= n &&
        w.lobbyCanvas?.saveState().state === 'saved'
      )
    },
    BIG_BOARD_ELEMENTS - 1,
    { timeout: 300_000, polling: 250 },
  )
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
  await cdp.detach()
  const cut = await a.page.evaluate(() => (window as unknown as { __n1cut: Cut }).__n1cut)
  const how = await a.page.evaluate(
    () =>
      (window as unknown as { __lobbyBoard: { core: { resetApply: string | null } } }).__lobbyBoard.core
        .resetApply,
  )
  console.log(`[n1] n1-chunk-abort: ${JSON.stringify({ cut, resetApply: how })}`)
  expect(cut.cut, 'the socket was cut while the chunks went in').toBe(true)
  expect(cut.appliedAtCut ?? BIG_BOARD_ELEMENTS, 'part of the board was showing').toBeLessThan(
    BIG_BOARD_ELEMENTS,
  )
  expect(cut.partialSeen, 'the install was cut short (part of the board kept)').toBe(true)
  expect(cut.coverText ?? '', 'the skeleton covered the part shown').toContain('Reconnecting to board')
  await expect(a.page.getByTestId('sync-loading')).toBeHidden()
  // the reconnect's welcome was one apply over the kept chunks (no chunked install over a scene that shows a copy)
  expect(how).toBe('full')
  expect(await pushedOps(a.page), 'a receive-only tab pushed nothing').toEqual([])
})
