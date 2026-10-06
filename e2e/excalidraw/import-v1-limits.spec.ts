// J4 IMPORT-V1-SYNC-BLOCK on the whole stack (real api, real sync): importing an old v1 `.lobby.json` (tldraw
// records) is converted by the sync server, which used to do it on the event loop every open board shares: a
// file of 60 sticky notes of 20,000 characters (1.2 MiB) held the server for 6.6 s. The conversion runs in a
// worker thread with limits now (apps/sync/src/room-internal/convert-v1.ts): a file past the budget is
// refused (the api answers 422 IMPORT_TOO_COMPLEX with a message that says why, and no board is made) while
// the sync server keeps answering, and a file inside it imports and opens as before. The worker's heap is
// sized by the file (freehand strokes cost heap by their points): a stroke-heavy file of 3 MiB imports.
//
//   E2E_PORT_BASE=<base> pnpm --filter @draftroom/e2e exec playwright test excalidraw/import-v1-limits
import { exportBoardArchive } from '../../packages/tldraw-import/src/archive-v1.ts'
import { draftroomSchema } from '../../packages/tldraw-import/src/schema.ts'
import {
  documentRecord,
  PAGE as TL_PAGE,
  note as tlNote,
  page as tlPage,
} from '../../packages/tldraw-import/src/test-fixtures.ts'
import { b64Vecs } from '../../packages/tldraw-import/src/tldraw.ts'
import { expect, test } from '../tests/support/canvas.ts'
import { serverElements } from './history-kit.ts'

// A budget with room for a small file's worker start-up (a busy box or a small CI runner is slower than the
// desktop this was written on), and files that cost far more than it. The memory gate is out of this spec (a
// roomy limit): it is the time and the heap that are under test.
test.use({ syncEnv: { DRAFTROOM_V1_SEED_TIMEOUT_MS: '3000', DRAFTROOM_V1_SEED_RSS_LIMIT_MB: '8192' } })

const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
/** The n-th fractional index key in order (a0..az, b00..bzz, c000...). */
function nthIndex(n: number): string {
  let head = 'a'
  let width = 1
  let span = 62
  let k = n
  while (k >= span) {
    k -= span
    head = String.fromCharCode(head.charCodeAt(0) + 1)
    width++
    span = 62 ** width
  }
  let out = ''
  for (let i = 0; i < width; i++) {
    out = (B62[k % 62] as string) + out
    k = Math.floor(k / 62)
  }
  return head + out
}

/** A v1 archive of `n` sticky notes of `chars` characters of words each. */
function archive(n: number, chars: number) {
  const notes = Array.from({ length: n }, (_, i) =>
    tlNote(`n${i}`, i === 0 ? 'First idea' : 'word '.repeat(chars / 5), {
      x: (i % 10) * 300,
      y: Math.floor(i / 10) * 300,
      parentId: TL_PAGE,
      index: nthIndex(i + 1),
    }),
  )
  return exportBoardArchive(
    [documentRecord(), tlPage(TL_PAGE, 'Page 1'), ...notes],
    draftroomSchema.serialize(),
    [],
  )
}

/** A v1 archive of `n` freehand strokes of `points` points each (a random walk: the path does not compress). */
function strokeArchive(n: number, points: number) {
  let seed = 7
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 2 ** 32
  }
  const strokes = Array.from({ length: n }, (_, i) => {
    let x = 0
    let y = 0
    const path = Array.from({ length: points }, () => {
      x += rnd() * 6 - 3
      y += rnd() * 6 - 3
      return { x, y, z: 0.5 }
    })
    return {
      id: `shape:s${i}`,
      typeName: 'shape',
      type: 'draw',
      parentId: TL_PAGE,
      index: nthIndex(i + 1),
      x: (i % 30) * 400,
      y: Math.floor(i / 30) * 400,
      rotation: 0,
      isLocked: false,
      opacity: 1,
      meta: {},
      props: {
        color: 'violet',
        fill: 'none',
        dash: 'draw',
        size: 'm',
        segments: [{ type: 'free', path: b64Vecs.encodePoints(path, 2), dim: 2 }],
        isComplete: true,
        isClosed: false,
        isPen: false,
        scale: 1,
        scaleX: 1,
        scaleY: 1,
      },
    }
  })
  return exportBoardArchive(
    [documentRecord(), tlPage(TL_PAGE, 'Page 1'), ...strokes] as never,
    draftroomSchema.serialize(),
    [],
  )
}

test('importing a v1 file: a small one converts and opens; one that costs more than the budget is refused 422 and makes no board, while the server keeps answering', async ({
  users,
  board,
  stack,
}) => {
  const aliceApi = await users.api('alice')
  const wid = users.devStudioId
  const before = (await aliceApi.listBoards(wid)).length

  await test.step('a small v1 archive imports (the conversion ran in the sync server’s worker)', async () => {
    const res = await aliceApi.fetch(
      'POST',
      `/api/workspaces/${wid}/boards/import?title=Old%20board`,
      archive(3, 100),
    )
    expect(res.status(), await res.text()).toBe(201)
    const imported = ((await res.json()) as { board: { id: string } }).board.id
    const stored = await serverElements(stack, imported)
    expect(stored.filter((e) => e.type === 'stickynote')).toHaveLength(3)
    expect(stored.some((e) => (e as { originalText?: string }).originalText === 'First idea')).toBe(true)
    expect((await aliceApi.listBoards(wid)).length).toBe(before + 1)
  })

  await test.step('100 notes of 20,000 characters: 422 IMPORT_TOO_COMPLEX within the budget, no board made, and sync answers meanwhile', async () => {
    const heavy = archive(100, 20_000) // about 11 s of conversion
    // a request through the api to the sync server (the board's export reads its snapshot): it cannot be
    // answered while the sync server's event loop is held
    let slowest = 0
    let probes = 0
    let running = true
    const probe = (async () => {
      while (running) {
        const t0 = Date.now()
        const res = await aliceApi.fetch('GET', `/api/boards/${board}/export`)
        await res.text()
        slowest = Math.max(slowest, Date.now() - t0)
        probes++
        await new Promise((r) => setTimeout(r, 50))
      }
    })()
    const t0 = Date.now()
    const res = await aliceApi.fetch('POST', `/api/workspaces/${wid}/boards/import?title=Too%20heavy`, heavy)
    const ms = Date.now() - t0
    running = false
    await probe
    expect(res.status(), await res.text()).toBe(422)
    const error = ((await res.json()) as { error: { code: string; message: string } }).error
    expect(error.code).toBe('IMPORT_TOO_COMPLEX')
    expect(error.message).toMatch(/takes too long to convert/)
    expect(ms).toBeLessThan(8_000) // 11 s of conversion cut at the 3 s budget (worker start included)
    expect(probes).toBeGreaterThan(5)
    expect(slowest).toBeLessThan(2_500) // held on the sync loop, every one of them waited for the whole conversion
    expect((await aliceApi.listBoards(wid)).length).toBe(before + 1) // no board was made for the refused file
  })

  await test.step('a stroke-heavy file of 3 MiB (380 strokes of 1,500 points) imports: the worker’s heap is sized by the file', async () => {
    const res = await aliceApi.fetch(
      'POST',
      `/api/workspaces/${wid}/boards/import?title=Strokes`,
      strokeArchive(380, 1_500),
    )
    expect(res.status(), await res.text()).toBe(201)
    const imported = ((await res.json()) as { board: { id: string } }).board.id
    const stored = await serverElements(stack, imported)
    expect(stored.filter((e) => e.type === 'freedraw')).toHaveLength(380)
    expect((await aliceApi.listBoards(wid)).length).toBe(before + 2)
  })
})
