// Rolling the api back to a build older than the database's newest migrations (docs/DEPLOY.md
// "Rollback"; PG-3 of the wave-3 postgres-integrity review). By default such a build refuses to start;
// DRAFTROOM_ALLOW_NEWER_SCHEMA=1 lets it start on a schema that moved on, with a warning. The runner's
// own rules (never an unknown OLDER migration, never a checksum mismatch, never applying anything under
// a newer schema) are tested in packages/db/test/migrate.test.ts.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Db } from '@draftroom/db'
import { openTestDb } from '@draftroom/db/testing'
import { afterEach, describe, expect, it } from 'vitest'
import { createApiServer } from '../src/app.ts'
import { loadConfig } from '../src/config.ts'
import { createRecordingNotifier } from '../src/notifier.ts'
import { ORIGIN, testEnv } from './helpers.ts'

const cleanup: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c()
})

/** A fully migrated database on which a newer build has since applied one more migration. */
async function newerDatabase(): Promise<Db> {
  const db = await openTestDb()
  cleanup.push(() => db.close())
  await db.query(
    "INSERT INTO schema_migrations (version, name, checksum) VALUES (9999, '9999_from_a_newer_build', $1)",
    ['f'.repeat(64)],
  )
  return db
}

function configWith(extra: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dr-rollback-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return loadConfig(testEnv(dir, extra))
}

/** A logger that keeps what the api logs at warn and above. */
function warnings() {
  const lines: { msg?: string; newerMigrations?: string[] }[] = []
  const stream = { write: (msg: string) => void lines.push(JSON.parse(msg)) }
  return { lines, logger: { level: 'warn', stream } }
}

describe('DRAFTROOM_ALLOW_NEWER_SCHEMA', () => {
  it('is off unless set to 1, and other values are refused', () => {
    expect(configWith().allowNewerSchema).toBe(false)
    expect(configWith({ DRAFTROOM_ALLOW_NEWER_SCHEMA: '' }).allowNewerSchema).toBe(false)
    expect(configWith({ DRAFTROOM_ALLOW_NEWER_SCHEMA: '0' }).allowNewerSchema).toBe(false)
    expect(configWith({ DRAFTROOM_ALLOW_NEWER_SCHEMA: '1' }).allowNewerSchema).toBe(true)
    for (const v of ['true', 'yes', '2'])
      expect(() => configWith({ DRAFTROOM_ALLOW_NEWER_SCHEMA: v }), v).toThrow(
        /DRAFTROOM_ALLOW_NEWER_SCHEMA must be 1/,
      )
  })

  it('without it, an older api refuses to start on a database with newer migrations', async () => {
    const db = await newerDatabase()
    await expect(createApiServer(configWith(), { db, notifier: createRecordingNotifier() })).rejects.toThrow(
      /database has migration 9999_from_a_newer_build, which this build does not know/,
    )
  })

  it('with it, the older api starts, says so in the log, applies nothing and serves requests', async () => {
    const db = await newerDatabase()
    const log = warnings()
    const server = await createApiServer(configWith({ DRAFTROOM_ALLOW_NEWER_SCHEMA: '1' }), {
      db,
      notifier: createRecordingNotifier(),
      logger: log.logger as never,
    })
    cleanup.push(() => server.close())
    await server.app.ready()
    expect(log.lines).toEqual([
      expect.objectContaining({
        newerMigrations: ['9999_from_a_newer_build'],
        msg: expect.stringMatching(
          /DRAFTROOM_ALLOW_NEWER_SCHEMA=1: this build is running on a database with newer migrations/,
        ),
      }),
    ])
    const recorded = await db.one<{ n: number }>(
      'SELECT count(*)::int AS n FROM schema_migrations WHERE version = 9999',
    )
    expect(recorded.n).toBe(1)
    const login = await server.app.inject({
      method: 'POST',
      url: '/api/auth/dev/login',
      payload: { handle: 'ada' },
      headers: { origin: ORIGIN },
    })
    expect(login.statusCode, login.body).toBe(200)
  })

  it('left on after the newer build is back, it only reminds the operator to remove it', async () => {
    const db = await openTestDb()
    cleanup.push(() => db.close())
    const log = warnings()
    const server = await createApiServer(configWith({ DRAFTROOM_ALLOW_NEWER_SCHEMA: '1' }), {
      db,
      notifier: createRecordingNotifier(),
      logger: log.logger as never,
    })
    cleanup.push(() => server.close())
    expect(log.lines.map((l) => l.msg)).toEqual([
      'DRAFTROOM_ALLOW_NEWER_SCHEMA=1 is set but the database has no newer migrations: remove the flag.',
    ])
  })
})
