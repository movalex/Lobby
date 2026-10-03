// A smoke run of the Excalidraw heavy seed (e2e/perf/seed.ts `seedHeavyExcalidrawBoard`) on a small board:
// every element lands through the real protocol (images uploaded through the api, tags with their tag
// definitions, comment threads anchored to notes), a second tab and the stored board agree, the layout
// is the heavy board's (15-column note grids inside frames, an image column), and every image LOADS in the
// second tab: each carries its upload's customData.lobby.file as a drop writes it (W5-34), and the canvas
// draws it from a board-scoped derivative. The full-size board (20 frames, 4,500 notes, 200 images) is for
// the perf runs, not this suite.
import { seedHeavyExcalidrawBoard } from '../perf/seed.ts'
import { expect, items, test, zoomToFit } from '../tests/support/canvas.ts'
import { expectServerConverged, serverSnapshot } from '../tests/support/excalidraw.ts'
import { expectLoadedImage } from './media-kit.ts'

test('perf seed: a small heavy board on the Excalidraw engine, through the real protocol', async ({
  canvasSession,
  stack,
  board,
}) => {
  test.setTimeout(240_000)
  const a = await canvasSession('alice')
  const lines: string[] = []
  const spec = { frames: 2, notes: 120, images: 4, comments: 2 }
  const seeded = await seedHeavyExcalidrawBoard(a.page, board, spec, (s) => lines.push(s))
  test.info().annotations.push({ type: 'seed', description: lines.join(' | ') })
  expect(seeded.items).toBe(2 + 120 + 4)
  // every note has its label: 120 more elements than items
  expect(seeded.elements).toBe(seeded.items + 120)
  expect(seeded.frame0Notes).toHaveLength(60)

  const b = await canvasSession('bob')
  await expect.poll(async () => (await items(b.page)).length, { timeout: 60_000 }).toBe(seeded.elements)
  const snap = await expectServerConverged(stack, board, [a.page, b.page])
  const live = snap.elements.filter((e) => !e.isDeleted)
  const count = (t: string) => live.filter((e) => e.type === t).length
  expect([count('frame'), count('stickynote'), count('image'), count('text')]).toEqual([2, 120, 4, 120])
  // every note sits in a frame; every image references an upload of this board
  expect(
    live.filter((e) => e.type === 'stickynote').every((e) => (e as { frameId?: string | null }).frameId),
  ).toBe(true)
  const images = live.filter((e) => e.type === 'image') as unknown as {
    id: string
    fileId: string
    customData?: { lobby?: { file?: Record<string, unknown> } }
  }[]
  expect(images.every((e) => /^ver_/.test(e.fileId))).toBe(true)
  // each stores its upload's facts, as a drop does (the server's canonical copy: asset, version, kind, mime)
  expect(seeded.images).toHaveLength(4)
  for (const up of seeded.images) {
    const el = images.find((e) => e.id === up.id)
    expect(el?.fileId).toBe(up.versionId)
    expect(el?.customData?.lobby?.file).toEqual({
      assetId: up.assetId,
      versionId: up.versionId,
      kind: 'image',
      name: expect.stringMatching(/^perf-ref-\d{3}\.jpg$/),
      mimeType: 'image/jpeg',
      sizeBytes: expect.any(Number),
    })
  }
  // tags on every 8th note, with their definitions in the doc
  const tagged = live.filter((e) =>
    Object.keys((e.customData as { lobby?: Record<string, unknown> } | undefined)?.lobby ?? {}).some((k) =>
      k.startsWith('tag:'),
    ),
  )
  expect(tagged.length).toBe(Math.ceil(60 / 8) * 2)
  // two comment threads, anchored to notes
  const threads = await a.page.evaluate(async (bid) => {
    const res = await fetch(`/api/boards/${encodeURIComponent(bid)}/threads`, { credentials: 'same-origin' })
    return (await res.json()) as { threads?: unknown[] }
  }, board)
  expect(threads.threads?.length).toBe(2)
  await zoomToFit(b.page)
  // the images load in the second tab (the loader's state, a board-scoped derivative URL, decoded bytes)
  for (const up of seeded.images) await expectLoadedImage(b.page, up.id, board)
  expect((await serverSnapshot(stack, board)).elements.length).toBe(seeded.elements)
})
