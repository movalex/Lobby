// The internal reads of a board nobody has opened yet (wave 4d, 2A), against the REAL sync server process.
// On the Excalidraw engine a board has no file until its first join or seed; the api reads such a board for
// a checkpoint, an export, the AI's sources or a workshop's shapes. GET /internal/boards/:bid/snapshot
// answered 404 board-not-found, which the api turned into 503 "the board server is not reachable", so a
// checkpoint of a never-opened board failed (the ported domain-access spec had to open the board first).
// Now the snapshot route opens the board as a new, empty one (its file made as a first join makes it) and
// answers an empty snapshot; the other internal reads keep answering as an empty board without a file.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { LobbyElementsSnapshot } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import { boardDbPath } from '../../src/rooms.ts'
import { rect } from '../element-room/support/elements.ts'
import { newBoardId, useElementHarness } from '../element-room/support/stack.ts'
import { call } from './support.ts'

const h = useElementHarness()

/** The board file of `b` in the stack's data dir (its rooms folder). */
const fileOf = (dataDir: string, b: string) => boardDbPath(join(dataDir, 'rooms'), b)

describe('internal reads of a board nobody has opened yet (W4d 2A)', () => {
  it('the snapshot route opens the board as an empty one (200, its file made); a join afterwards is the same board', async () => {
    const dataDir = h.dataDir()
    const st = await h.stack({ dataDir })
    const b = newBoardId()
    expect(existsSync(fileOf(dataDir, b))).toBe(false)

    const first = await call(st, 'GET', `/internal/boards/${b}/snapshot`)
    expect(first.status, JSON.stringify(first.body)).toBe(200)
    const snap = LobbyElementsSnapshot.parse(first.body)
    expect(snap).toEqual({
      format: 'lobby-elements',
      schema: expect.any(Number),
      clock: 0,
      elements: [],
      doc: {},
    })
    expect(existsSync(fileOf(dataDir, b))).toBe(true)
    // the board the room made: clock 0, no element, an epoch of its own
    const made = await st.snapshot(b)
    expect(made.clock).toBe(0)
    expect(made.elements).toEqual([])
    expect(made.epoch).toMatch(/\S/)
    // asked again: the same answer (no second board, no new epoch)
    const again = await call(st, 'GET', `/internal/boards/${b}/snapshot`)
    expect(again.status).toBe(200)
    expect(again.body).toEqual(first.body)
    expect((await st.snapshot(b)).epoch).toBe(made.epoch)

    // a session joining afterwards is on that board, and its writes show in the next snapshot
    const a = await st.client({ boardId: b, user: 'alice' })
    expect(a.welcome?.epoch).toBe(made.epoch)
    expect(a.welcome?.clock).toBe(0)
    await a.create([rect('r1')])
    const after = await call<LobbyElementsSnapshot>(st, 'GET', `/internal/boards/${b}/snapshot`)
    expect(after.status).toBe(200)
    expect(after.body.elements.map((e) => e.id)).toEqual(['r1'])
    expect(after.body.clock).toBe(1)
  })

  it('text, asset-refs and deleted answer as an empty board and make no file', async () => {
    const dataDir = h.dataDir()
    const st = await h.stack({ dataDir })
    const b = newBoardId()
    const text = await call<{ boardId: string; clock: number; unchanged: boolean; entries?: unknown[] }>(
      st,
      'GET',
      `/internal/boards/${b}/text`,
    )
    expect(text.status).toBe(200)
    expect(text.body).toMatchObject({ boardId: b, clock: 0, unchanged: false, entries: [] })
    const refs = await call<{ boardId: string; exists: boolean; canvas: unknown[] }>(
      st,
      'GET',
      `/internal/boards/${b}/asset-refs`,
    )
    expect(refs.status).toBe(200)
    expect(refs.body).toMatchObject({ boardId: b, exists: false, canvas: [] })
    const deleted = await call<{ entries: unknown[]; total: number }>(
      st,
      'GET',
      `/internal/boards/${b}/deleted`,
    )
    expect(deleted.status).toBe(200)
    expect(deleted.body).toMatchObject({ entries: [], total: 0 })
    expect(existsSync(fileOf(dataDir, b))).toBe(false)
  })
})

describe('the same read while maintenance is on (the cut-over window, W4d 2A)', () => {
  it('answers the empty board without making a file; the file follows the first read once maintenance is off', async () => {
    const dataDir = h.dataDir()
    const st = await h.stack({ dataDir, env: { DRAFTROOM_BOOT_MAINTENANCE: '1' } })
    const b = newBoardId()
    const held = await call(st, 'GET', `/internal/boards/${b}/snapshot`)
    expect(held.status, JSON.stringify(held.body)).toBe(200)
    expect(LobbyElementsSnapshot.parse(held.body)).toMatchObject({ clock: 0, elements: [], doc: {} })
    expect(existsSync(fileOf(dataDir, b))).toBe(false)
    expect((await call(st, 'POST', '/internal/maintenance', { on: false })).status).toBe(200)
    const made = await call(st, 'GET', `/internal/boards/${b}/snapshot`)
    expect(made.status).toBe(200)
    expect(made.body).toEqual(held.body)
    expect(existsSync(fileOf(dataDir, b))).toBe(true)
  })
})
