// Import from Miro on a REAL Postgres (wave R, WS1): set DRAFTROOM_TEST_DATABASE_URL to a database these tests may
// create and drop schemas in; skipped otherwise. PGlite has one connection, so two file streams of one job never wait
// for each other there; here they do, at the workspace row (FOR NO KEY UPDATE) where each file's quota is checked
// again inside the insert. And node-postgres reads int8 and jsonb differently from PGlite: a whole job, a pause and a
// resume (stored files read back by their version) and the token scan run here too.
//
// NOT RUN where this was written (no Postgres on the dev machine): the lead runs it on the NAS.
import { importPausePath, importReportPath, importResumePath } from '@draftroom/contracts'
import { SPRINT_ID } from '@draftroom/miro-import/fixtures'
import { afterEach, describe, expect, it } from 'vitest'
import { type MiroWorld, miroWorld } from './miro-support.ts'

const PG = !!process.env.DRAFTROOM_TEST_DATABASE_URL

let w: MiroWorld | undefined
afterEach(async () => {
  await w?.close()
  w = undefined
})

describe.skipIf(!PG)('Miro import on Postgres', () => {
  it('two file streams racing for the last file of the quota: the board fails QUOTA_EXCEEDED, nothing stays', async () => {
    w = await miroWorld({ env: { DRAFTROOM_WORKSPACE_MAX_FILES: '1' } })
    const importId = await w.start(w.alice, [{ miroBoardId: SPRINT_ID }])
    const view = await w.until(w.alice, importId, (v) => v.status === 'failed')
    expect(view.boards[0]?.errorCode).toBe('QUOTA_EXCEEDED')
    expect((await w.api.db.query('SELECT id FROM asset_versions')).rows).toEqual([])
    expect((await w.api.db.query("SELECT id FROM boards WHERE status = 'importing'")).rows).toEqual([])
  })

  it('a whole job with a pause and a resume: stored files read back by version, the CSV, no token anywhere', async () => {
    w = await miroWorld()
    const world = w
    const hold = world.hold()
    const importId = await world.start(world.alice, [{ miroBoardId: SPRINT_ID }])
    await world.until(world.alice, importId, (v) => v.boards[0]?.progress.phase === 'files')
    await world.call(world.alice, 'POST', importPausePath(importId))
    hold.open()
    await world.runner.idle()
    expect((await world.view(world.alice, importId)).status).toBe('paused')
    await world.call(world.alice, 'POST', importResumePath(importId), { token: world.miro.token })
    const done = await world.until(world.alice, importId, (v) => v.status === 'done')
    const boardId = done.boards[0]?.boardId as string
    const versions = await world.api.db.query('SELECT id FROM asset_versions WHERE board_id = $1', [boardId])
    expect(versions.rows).toHaveLength(2)
    const csv = await world.call(world.alice, 'GET', importReportPath(importId))
    expect(csv.body.trim().split('\r\n')).toHaveLength(34)
    const raw = world.miro.token
    const tables = await world.api.db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`,
    )
    for (const { table_name } of tables.rows) {
      const rows = await world.api.db.query<{ t: string }>(
        `SELECT row_to_json(x)::text AS t FROM "${table_name}" x`,
      )
      for (const r of rows.rows) expect(r.t.includes(raw), table_name).toBe(false)
    }
    for (const l of world.logs) expect(l.includes(raw)).toBe(false)
  })
})
