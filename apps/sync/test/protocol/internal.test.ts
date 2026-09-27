// docs/M1-CONTRACTS.md §8 through the real server process: seed a new board, read snapshots, and
// never overwrite a board that has data, including after a restart (room closed, file on disk).
import { draftroomSchema } from '@draftroom/canvas-schema'
import { describe, expect, it } from 'vitest'
import { newBoardId, roomFiles, useProtocolHarness } from '../harness/fixture.ts'
import { geoShape, noteShape, plainText, type ShapeRecord } from '../harness/records.ts'
import type { SyncServer } from '../harness/server-process.ts'
import { callInternal, errorCode } from '../harness/tickets.ts'

const h = useProtocolHarness()

const seed = (server: SyncServer, boardId: string, records: ShapeRecord[]) =>
  callInternal(server.url, 'POST', `/internal/boards/${boardId}/seed`, {
    body: {
      snapshot: {
        schema: draftroomSchema.serialize(),
        documents: records.map((state) => ({ state, lastChangedClock: 0 })),
      },
    },
  })

async function snapshotIds(server: SyncServer, boardId: string) {
  const res = await callInternal(server.url, 'GET', `/internal/boards/${boardId}/snapshot`)
  expect(res.status).toBe(200)
  const snap = (await res.json()) as { documents: Array<{ state: ShapeRecord }> }
  return new Map(snap.documents.map((d) => [d.state.id as string, d.state]))
}

describe('internal canvas endpoints (real process)', () => {
  it('seed, then connect: clients see the seeded shapes; the snapshot tracks later edits', async () => {
    const server = await h.server()
    const boardId = newBoardId()
    const res = await seed(server, boardId, [geoShape('s', { x: 7 }), noteShape('n', 'from template')])
    expect(res.status).toBe(201)

    const a = await h.connected(server, { boardId, user: 'usr_alice' })
    expect(a.get('shape:s')?.x).toBe(7)
    expect(plainText(a.get('shape:n')?.props.richText)).toBe('from template')
    a.update('shape:s', (r) => ({ ...r, x: 70 }))
    a.put(geoShape('added'))
    await a.waitForAcked()

    const snap = await snapshotIds(server, boardId)
    expect(snap.get('shape:s')?.x).toBe(70)
    expect(snap.has('shape:added')).toBe(true)
  })

  it('a board with data is never overwritten: 409 while open, 409 after a restart, data identical', async () => {
    const server = await h.server()
    const boardId = newBoardId()
    const a = await h.connected(server, { boardId, user: 'usr_alice' })
    a.put(geoShape('precious', { x: 1 }))
    await a.waitForAcked()

    expect((await seed(server, boardId, [geoShape('overwrite')])).status).toBe(409)
    const before = await snapshotIds(server, boardId)

    a.dispose()
    await server.restart() // the room is closed; only the initialized file remains
    const res = await seed(server, boardId, [geoShape('overwrite')])
    expect(res.status).toBe(409)
    expect(await errorCode(res)).toBe('BOARD_EXISTS')
    const after = await snapshotIds(server, boardId)
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort())
    expect(after.get('shape:precious')).toEqual(before.get('shape:precious'))
    expect(after.has('shape:overwrite')).toBe(false)
    const fresh = await h.freshView(server, boardId)
    expect([...fresh.keys()]).toEqual(['shape:precious'])
  })

  it('an invalid snapshot is refused with 400 and leaves no board file', async () => {
    const server = await h.server()
    const boardId = newBoardId()
    const res = await seed(server, boardId, [{ ...geoShape('bad'), x: 'nope' } as unknown as ShapeRecord])
    expect(res.status).toBe(400)
    expect(await errorCode(res)).toBe('INVALID_SNAPSHOT')
    expect(roomFiles(server.dataDir)).toEqual([])
  })
})
