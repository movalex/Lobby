// FOR UPDATE SKIP LOCKED under real contention (docs/M3-STORAGE-CONTRACTS.md §4). PGlite has a single
// connection, so this needs a real Postgres: set DRAFTROOM_TEST_DATABASE_URL (a database this test may
// create and drop a schema in). Skipped otherwise.

import { randomBytes } from 'node:crypto'
import { type Db, migrate, openDb } from '@draftroom/db'
import { newId, PREVIEW_PROFILE } from '@draftroom/dev-assets'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { claimJob } from '../../src/worker/jobs.ts'

const URL_ = process.env.DRAFTROOM_TEST_DATABASE_URL
const SCHEMA = `m3_skip_locked_${randomBytes(4).toString('hex')}`

describe.skipIf(!URL_)('claim on real Postgres (DRAFTROOM_TEST_DATABASE_URL)', () => {
  let admin: Db
  let db: Db
  const versions: string[] = []

  beforeAll(async () => {
    admin = await openDb({ kind: 'pg', connectionString: URL_ as string, maxConnections: 1 })
    await admin.exec(`CREATE SCHEMA ${SCHEMA}`)
    const u = new URL(URL_ as string)
    u.searchParams.set('options', `-c search_path=${SCHEMA}`)
    db = await openDb({ kind: 'pg', connectionString: u.toString(), maxConnections: 8 })
    await migrate(db)
    await db.exec(`
      INSERT INTO users (id, name, handle, color) VALUES ('usr_aaaaaaaaaaaa', 'A', 'a', '#3355ff');
      INSERT INTO workspaces (id, name, created_by) VALUES ('wsp_aaaaaaaaaaaa', 'W', 'usr_aaaaaaaaaaaa');
      INSERT INTO boards (id, workspace_id, title, created_by) VALUES ('b-aaaaaaaaaa', 'wsp_aaaaaaaaaaaa', 'B', 'usr_aaaaaaaaaaaa');
    `)
    const t0 = Date.now() - 60_000
    for (let i = 0; i < 20; i++) {
      const ver = newId('ver')
      versions.push(ver)
      const at = new Date(t0 + i * 10)
      await db.query(
        `INSERT INTO asset_versions (id, asset_id, workspace_id, board_id, name, declared_mime_type, mime_type, kind,
           size_bytes, sha256, uploaded_by, created_at, updated_at)
         VALUES ($1, $2, 'wsp_aaaaaaaaaaaa', 'b-aaaaaaaaaa', 'f.png', 'image/png', 'image/png', 'image', 1,
           repeat('a', 64), 'usr_aaaaaaaaaaaa', $3, $3)`,
        [ver, newId('ast'), at],
      )
      await db.query(
        `INSERT INTO preview_jobs (version_id, profile, run_after, created_at, updated_at) VALUES ($1, $2, $3, $3, $3)`,
        [ver, PREVIEW_PROFILE, at],
      )
    }
  })

  afterAll(async () => {
    await db?.close()
    await admin?.exec(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await admin?.close()
  })

  it('a claimer skips a row another transaction holds, instead of waiting for it', async () => {
    let release = () => {}
    const held = new Promise<void>((r) => {
      release = r
    })
    let locked = () => {}
    const isLocked = new Promise<void>((r) => {
      locked = r
    })
    const holder = db.transaction(async (tx) => {
      await tx.query('SELECT 1 FROM preview_jobs WHERE version_id = $1 FOR UPDATE', [versions[0]])
      locked()
      await held
    })
    await isLocked
    const started = Date.now()
    const got = await claimJob(db, new Date(), 'worker-a')
    expect(Date.now() - started).toBeLessThan(2_000) // did not block on the locked row
    expect(got.job?.versionId).toBe(versions[1]) // the oldest row nobody holds
    release()
    await holder
    expect((await claimJob(db, new Date(), 'worker-b')).job?.versionId).toBe(versions[0])
  })

  it('many concurrent claimers on separate connections never get the same job', async () => {
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) => claimJob(db, new Date(), i % 2 ? 'nas-1' : 'render-1')),
    )
    const ids = results.flatMap((r) => (r.job ? [r.job.versionId] : []))
    expect(ids.length).toBe(18) // 20 minus the two claimed above
    expect(new Set(ids).size).toBe(ids.length)
  })
})
