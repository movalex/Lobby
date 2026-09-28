import { expect, test } from '@playwright/test'
import type { LabExtra } from '../fixtures/render-types.ts'
import { openSpike } from '../support/page.ts'
import { watchPage } from '../support/watch.ts'

// A9 (docs/EXCALIDRAW-MIGRATION.md §8.2, E5 in §2.5.5): loading every font changes no element version.
// A scene with text in every family the package defines (FONT_FAMILY: Virgil 1, Helvetica 2, Cascadia 3,
// Excalifont 5, Nunito 6, Lilita One 7, Comic Shanns 8, Liberation Sans 9, Assistant 10), Chinese text in
// Excalifont (the Xiaolai CJK fallback), emoji (the Segoe UI Emoji fallback), and sticky notes with
// labels in Nunito and Comic Shanns, is applied the way the sync adapter applies a server scene
// (updateScene, captureUpdate NEVER), cold: no font loaded yet. Then every font loads (lazily on first
// draw, then through Fonts.loadElementsFonts, then through exportToSvg's font inlining).
// Pass: 0 element version changes, 0 onChange ops.

const SAMPLE = 'Lobby Ag 0123 — quick brown fox'

test('loading every font changes no element version (0 ops)', async ({ page }) => {
  const watch = watchPage(page)
  await openSpike(page, 'render-lab')
  const families = await page.evaluate(
    () => ((window.__lobbySpike as { extra: unknown }).extra as LabExtra).engine.FONT_FAMILY,
  )
  // No font file requested yet (cold): the page has drawn no text.
  const fontRequestsAtStart = watch.requests.filter((u) => u.endsWith('.woff2')).length

  const applied = await page.evaluate(
    ({ families, SAMPLE }) => {
      const extra = window.__lobbySpike?.extra as unknown as LabExtra
      const skeletons: Record<string, unknown>[] = []
      let y = 40
      for (const [name, id] of Object.entries(families)) {
        skeletons.push({
          type: 'text',
          id: `t-${id}`,
          x: 40,
          y,
          text: `${name}: ${SAMPLE}`,
          fontFamily: id,
          fontSize: 28,
        })
        y += 60
      }
      skeletons.push({
        type: 'text',
        id: 't-cjk',
        x: 40,
        y,
        text: '白板 协作 便签 你好世界 Lobby',
        fontFamily: 5,
        fontSize: 28,
      })
      y += 60
      skeletons.push({
        type: 'text',
        id: 't-emoji',
        x: 40,
        y,
        text: 'Notes 🎬 ✅ 🔥 👍',
        fontFamily: 6,
        fontSize: 28,
      })
      skeletons.push({
        type: 'stickynote',
        id: 'n-1',
        x: 900,
        y: 40,
        width: 200,
        height: 200,
        label: { text: 'Nunito note', fontFamily: 6 },
      })
      skeletons.push({
        type: 'stickynote',
        id: 'n-2',
        x: 900,
        y: 280,
        width: 200,
        height: 200,
        label: { text: 'Comic Shanns note', fontFamily: 8 },
      })
      skeletons.push({
        type: 'stickynote',
        id: 'n-3',
        x: 900,
        y: 520,
        width: 200,
        height: 200,
        label: { text: 'Lilita note', fontFamily: 7 },
      })
      const els = extra.engine.convertToExcalidrawElements(skeletons, { regenerateIds: false })
      extra.probe.applyServer(els)
      const api = window.__lobbySpike?.api
      api?.updateScene({ appState: { scrollX: 0, scrollY: 0, zoom: { value: 0.8 } } })
      const scene = api?.getSceneElementsIncludingDeleted() ?? []
      return {
        count: scene.length,
        texts: scene.filter((e) => e.type === 'text').length,
        versions: Object.fromEntries(scene.map((e) => [e.id, e.version])),
        sizes: Object.fromEntries(scene.map((e) => [e.id, [e.width, e.height]])),
      }
    },
    { families, SAMPLE },
  )
  expect(applied.texts).toBe(Object.keys(families).length + 2 + 3)

  // 1. lazy loading on first draw (document.fonts 'loadingdone' → Fonts.onLoaded → redraw)
  await page.waitForTimeout(1500)
  await page.evaluate(() => document.fonts.ready)
  // 2. the export path: Fonts.loadElementsFonts over every text element
  await page.evaluate(async () => {
    const spike = window.__lobbySpike
    const extra = spike?.extra as unknown as LabExtra
    await extra.Fonts.loadElementsFonts(spike?.api?.getSceneElements() ?? [])
  })
  // 3. SVG export inlines (subsets) every font used, in the subset worker
  const svgFonts = await page.evaluate(async () => {
    const spike = window.__lobbySpike
    const extra = spike?.extra as unknown as LabExtra
    const svg = await extra.engine.exportToSvg({
      elements: spike?.api?.getSceneElements() ?? [],
      files: null,
    })
    return (svg.querySelector('style')?.textContent?.match(/@font-face/g) ?? []).length
  })
  await page.waitForTimeout(1000)

  const result = await page.evaluate(
    ({ families, SAMPLE }) => {
      const spike = window.__lobbySpike
      const extra = spike?.extra as unknown as LabExtra
      const scene = spike?.api?.getSceneElementsIncludingDeleted() ?? []
      const loaded = [...document.fonts]
        .filter((f) => f.status === 'loaded')
        .map((f) => f.family.replace(/^"|"$/g, ''))
      const check = Object.fromEntries(
        Object.keys(families).map((name) => [name, document.fonts.check(`28px "${name}"`, SAMPLE)]),
      )
      return {
        ops: extra.probe.ops,
        drift: extra.probe.versionDrift(),
        unknown: [...extra.probe.unknown],
        onChange: extra.probe.onChangeCalls,
        versions: Object.fromEntries(scene.map((e) => [e.id, e.version])),
        sizes: Object.fromEntries(scene.map((e) => [e.id, [e.width, e.height]])),
        loadedFamilies: [...new Set(loaded)].sort(),
        check,
        fontsStatus: document.fonts.status,
      }
    },
    { families, SAMPLE },
  )
  // Why 'Failed to use workers for subsetting' (if logged): import the subset worker's chunk inside a
  // module worker and report the exception (the engine only sees an ErrorEvent without a message).
  const workerProbe = await page.evaluate(async () => {
    const url = performance
      .getEntriesByType('resource')
      .map((e) => e.name)
      .find((n) => /subset-worker\.chunk-[^/]+\.js$/.test(n))
    if (!url) return { url: null, error: 'subset worker chunk never requested' }
    const src = `import(${JSON.stringify(url)}).then(() => postMessage('ok'), (e) => postMessage(String((e && e.stack) || e)))`
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })), {
      type: 'module',
    })
    const msg = await new Promise<string>((resolve) => {
      w.onmessage = (e) => resolve(String(e.data))
      w.onerror = (e) => resolve(`ErrorEvent: ${e.message}`)
      setTimeout(() => resolve('timeout'), 5000)
    })
    w.terminate()
    return { url: new URL(url).pathname, error: msg.split('\n').slice(0, 3).join(' | ') }
  })
  const fontResponses = watch.responses.filter((r) => /\.woff2(\?|$)/.test(r.url))
  const byFamily: Record<string, { ok: number; other: number }> = {}
  for (const r of fontResponses) {
    const fam = /\/fonts\/([^/]+)\//.exec(new URL(r.url).pathname)?.[1] ?? new URL(r.url).host
    byFamily[fam] ??= { ok: 0, other: 0 }
    if (r.status === 200) (byFamily[fam] as { ok: number }).ok++
    else (byFamily[fam] as { other: number }).other++
  }
  const foreign = watch.foreignRequests()
  console.log(
    'A9-METRICS',
    JSON.stringify({
      elements: applied.count,
      fontRequestsAtStart,
      fontFiles: fontResponses.length,
      byFamily,
      loadedFamilies: result.loadedFamilies,
      check: result.check,
      svgFontFaces: svgFonts,
      onChange: result.onChange,
      ops: result.ops.length,
      drift: result.drift.length,
      sizeChanges: Object.keys(applied.sizes).filter(
        (id) => JSON.stringify(applied.sizes[id]) !== JSON.stringify(result.sizes[id]),
      ).length,
      foreign,
      workerProbe,
      consoleErrors: watch.consoleErrors.map((e) => e.slice(0, 160)),
    }),
  )
  // Every self-hosted family was fetched and loaded (Helvetica and Segoe UI Emoji are local fonts).
  for (const fam of ['Virgil', 'Cascadia', 'Excalifont', 'Nunito', 'Lilita', 'ComicShanns', 'Xiaolai']) {
    expect(byFamily[fam]?.ok ?? 0, `${fam} served`).toBeGreaterThan(0)
  }
  for (const name of [
    'Virgil',
    'Cascadia',
    'Excalifont',
    'Nunito',
    'Lilita One',
    'Comic Shanns',
    'Xiaolai',
  ]) {
    expect(result.loadedFamilies, `${name} loaded`).toContain(name)
  }
  // The pass criterion: nothing a sync adapter would push.
  expect(result.ops).toEqual([])
  expect(result.drift).toEqual([])
  expect(result.unknown).toEqual([])
  expect(result.versions).toEqual(applied.versions)
  // Liberation Sans (9) is not self-hosted (plan §2.12): the miss goes to the engine's fallback source,
  // which the host-rewrite plugin turned into the same-origin asset base (A12): two 404s, nothing leaves.
  expect(foreign).toEqual([])
  expect(byFamily.Liberation?.ok ?? 0).toBe(0)
})
