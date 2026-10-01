// B5 R4 (docs/EXCALIDRAW-MIGRATION.md §8.3): an editor is downgraded to viewer while connected. Pass: its
// socket closes 4000 and it reconnects read-only; its offline queue turns into READ_ONLY rejections with a
// clear message (O2's client); nothing it queued is stored. Owner: O1 (the server half: the access monitor's
// 4000, the read-only reconnect, READ_ONLY for every queued op).

import { expect, test } from '@playwright/test'
import type {} from '../../../apps/web/src/canvas/test-facade.types.ts' // window.lobbyCanvas
import { harness } from '../support/harness.ts'
import type { BrowserProcess, SpikeBStack } from '../support/types.ts'
import { codes, forge } from './b6-forge-kit.ts'

let stack: SpikeBStack
let O: BrowserProcess
let E: BrowserProcess
let boardId: string

test.beforeAll(async () => {
  stack = await harness.startStack({ syncEnv: { ACCESS_RECHECK_MS: '500' } })
  const uo = harness.devUser('r4-owner')
  const ue = harness.devUser('r4-editor')
  ;({ boardId } = await stack.createBoard({ owner: uo, members: [{ user: ue, role: 'editor' }] }))
  O = await harness.launchBrowser(stack, uo, { name: 'owner' })
  E = await harness.launchBrowser(stack, ue, { name: 'editor' })
  await O.openBoard(boardId)
  await E.openBoard(boardId)
})
test.afterAll(async () => {
  await O?.close()
  await E?.close()
  await stack?.stop()
})

test('R4: a downgrade closes 4000; the reconnect is read-only; queued writes are READ_ONLY', async () => {
  const id = await O.page.evaluate(
    () => window.lobbyCanvas?.create('rectangle', { x: 0, y: 0, width: 50, height: 50 }) ?? '',
  )
  await expect.poll(() => O.page.evaluate(() => window.lobbyCanvas?.saveState().state)).toBe('saved')
  const raw = await forge(E.page, boardId) // the server's side of the editor's session, seen raw
  expect(raw.welcome.readonly).toBe(false)
  const before = await harness.readSnapshot(stack, boardId)
  // the owner downgrades the editor through the api
  const editorUid = raw.welcome.you.uid
  const status = await O.page.evaluate(
    async ([b, uid]) =>
      (
        await fetch(`/api/boards/${b}/members/${uid}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ role: 'viewer' }),
        })
      ).status,
    [boardId, editorUid] as const,
  )
  expect(status).toBeLessThan(300)
  expect(await raw.socket.closed()).toMatchObject({ code: 4000 })
  // the page reconnects read-only (its new ticket carries the new role) and queues an edit meanwhile
  await E.page.evaluate((el) => window.lobbyCanvas?.update(el, { x: 300 }), id)
  const again = await forge(E.page, boardId)
  expect(again.welcome.readonly).toBe(true)
  const el = before.elements.find((e) => e.id === id) as { version: number }
  expect(codes(await again.push([{ k: 'p', id, pv: el.version, g: { pos: { x: 300, y: 0 } } }]))).toEqual([
    'READ_ONLY',
  ])
  await expect
    .poll(() => E.page.evaluate(() => window.lobbyCanvas?.saveState().lastReject?.code ?? null))
    .toBe('READ_ONLY')
  const after = await harness.readSnapshot(stack, boardId)
  expect(after.elements.find((e) => e.id === id)).toMatchObject({ x: 0 })
})
