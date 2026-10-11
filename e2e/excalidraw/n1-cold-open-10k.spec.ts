// N1-4 (wave N, PERF-3c): a cold open of the 10k board (e2e/excalidraw/support/big-board.ts) under a 4x slower CPU
// (CDP), three times. The reset welcome's snapshot is installed in chunks of about 1,000 elements, one per frame
// (CHUNKED_APPLY): the first holds the frames and what is in view, so something shows at once. Per open, from the
// page's own timeline (performance.now(), the navigation's start):
//  - the first element on the canvas, after the snapshot frame arrived (`lobby.snapshot.received`) and after its
//    decoded frame reached the core (`lobby.snapshot.decoded`; the decode runs in the worker, N1-1);
//  - the longest main-thread task from the snapshot's arrival to the board being editable (Saved).
// Targets (medians): first content at or under 1.2 s after the snapshot reaches the core, the longest task at or
// under 200 ms. A measurement (N1_PERF=1 runs it), not a laptop number (PERF-laptop stays an owner device check); the
// numbers are attached as n1-cold-open-10k.json. N1_PERF_NET=fast4g adds Chrome's Fast 4G network.
//
//   N1_PERF=1 E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/n1-cold-open-10k.spec.ts --project=chromium --workers=1
import { writeFileSync } from 'node:fs'
import { logProfile, startProfile, stopProfile, summarizeProfile } from '../perf/fps.ts'
import { expect, test, waitForCanvas } from '../tests/support/canvas.ts'
import { BIG_BOARD_ELEMENTS, median, readOpen, seedBigBoard, watchOpen } from './support/big-board.ts'

test.skip(process.env.N1_PERF !== '1', 'a measurement: N1_PERF=1 runs it')

test('N1-4: a cold open of the 10k board at CPU 4x: first content soon after the snapshot, no long task over 200 ms', async ({
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
  if (process.env.N1_PERF_NET === 'fast4g') {
    await cdp.send('Network.enable')
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 60,
      downloadThroughput: (9_000 * 1024) / 8,
      uploadThroughput: (1_500 * 1024) / 8,
    })
  }
  const runs: Record<string, number | null>[] = []
  for (let i = 0; i < 3; i++) {
    await a.page.goto(`/b/${board}?nocache=1`)
    await waitForCanvas(a.page, 600_000)
    await a.page.waitForFunction(
      () => (window as unknown as { __n1?: { editable: number | null } }).__n1?.editable != null,
      undefined,
      { timeout: 600_000, polling: 250 },
    )
    const o = await readOpen(a.page)
    const received = o.marks['lobby.snapshot.received'] ?? null
    const decoded = o.marks['lobby.snapshot.decoded'] ?? null
    const after = (t: number | null) =>
      t === null || o.firstElements === null ? null : Math.round(o.firstElements - t)
    const from = received ?? 0
    const longest = Math.max(
      0,
      ...o.longTasks
        .filter((t) => t.start + t.duration > from && t.start < (o.editable ?? Infinity))
        .map((t) => t.duration),
    )
    runs.push({
      firstElementsMs: o.firstElements === null ? null : Math.round(o.firstElements),
      editableMs: o.editable === null ? null : Math.round(o.editable),
      snapshotReceivedMs: received === null ? null : Math.round(received),
      snapshotDecodedMs: decoded === null ? null : Math.round(decoded),
      firstAfterReceivedMs: after(received),
      firstAfterDecodedMs: after(decoded),
      longestTaskMs: Math.round(longest),
      marks: Object.entries(o.marks)
        .map(([k, v]) => `${k.slice(6)}@${Math.round(v)}`)
        .join(' ') as never,
      longTasks: o.longTasks
        .filter((t) => t.duration >= 100)
        .map((t) => `${Math.round(t.start)}+${Math.round(t.duration)}`)
        .join(' ') as unknown as number,
      elements: o.elements,
    })
    expect(o.elements).toBeGreaterThanOrEqual(BIG_BOARD_ELEMENTS - 1)
  }
  // N1_OPEN_PROFILE=1: one more open under the V8 profiler, from the navigation to editable (the top functions logged)
  if (process.env.N1_OPEN_PROFILE === '1') {
    await startProfile(cdp)
    await a.page.goto(`/b/${board}?nocache=1`)
    await waitForCanvas(a.page, 600_000)
    await a.page.waitForFunction(
      () => (window as unknown as { __n1?: { editable: number | null } }).__n1?.editable != null,
      undefined,
      { timeout: 600_000, polling: 250 },
    )
    const profile = await stopProfile(cdp, testInfo.outputPath('cold-open.cpuprofile'))
    logProfile((l) => console.log(`[n1-profile] ${l}`), 'cold open', summarizeProfile(profile, 1), 40)
  }
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
  const pick = (k: string) => median(runs.map((r) => (r[k] ?? Number.NaN) as number))
  const evidence = {
    cpu: '4x',
    network: process.env.N1_PERF_NET === 'fast4g' ? 'Fast 4G' : 'loopback',
    medians: {
      firstAfterReceivedMs: pick('firstAfterReceivedMs'),
      firstAfterDecodedMs: pick('firstAfterDecodedMs'),
      longestTaskMs: pick('longestTaskMs'),
      editableMs: pick('editableMs'),
    },
    runs,
  }
  // the evidence on disk (the output folder) and in the log, as navigation-lod-fps.spec.ts keeps its own
  writeFileSync(testInfo.outputPath('n1-cold-open-10k.json'), JSON.stringify(evidence, null, 2))
  console.log(`[n1] n1-cold-open-10k: ${JSON.stringify(evidence)}`)
  await testInfo.attach('n1-cold-open-10k.json', {
    body: JSON.stringify(evidence, null, 2),
    contentType: 'application/json',
  })
  testInfo.annotations.push({ type: 'n1 cold open 10k', description: JSON.stringify(evidence.medians) })
  expect(
    evidence.medians.firstAfterDecodedMs,
    'first content after the snapshot reached the core',
  ).toBeLessThanOrEqual(1_200)
  expect(evidence.medians.longestTaskMs, 'the longest main-thread task').toBeLessThanOrEqual(200)
})
