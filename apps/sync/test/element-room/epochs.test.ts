// §6.2 "Epochs" and §2.6 "Restores" through the real server process: every restore takes a new epoch, so
// a client that saw the board after the backup gets a reset on reconnect instead of keeping ghost
// elements. The horizon half ("a since below the horizon gets a reset") is baseline.test.ts's. Here: a
// staged restore of a CONVERTED board (the backup code's restoreBackupFile, as staged-restore.ts applies
// it, raising the tldraw clock) makes the board's next open a roll-forward (O4's, room/migrate/**), which
// writes a new epoch. The room takes no epoch of its own: conversion, roll-forward and this restore path
// are every restore an element board has today (see O1-room.md, "Epochs on restore").

import { join } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'
import { hashElements } from '@draftroom/canvas-schema/hash'
import { describe, expect, it } from 'vitest'
import { restoreBackupFile } from '../../src/backup/restore.ts'
import { callInternal } from '../harness/tickets.ts'
import { fixtureRecords, seedBoardRecords } from '../migrate/board-files.ts'
import { rect } from './support/elements.ts'
import { newBoardId, useElementHarness } from './support/stack.ts'

const h = useElementHarness()

describe('epochs on restore', () => {
  it('a restored converted board opens with a new epoch: a stale client resets and keeps no ghost', async () => {
    const dataDir = h.dataDir()
    const rooms = join(dataDir, 'rooms')
    const boardId = newBoardId()
    const path = seedBoardRecords(rooms, boardId, fixtureRecords('kitchen-sink'))
    const st = await h.stack({ dataDir })
    const a = await st.client({ boardId, user: 'alice' }) // converted on open
    await a.create([rect('kept', { x: 5000 })])
    a.close()
    await st.server.kill('SIGTERM')
    // the backup (the backup service's own method: SQLite's online backup)
    const backupFile = join(dataDir, 'backup-of-board.sqlite')
    const src = new DatabaseSync(path, { readOnly: true })
    try {
      await backup(src, backupFile)
    } finally {
      src.close()
    }
    // after the backup, someone adds an element and keeps its clock and epoch
    await st.server.restart()
    const b = await st.client({ boardId, user: 'bob' })
    await b.create([rect('ghost', { x: 6000 })])
    const held = new Map(b.confirmed)
    const since = b.clock
    const epoch = b.epoch
    b.close()
    await st.server.kill('SIGTERM')
    // the staged restore's apply step (server stopped): the backup back in place, its clock raised
    restoreBackupFile({ file: backupFile, roomsDir: rooms, boardId, overwrite: true, bumpClockBy: 1_000 })
    await st.server.restart()
    const b2 = await st.client({ boardId, user: 'bob', tab: 'bob-2', since, epoch, confirmed: held })
    expect(b2.received[0]).toEqual({ type: 'notice', code: 'PREPARING' }) // the roll-forward
    expect(b2.welcome?.reset).toBe(true)
    expect(b2.epoch).not.toBe(epoch)
    expect(b2.confirmed.has('ghost')).toBe(false)
    expect(b2.confirmed.has('kept')).toBe(true)
    expect(await b2.hash()).toBe(await hashElements((await st.snapshot(boardId)).elements))
    const status = (await (await callInternal(st.server.url, 'GET', '/internal/migrate/status')).json()) as {
      boards: { boardId: string; kind: string; state: string }[]
    }
    expect(status.boards.filter((x) => x.boardId === boardId).map((x) => [x.kind, x.state])).toEqual([
      ['rollforward', 'done'],
    ])
    // a second stale client (the pre-backup epoch) resets too
    const a2 = await st.client({ boardId, user: 'alice', tab: 'alice-2', since: 1, epoch })
    expect(a2.welcome?.reset).toBe(true)
    expect(a2.confirmed.has('ghost')).toBe(false)
  })
})
