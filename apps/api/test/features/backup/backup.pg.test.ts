// Board backup and restore (wave R, WS4) on a real Postgres: the round trip (download, restore into another workspace:
// a done job, a new private board, its files new versions with the same bytes) and a hostile backup refused with
// nothing left behind. Opt-in like apps/api/test/concurrency.pg.test.ts: set DRAFTROOM_TEST_DATABASE_URL (a database
// these tests may create and drop schemas in) to run it; skipped otherwise. backup.test.ts runs all of it on PGlite.
import { afterEach, describe, expect, it } from 'vitest'
import { spoolKey } from '../../../src/features/backup/restore.ts'
import { importRunnerOf } from '../../../src/features/imports/index.ts'
import { createBoard, createTestApi, DEV_STUDIO, type TestApi } from '../../helpers.ts'
import { LobbySync, makeBackup, PDF, PNG, sha256, sourceBoard, uploadAs } from './support.ts'

const PG_URL = process.env.DRAFTROOM_TEST_DATABASE_URL ?? ''

let api: TestApi | null = null
afterEach(async () => {
  await api?.close()
  api = null
})

describe.skipIf(!PG_URL)('backup and restore on real Postgres (DRAFTROOM_TEST_DATABASE_URL)', () => {
  it('the round trip, and a hostile backup refused with nothing left behind', async () => {
    const sync = new LobbySync()
    const a = await createTestApi({ deps: { syncInternal: sync } })
    api = a
    const alice = await a.login('alice')
    const boardId = await createBoard(alice, DEV_STUDIO, 'Retro')
    const photo = await uploadAs(a, alice, boardId, 'photo.png', 'image/png', PNG)
    const doc = await uploadAs(a, alice, boardId, 'deck.pdf', 'application/pdf', PDF)
    sync.setBoard(boardId, sourceBoard(photo, doc))

    const t = await alice.req('POST', `/api/boards/${boardId}/backup/ticket`)
    expect(t.statusCode).toBe(200)
    const file = await a.app.inject({ method: 'GET', url: (t.json() as { url: string }).url })
    expect(file.statusCode).toBe(200)
    const type = { 'content-type': 'application/vnd.lobby.board+zip' }
    const target = `/api/workspaces/${alice.personalWorkspaceId}/backups`
    const res = await alice.req('POST', target, file.rawPayload, type)
    expect(res.statusCode, res.body).toBe(202)
    const runner = importRunnerOf(a.app)
    await runner?.idle()
    const row = await a.db.one<{ status: string; board_id: string; source_ref: string }>(
      'SELECT status, board_id, source_ref FROM board_imports WHERE batch_id = $1',
      [(res.json() as { importId: string }).importId],
    )
    expect(row.status).toBe('done')
    expect(await a.blobs.head(spoolKey(row.source_ref))).toBeNull()
    const versions = await a.db.query<{ sha256: string; workspace_id: string }>(
      'SELECT sha256, workspace_id FROM asset_versions WHERE board_id = $1 ORDER BY sha256',
      [row.board_id],
    )
    expect(versions.rows).toEqual(
      [sha256(PNG), sha256(PDF)].sort().map((s) => ({ sha256: s, workspace_id: alice.personalWorkspaceId })),
    )
    expect(sync.seeds.find((s) => s.boardId === row.board_id)?.body.elements).toHaveLength(7)

    const boards = (await a.db.one<{ n: number }>('SELECT count(*)::int AS n FROM boards')).n
    const newer = await makeBackup({ contractsRev: 10_000 })
    const refused = await alice.req('POST', `/api/workspaces/${DEV_STUDIO}/backups`, newer, type)
    expect(refused.statusCode).toBe(400)
    expect(refused.json().error.code).toBe('BACKUP_FROM_NEWER_LOBBY')
    await runner?.idle()
    // refused before any job is made (the upload is checked first)
    expect((await a.db.one<{ n: number }>('SELECT count(*)::int AS n FROM board_imports')).n).toBe(1)
    expect((await a.db.one<{ n: number }>('SELECT count(*)::int AS n FROM boards')).n).toBe(boards)
  })
})
