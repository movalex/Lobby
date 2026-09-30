// A measurement, not part of the regular run (LOBBY_MEASURE_EXPORT=1): the plan (docs/EXCALIDRAW-MIGRATION.md
// §2.10.4) asks wave 3e to report the size of an SVG export with Lobby's own font embedding (whole woff2
// files whose ranges cover the text, no subsetting) on the heavy board's largest frame. The heavy board
// is the perf seed's (e2e/perf/seed.ts HEAVY: 20 frames, 4,500 notes, 200 images). Also records the PNG
// (2×) and PDF-page bitmap times of that frame. Results are test annotations.
import { HEAVY, seedHeavyExcalidrawBoard } from '../perf/seed.ts'
import { expect, items, test } from '../tests/support/canvas.ts'

test.skip(process.env.LOBBY_MEASURE_EXPORT !== '1', 'a measurement: LOBBY_MEASURE_EXPORT=1')

test('heavy board: SVG, PNG and bitmap export of the largest frame (sizes and times)', async ({
  canvasSession,
  board,
}) => {
  test.setTimeout(1_200_000)
  const a = await canvasSession('alice')
  const lines: string[] = []
  await seedHeavyExcalidrawBoard(a.page, board, HEAVY, (s) => lines.push(s))
  test.info().annotations.push({ type: 'seed', description: lines.join(' | ') })
  const all = await items(a.page)
  const frames = all.filter((e) => e.type === 'frame')
  expect(frames.length).toBe(HEAVY.frames)
  // the largest frame by the elements it holds
  const count = new Map<string, number>()
  for (const e of all) if (e.frameId) count.set(e.frameId, (count.get(e.frameId) ?? 0) + 1)
  const largest = [...count.entries()].sort((x, y) => y[1] - x[1])[0]?.[0] ?? frames[0]?.id ?? ''
  const result = await a.page.evaluate(async (frameId) => {
    type Ex = {
      svg(o: object): Promise<string>
      png(o: object): Promise<Blob>
      canvas(o: object): Promise<HTMLCanvasElement>
    }
    const ex = (window as unknown as { __lobbyBoard: { canvas: { export: Ex } } }).__lobbyBoard.canvas.export
    const t0 = performance.now()
    const svgPreviews = await ex.svg({ frameId, files: 'display' })
    const t1 = performance.now()
    const svgOriginals = await ex.svg({ frameId, files: 'original' })
    const t2 = performance.now()
    const png = await ex.png({ frameId, scale: 2, files: 'original' })
    const t3 = performance.now()
    const bitmap = await ex.canvas({ frameId, scale: 3, files: 'original' })
    const t4 = performance.now()
    const fonts = (svgPreviews.match(/@font-face/g) ?? []).length
    const fontBytes = [...svgPreviews.matchAll(/url\("data:font\/woff2;base64,([^"]+)"\)/g)].reduce(
      (n, m) => n + Math.floor(((m[1] ?? '').length * 3) / 4),
      0,
    )
    return {
      svgPreviewsBytes: new Blob([svgPreviews]).size,
      svgPreviewsMs: Math.round(t1 - t0),
      svgOriginalsBytes: new Blob([svgOriginals]).size,
      svgOriginalsMs: Math.round(t2 - t1),
      fontFaces: fonts,
      fontBytes,
      pngBytes: png.size,
      pngMs: Math.round(t3 - t2),
      bitmap: `${bitmap.width}x${bitmap.height}`,
      bitmapMs: Math.round(t4 - t3),
    }
  }, largest)
  test.info().annotations.push({
    type: 'export',
    description: JSON.stringify({ frame: largest, elements: count.get(largest), ...result }),
  })
  console.log(`HEAVY-EXPORT ${JSON.stringify({ frame: largest, elements: count.get(largest), ...result })}`)
  console.log(`HEAVY-SEED ${lines.join(' | ')}`)
  expect(result.svgPreviewsBytes).toBeGreaterThan(0)
})
