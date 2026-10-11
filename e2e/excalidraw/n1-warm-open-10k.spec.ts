// N1-3 (wave N): a warm open of the 10k board (e2e/excalidraw/support/big-board.ts) under a 4x slower CPU and Chrome's
// Fast 4G network (CDP), as m6-warm-open-perf.spec.ts measures wave M's: the device's copy is painted (read-only), then
// the reset welcome's snapshot is applied as a diff against it (DIFF_APPLY): every element its row equals stays the
// scene's object, so nothing is rebuilt and Excalidraw's shape cache stays warm. Per open (three, after one cold open
// that writes the copy), from the navigation's start:
//  - painted (`lobby.cachedPaint`): target at or under 1.5 s;
//  - editable (welcomed, not read-only, ready, Saved): at or under 3.5 s;
//  - no main-thread long task over 250 ms after the paint (until editable).
// Medians are asserted; a measurement (N1_PERF=1 runs it), not a laptop number. Attached as n1-warm-open-10k.json.
// N1_PERF_NET=loopback leaves the network alone.
//
//   N1_PERF=1 E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/n1-warm-open-10k.spec.ts --project=chromium --workers=1
import { writeFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { expect, test, waitForCanvas } from '../tests/support/canvas.ts'
import { BIG_BOARD_ELEMENTS, median, readOpen, seedBigBoard, watchOpen } from './support/big-board.ts'

test.skip(process.env.N1_PERF !== '1', 'a measurement: N1_PERF=1 runs it')

const flushBoardCache = (page: Page): Promise<boolean> =>
  page.evaluate(() => {
    const b = (window as unknown as { __lobbyBoard?: { session: { flushBoardCache(): Promise<boolean> } } })
      .__lobbyBoard
    if (!b) throw new Error('no window.__lobbyBoard')
    return b.session.flushBoardCache()
  })

test('N1-3: a warm open of the 10k board at CPU 4x and Fast 4G: painted by 1.5 s, editable by 3.5 s, no long task over 250 ms after the paint', async ({
  canvasSession,
  board,
}, testInfo) => {
  test.setTimeout(1_800_000)
  const a = await canvasSession('alice')
  const seeded = await seedBigBoard(a.page, board)
  expect(seeded.elements).toBe(BIG_BOARD_ELEMENTS)
  await watchOpen(a.context)
  const cdp = await a.context.newCDPSession(a.page)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
  const net = process.env.N1_PERF_NET ?? 'fast4g'
  if (net === 'fast4g') {
    await cdp.send('Network.enable')
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 60,
      downloadThroughput: (9_000 * 1024) / 8,
      uploadThroughput: (1_500 * 1024) / 8,
    })
  }
  const editable = () =>
    a.page.waitForFunction(
      () => (window as unknown as { __n1?: { editable: number | null } }).__n1?.editable != null,
      undefined,
      { timeout: 600_000, polling: 250 },
    )
  // one open writes this device's copy
  await a.page.goto(`/b/${board}`)
  await waitForCanvas(a.page, 600_000)
  await editable()
  expect(await flushBoardCache(a.page)).toBe(true)
  const runs: Record<string, number | null | string>[] = []
  for (let i = 0; i < 3; i++) {
    await a.page.goto(`/b/${board}`)
    await waitForCanvas(a.page, 600_000)
    await editable()
    const o = await readOpen(a.page)
    const painted = o.marks['lobby.cachedPaint'] ?? null
    const longest = Math.max(
      0,
      ...o.longTasks
        .filter(
          (t) => painted !== null && t.start + t.duration > painted && t.start < (o.editable ?? Infinity),
        )
        .map((t) => t.duration),
    )
    const how = await a.page.evaluate(
      () =>
        (window as unknown as { __lobbyBoard?: { core: { resetApply: string | null } } }).__lobbyBoard?.core
          .resetApply ?? null,
    )
    runs.push({
      paintedMs: painted === null ? null : Math.round(painted),
      editableMs: o.editable === null ? null : Math.round(o.editable),
      longestAfterPaintMs: Math.round(longest),
      apply: how,
      elements: o.elements,
    })
    expect(painted, 'the cached copy was painted').not.toBeNull()
    expect(how, 'the reset welcome was a diff').toBe('diff')
    // the next warm open needs this one's copy written (nothing new: the copy stands)
    await flushBoardCache(a.page)
  }
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
  const pick = (k: string) => median(runs.map((r) => (r[k] ?? Number.NaN) as number))
  const evidence = {
    cpu: '4x',
    network: net === 'fast4g' ? 'Fast 4G' : 'loopback',
    medians: {
      paintedMs: pick('paintedMs'),
      editableMs: pick('editableMs'),
      longestAfterPaintMs: pick('longestAfterPaintMs'),
    },
    runs,
  }
  // the evidence on disk (the output folder) and in the log, as navigation-lod-fps.spec.ts keeps its own
  writeFileSync(testInfo.outputPath('n1-warm-open-10k.json'), JSON.stringify(evidence, null, 2))
  console.log(`[n1] n1-warm-open-10k: ${JSON.stringify(evidence)}`)
  await testInfo.attach('n1-warm-open-10k.json', {
    body: JSON.stringify(evidence, null, 2),
    contentType: 'application/json',
  })
  testInfo.annotations.push({ type: 'n1 warm open 10k', description: JSON.stringify(evidence.medians) })
  expect(evidence.medians.paintedMs, 'painted').toBeLessThanOrEqual(1_500)
  expect(evidence.medians.editableMs, 'editable').toBeLessThanOrEqual(3_500)
  expect(evidence.medians.longestAfterPaintMs, 'the longest task after the paint').toBeLessThanOrEqual(250)
})
