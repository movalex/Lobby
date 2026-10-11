// N1-6 (wave N, the review): a feature's `canvas.on('change')` listener reads `canvas.index` synchronously (WS3 and WS7
// move their overlays to it), so the index must already answer for the batch that listener hears. Before the fix the
// board page's change stream was a port `changed` listener registered before the LobbyCanvas (whose scene index
// listens to the same event, and port listeners run in registration order), so a listener read the index one batch
// late: after two notes were made, notes() said 0 while items() had 1, then 1 against 2. And a remote batch (the engine
// core's `applied`) reaches the change stream before the engine's onChange tells the port at all.
//
// Here, on the real board page, a `canvas.on('change')` listener compares every index answer (notes, every frame's
// elements, the elements of each `customData.lobby` key prefix the board has) with the same filter over the port's
// live elements, for local batches (this tab's creates, frame moves, deletes) and remote ones (another tab's).
import {
  createItem,
  createNote,
  deleteItem,
  expect,
  expectConverged,
  test,
  updateItem,
  waitForItem,
} from '../tests/support/canvas.ts'

interface Seen {
  source: string
  created: number
  updated: number
  deleted: number
  mismatches: string[]
}

test('N1-6: inside canvas.on("change"), canvas.index answers for that batch (local and remote)', async ({
  canvasSession,
}) => {
  const a = await canvasSession('alice')
  const b = await canvasSession('bob')
  await a.page.evaluate(() => {
    type El = {
      id: string
      type: string
      frameId?: string | null
      customData?: { lobby?: Record<string, unknown> }
    }
    const w = window as unknown as {
      __n1index: Seen[]
      __lobbyBoard: {
        port: { items(): El[] }
        canvas: {
          index: {
            notes(): El[]
            byFrame(id: string): El[]
            withLobbyKeyPrefix(p: string): El[]
          }
          on(
            event: 'change',
            l: (c: { source: string; created: string[]; updated: string[]; deleted: string[] }) => void,
          ): () => void
        }
      }
    }
    const { canvas, port } = w.__lobbyBoard
    const sorted = (xs: El[]) => xs.map((e) => e.id).sort()
    const keys = (e: El) => Object.keys(e.customData?.lobby ?? {})
    const prefixed = (e: El, p: string) => keys(e).some((k) => k.length > p.length && k.startsWith(p))
    const seen: Seen[] = []
    w.__n1index = seen
    // the index is built before the batches (an overlay read it at mount), so a late update shows
    canvas.index.notes()
    canvas.on('change', (c) => {
      const live = port.items()
      const mismatches: string[] = []
      const check = (what: string, index: El[], filter: El[]) => {
        const i = sorted(index)
        const f = sorted(filter)
        if (JSON.stringify(i) !== JSON.stringify(f))
          mismatches.push(`${what}: index ${JSON.stringify(i)} vs items ${JSON.stringify(f)}`)
      }
      check(
        'notes',
        canvas.index.notes(),
        live.filter((e) => e.type === 'stickynote'),
      )
      const frames = new Set(live.filter((e) => e.type === 'frame').map((e) => e.id))
      for (const e of live) if (e.frameId) frames.add(e.frameId)
      for (const f of frames)
        check(
          `byFrame(${f})`,
          canvas.index.byFrame(f),
          live.filter((e) => e.frameId === f),
        )
      const prefixes = new Set(['react:', 'plusOne:'])
      for (const e of live) for (const k of keys(e)) if (k.length > 2) prefixes.add(k.slice(0, 2))
      for (const p of prefixes)
        check(
          `withLobbyKeyPrefix(${p})`,
          canvas.index.withLobbyKeyPrefix(p),
          live.filter((e) => prefixed(e, p)),
        )
      seen.push({
        source: c.source,
        created: c.created.length,
        updated: c.updated.length,
        deleted: c.deleted.length,
        mismatches,
      })
    })
  })

  // local batches: a frame, notes made one by one, two moved into the frame, one deleted
  const frame = await createItem(a.page, 'frame', { x: 0, y: 0, width: 900, height: 600 })
  const notes: string[] = []
  for (let i = 0; i < 3; i++)
    notes.push(await createNote(a.page, { x: 1200 + i * 260, y: 100, text: `n${i}` }))
  await updateItem(a.page, notes[0] as string, { frameId: frame, x: 100, y: 100 })
  await updateItem(a.page, notes[1] as string, { frameId: frame, x: 400, y: 100 })
  await deleteItem(a.page, notes[2] as string)
  // remote batches: the other tab's note, moved into the frame, then one of alice's taken out and deleted
  await waitForItem(b.page, frame)
  const theirs = await createNote(b.page, { x: 1200, y: 600, text: 'theirs' })
  await waitForItem(a.page, theirs)
  await updateItem(b.page, theirs, { frameId: frame, x: 100, y: 350 })
  await updateItem(b.page, notes[1] as string, { frameId: null, x: 1400, y: 400 })
  await deleteItem(b.page, notes[0] as string)
  await expectConverged(a.page, [b.page])

  const seen = await a.page.evaluate(() => (window as unknown as { __n1index: Seen[] }).__n1index)
  const sources = new Set(seen.map((s) => s.source))
  expect(sources.has('local'), `local batches heard (${JSON.stringify(seen)})`).toBe(true)
  expect(sources.has('remote'), `remote batches heard (${JSON.stringify(seen)})`).toBe(true)
  expect(
    seen.filter((s) => s.mismatches.length),
    'every batch: the index answered for it inside the change listener',
  ).toEqual([])
})
