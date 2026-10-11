// N1-1 (wave N, PERF-3a): the 10k board's snapshot is decoded in the module worker
// (apps/web/src/canvas/sync/transport/snapshot.worker.ts), so no long task of the page's main thread over 200 ms falls
// in the decode: between the binary frame's arrival (`lobby.snapshot.received`) and its decoded frame reaching the
// core (`lobby.snapshot.decoded`), only the slices' short structured clones run on the page. The board is the 10k
// fixture (e2e/excalidraw/support/big-board.ts), seeded through the real protocol; the open is a cold one
// (`?nocache=1`: the snapshot is the room's). The numbers are attached (n1-worker-decode.json).
import { writeFileSync } from 'node:fs'
import { expect, test, waitForCanvas } from '../tests/support/canvas.ts'
import { BIG_BOARD_ELEMENTS, readOpen, seedBigBoard, watchOpen } from './support/big-board.ts'

test('N1-1: the 10k board decodes in the worker: no main-thread long task over 200 ms during the decode', async ({
  canvasSession,
  board,
}, testInfo) => {
  test.setTimeout(900_000)
  const a = await canvasSession('alice')
  const seeded = await seedBigBoard(a.page, board)
  expect(seeded.elements).toBe(BIG_BOARD_ELEMENTS)

  await watchOpen(a.context)
  const runs: Record<string, unknown>[] = []
  for (let i = 0; i < 2; i++) {
    await a.page.goto(`/b/${board}?nocache=1`)
    await waitForCanvas(a.page, 300_000)
    await a.page.waitForFunction(
      (n) =>
        ((window as unknown as { lobbyCanvas?: { items(): unknown[] } }).lobbyCanvas?.items().length ?? 0) >=
        n,
      BIG_BOARD_ELEMENTS - 1,
      { timeout: 300_000, polling: 250 },
    )
    const o = await readOpen(a.page)
    const side = await a.page.evaluate(
      () =>
        (window as unknown as { __lobbyBoard?: { session: { decodeSide: string | null } } }).__lobbyBoard
          ?.session.decodeSide ?? null,
    )
    const received = o.marks['lobby.snapshot.received']
    const decoded = o.marks['lobby.snapshot.decoded']
    expect(received, 'the snapshot frame arrived').toBeDefined()
    expect(decoded, 'and was decoded').toBeDefined()
    const inDecode = o.longTasks.filter(
      (t) => t.start < (decoded as number) && t.start + t.duration > (received as number),
    )
    const longest = Math.max(0, ...inDecode.map((t) => t.duration))
    runs.push({
      side,
      decodeMs: Math.round((decoded as number) - (received as number)),
      longTasksInDecode: inDecode.map((t) => Math.round(t.duration)),
      longestInDecodeMs: Math.round(longest),
      longestOverallMs: Math.round(Math.max(0, ...o.longTasks.map((t) => t.duration))),
      elements: o.elements,
    })
    expect(side, 'decoded in the worker').toBe('worker')
    expect(longest, 'no main-thread long task over 200 ms in the decode').toBeLessThanOrEqual(200)
  }
  const evidence = { board: { elements: seeded.elements, seedMs: seeded.ms }, runs }
  // the evidence on disk (the output folder) and in the log, as navigation-lod-fps.spec.ts keeps its own
  writeFileSync(testInfo.outputPath('n1-worker-decode.json'), JSON.stringify(evidence, null, 2))
  console.log(`[n1] n1-worker-decode: ${JSON.stringify(evidence)}`)
  await testInfo.attach('n1-worker-decode.json', {
    body: JSON.stringify(evidence, null, 2),
    contentType: 'application/json',
  })
  testInfo.annotations.push({ type: 'n1 worker decode', description: JSON.stringify(runs) })
})
