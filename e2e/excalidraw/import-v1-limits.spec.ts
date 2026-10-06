// J4 IMPORT-V1-SYNC-BLOCK on the whole stack (real api, real sync): importing an old v1 `.lobby.json` (tldraw
// records) is converted by the sync server, which used to do it on the event loop every open board shares: a
// file of 60 sticky notes of 20,000 characters (1.2 MiB) held the server for 6.6 s. The conversion runs in a
// worker thread with limits now (apps/sync/src/room-internal/convert-v1.ts): a file past the budget is
// refused (the api answers 422 IMPORT_TOO_COMPLEX with a message that says why, and no board is made) while
// the sync server keeps answering, and a file inside it imports and opens as before.
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
import { expect, test } from '../tests/support/canvas.ts'
import { serverElements } from './history-kit.ts'

test.use({ syncEnv: { DRAFTROOM_V1_SEED_TIMEOUT_MS: '1500' } })

const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
/** A v1 archive of `n` sticky notes of `chars` characters of words each. */
function archive(n: number, chars: number) {
  const notes = Array.from({ length: n }, (_, i) =>
    tlNote(`n${i}`, i === 0 ? 'First idea' : 'word '.repeat(chars / 5), {
      x: (i % 10) * 300,
      y: Math.floor(i / 10) * 300,
      parentId: TL_PAGE,
      index: `a${B62[i + 1]}`,
    }),
  )
  return exportBoardArchive(
    [documentRecord(), tlPage(TL_PAGE, 'Page 1'), ...notes],
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

  await test.step('60 notes of 20,000 characters: 422 IMPORT_TOO_COMPLEX within the budget, no board made, and sync answers meanwhile', async () => {
    const heavy = archive(60, 20_000)
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
    expect(ms).toBeLessThan(6_000) // 6.6 s of conversion cut at the 1.5 s budget (worker start included)
    expect(probes).toBeGreaterThan(5)
    expect(slowest).toBeLessThan(2_500) // held on the sync loop, every one of them waited for the whole conversion
    expect((await aliceApi.listBoards(wid)).length).toBe(before + 1) // no board was made for the refused file
  })
})
