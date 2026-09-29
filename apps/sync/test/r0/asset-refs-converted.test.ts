// Bridge release R0 (docs/EXCALIDRAW-MIGRATION.md §5.8 "Asset GC", §5.9 step 2): during a rollback a
// converted board also holds the new canvas's elements (lb_elements), which R0 never reads. Its
// asset-refs answer says so (`newCanvasTables: true`), so the api's collector does not call its pass
// complete and marks nothing that only an Excalidraw-era element shows (verifier, gc-v2 part 2).
import type { TLRecord } from '@tldraw/tlschema'
import { afterEach, describe, expect, it } from 'vitest'
import { AST_A, fileCard, VER_A } from '../backup/offsite-fixtures.ts'
import { callInternal } from '../harness/tickets.ts'
import { startServer, type TestServer } from '../http/helpers.ts'
import { lbState, markConverted, seedTldrawBoard } from './support.ts'

let servers: TestServer[] = []
afterEach(async () => {
  await Promise.all(servers.map((s) => s.stop()))
  servers = []
})

describe('asset-refs of a converted board', () => {
  it('lists the tldraw side and says the new-canvas side was not read; a tldraw board does not', async () => {
    const s = await startServer()
    servers.push(s)
    const card = fileCard('card1', AST_A, VER_A) as unknown as TLRecord
    const conv = seedTldrawBoard(s.roomsDir, 'b-refs-conv', [card])
    markConverted(conv)
    const lbBefore = lbState(conv)
    seedTldrawBoard(s.roomsDir, 'b-refs-tl', [card])

    const converted = await (
      await callInternal(s.url, 'GET', '/internal/boards/b-refs-conv/asset-refs')
    ).json()
    expect(converted).toMatchObject({
      boardId: 'b-refs-conv',
      exists: true,
      canvas: [{ assetId: AST_A, versionId: VER_A }],
      newCanvasTables: true,
    })
    const plain = (await (
      await callInternal(s.url, 'GET', '/internal/boards/b-refs-tl/asset-refs')
    ).json()) as Record<string, unknown>
    expect(plain.canvas).toEqual([{ assetId: AST_A, versionId: VER_A }])
    expect('newCanvasTables' in plain).toBe(false)
    const missing = (await (
      await callInternal(s.url, 'GET', '/internal/boards/b-refs-none/asset-refs')
    ).json()) as Record<string, unknown>
    expect(missing).toMatchObject({ exists: false })
    expect('newCanvasTables' in missing).toBe(false)
    await s.server.close()
    expect(lbState(conv)).toEqual(lbBefore)
  })
})
