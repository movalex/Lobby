// Wave M, W6 review (M6-1 / M6-2 perf): a measurement, not a gate (M6_PERF=1 runs it; skipped otherwise).
//
// A 5,000- and a 10,000-element board (frames of sticky notes with their labels, e2e/load/boards.ts, pushed through
// the real protocol: e2e/load/seed.ts), opened by a full page load under a 4x slower CPU (CDP), three times each:
//  - cold: `?nocache=1` (no cache read, paint or resume: the open as it was before W6), its snapshot welcome;
//  - warm: this device's copy painted, then the catch-up welcome.
// Per open, in ms since the navigation started: the first elements on the canvas, and the canvas editable (the
// welcome in, not read-only, the board ready). Per board: a cache write's main-thread time (the record built in the
// call, whole-board clone, URL scan and hash, plus the IndexedDB put's structured clone) and the record's size.
// The numbers are attached to the test as m6-perf-<n>.json. M6_PERF_NET=fast4g adds Chrome's Fast 4G network.
//
//   M6_PERF=1 E2E_PORT_BASE=<base> pnpm exec playwright test excalidraw/m6-warm-open-perf.spec.ts --project=chromium --workers=1

import type { BrowserContext, Page } from '@playwright/test'
import { expect, test, waitForCanvas } from '../tests/support/canvas.ts'

test.skip(!process.env.M6_PERF, 'a measurement: M6_PERF=1 runs it')

interface OpenTimes {
  firstElements: number | null
  editable: number | null
  cachedPaint: number | null
  elements: number
  /** any `m6.*` performance marks the build makes (a diagnosis build adds them; none otherwise) */
  marks: [string, number][]
}

/** Before every page load: when the canvas first had elements, and when it became editable (each frame). */
async function watchOpens(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const w = window as unknown as {
      __m6perf: { firstElements: number | null; editable: number | null }
      __lobbyBoard?: {
        api?: { getSceneElements(): readonly unknown[] }
        session: { snapshot: { welcomed: boolean; readonly: boolean; phase: string } }
      }
    }
    w.__m6perf = { firstElements: null, editable: null }
    const tick = () => {
      const b = w.__lobbyBoard
      if (b) {
        if (w.__m6perf.firstElements === null && (b.api?.getSceneElements().length ?? 0) > 0)
          w.__m6perf.firstElements = performance.now()
        const s = b.session.snapshot
        if (w.__m6perf.editable === null && s.welcomed && !s.readonly && s.phase === 'ready')
          w.__m6perf.editable = performance.now()
      }
      if (w.__m6perf.editable === null) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })
}

/** M6_PERF_NET=fast4g: Chrome's "Fast 4G" too (9 Mbit/s down, 1.5 up, 60 ms), as k1-open-fast.spec.ts. */
const FAST_4G = process.env.M6_PERF_NET === 'fast4g'

async function cpu4x(context: BrowserContext, page: Page): Promise<void> {
  const cdp = await context.newCDPSession(page)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
  if (FAST_4G) {
    await cdp.send('Network.enable')
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 60,
      downloadThroughput: (9_000 * 1024) / 8,
      uploadThroughput: (1_500 * 1024) / 8,
    })
  }
}

async function openOnce(page: Page, url: string): Promise<OpenTimes> {
  await page.goto(url)
  await waitForCanvas(page, 600_000)
  await page.waitForFunction(
    () => (window as unknown as { __m6perf: { editable: number | null } }).__m6perf.editable !== null,
    undefined,
    { timeout: 600_000 },
  )
  return page.evaluate(() => {
    const w = window as unknown as {
      __m6perf: { firstElements: number | null; editable: number | null }
      __lobbyBoard?: { api?: { getSceneElements(): readonly unknown[] } }
    }
    const mark = performance.getEntriesByName('lobby.cachedPaint')[0]
    return {
      firstElements: w.__m6perf.firstElements,
      editable: w.__m6perf.editable,
      cachedPaint: mark ? mark.startTime : null,
      elements: w.__lobbyBoard?.api?.getSceneElements().length ?? 0,
      marks: performance
        .getEntriesByType('mark')
        .filter((m) => m.name.startsWith('m6.'))
        .map((m) => [m.name, Math.round(m.startTime)] as [string, number]),
    }
  })
}

/** A cache write now, through the session (its main-thread part, and the whole write with IndexedDB). */
const timedFlush = (page: Page) =>
  page.evaluate(async () => {
    const b = (window as unknown as { __lobbyBoard?: { session: { flushBoardCache(): Promise<boolean> } } })
      .__lobbyBoard
    if (!b) throw new Error('no window.__lobbyBoard')
    const t0 = performance.now()
    const p = b.session.flushBoardCache()
    const sync = performance.now() - t0
    const kept = await p
    return { kept, syncMs: sync, totalMs: performance.now() - t0 }
  })

const recordBytes = (page: Page, key: string) =>
  page.evaluate(
    (k) =>
      new Promise<number | null>((resolve, reject) => {
        const req = indexedDB.open('lobby-board-cache', 1)
        req.onerror = () => reject(req.error)
        req.onsuccess = () => {
          const db = req.result
          const get = db.transaction('index', 'readonly').objectStore('index').get(k)
          get.onsuccess = () => {
            db.close()
            resolve((get.result as { bytes?: number } | undefined)?.bytes ?? null)
          }
          get.onerror = () => reject(get.error)
        }
      }),
    key,
  )

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? (s[Math.floor((s.length - 1) / 2)] as number) : Number.NaN
}

for (const n of [5_000, 10_000])
  test(`M6 perf: cold and warm open of a ${n}-element board at CPU 4x`, async ({
    canvasSession,
    board,
  }, testInfo) => {
    test.setTimeout(1_800_000)
    const a = await canvasSession('alice')
    // the board: frames of notes, a note and its label being two elements
    const [{ generateBoard }, { seedElements }, { forgeSession }] = await Promise.all([
      import('../load/boards.ts'),
      import('../load/seed.ts'),
      import('../tests/support/excalidraw.ts'),
    ])
    const frames = n / 500
    const gen = generateBoard({
      id: board,
      kind: 'heavy',
      frames,
      notes: (n - frames) / 2,
      images: 0,
      arrows: 0,
    })
    expect(gen.elements.length).toBe(n)
    const { socket, welcome } = await forgeSession(a.page, board)
    let pushed: Awaited<ReturnType<typeof seedElements>>
    try {
      pushed = await seedElements(socket, gen.elements, welcome.clock)
    } finally {
      await socket.close()
    }
    expect(pushed.ok, JSON.stringify(pushed.rejected)).toBe(pushed.ops)

    await watchOpens(a.context)
    await cpu4x(a.context, a.page)
    const cold: OpenTimes[] = []
    const warm: OpenTimes[] = []
    const writes: { syncMs: number; totalMs: number }[] = []
    for (let i = 0; i < 3; i++) {
      cold.push(await openOnce(a.page, `/b/${board}?nocache=1`))
      // a copy for the warm open (the session's own write, timed)
      await a.page.goto(`/b/${board}`)
      await waitForCanvas(a.page, 600_000)
      const w = await timedFlush(a.page)
      expect(w.kept).toBe(true)
      writes.push(w)
      warm.push(await openOnce(a.page, `/b/${board}`))
    }
    for (const o of [...cold, ...warm]) expect(o.elements).toBe(n)
    for (const o of warm) expect(o.cachedPaint).not.toBeNull()
    const bytes = await recordBytes(a.page, `${board}|${a.id}`)
    const pick = (list: OpenTimes[], k: 'firstElements' | 'editable') =>
      median(list.map((o) => o[k] ?? Number.NaN))
    const evidence = {
      elements: n,
      cpu: '4x',
      network: FAST_4G ? 'Fast 4G' : 'loopback',
      runs: 3,
      cold: { firstElementsMs: pick(cold, 'firstElements'), editableMs: pick(cold, 'editable') },
      warm: { firstElementsMs: pick(warm, 'firstElements'), editableMs: pick(warm, 'editable') },
      write: {
        syncMs: median(writes.map((w) => w.syncMs)),
        totalMs: median(writes.map((w) => w.totalMs)),
      },
      recordBytes: bytes,
      raw: { cold, warm, writes },
    }
    await testInfo.attach(`m6-perf-${n}.json`, {
      body: JSON.stringify(evidence, null, 2),
      contentType: 'application/json',
    })
    testInfo.annotations.push({
      type: `m6 perf ${n}`,
      description: JSON.stringify({ ...evidence, raw: undefined }),
    })
  })
