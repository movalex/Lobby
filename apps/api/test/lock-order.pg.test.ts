// The row-lock order (apps/api/src/access.ts) on a real Postgres. PGlite has one connection, so two
// transactions never wait for each other there: set DRAFTROOM_TEST_DATABASE_URL (a database these tests
// may create and drop schemas in) to run them. Skipped otherwise.
//
// Each test holds the first lock of one side of a known deadlock in its own transaction (for example
// "a revoke holds the board row"), starts the other side (a guest join), waits until that side is
// blocked by it, and then checks that the row the first side needs next (the link) is free: the
// waiting side must not have taken it yet. Before the fix each of these sides held that row while it
// waited (NOWAIT answered 55P03), so the two deadlocked and one failed: a 500 for a request (the
// wave-3 postgres-integrity review, PG-1 and PG-2), a failed delete pass for the file collector (found
// in the audit that followed). concurrency.pg.test.ts runs the review's races at random.

import { ReviewLinkCreated } from '@draftroom/contracts'
import { type Db, pgErrorCode, type Queryable } from '@draftroom/db'
import { afterEach, describe, expect, it } from 'vitest'
import { collectWorkspace } from '../src/files/gc.ts'
import {
  freshIp,
  joinRequest,
  setupWorld,
  sweepLinks,
  tokenOf,
  type World,
} from './features/guests/support.ts'
import { upload } from './features/history/helpers.ts'
import { createBoard, createTestApi, DEV_STUDIO, type TestApi } from './helpers.ts'

const PG = !!process.env.DRAFTROOM_TEST_DATABASE_URL
const DAY = 86_400_000

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c().catch(() => {})
})

async function guestsWorld(): Promise<World> {
  const w = await setupWorld()
  cleanup.push(() => w.api.close())
  return w
}

/** Resolves once some backend is waiting for a lock that the connection `pid` holds. */
async function blockedBy(db: Db, pid: number, what: string, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs
  for (;;) {
    const r = await db.one<{ n: number }>(
      'SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))',
      [pid],
    )
    if (r.n > 0) return
    if (Date.now() > until) throw new Error(`${what} never waited for the held lock`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

/**
 * Whether another transaction holds `table`'s row `id` right now: a lock attempt that never waits
 * (NOWAIT), made and released on its own connection. 'free' or the SQLSTATE (55P03: held).
 */
async function rowLock(db: Db, table: 'invitations' | 'asset_versions', id: string): Promise<string> {
  try {
    await db.query(`SELECT id FROM ${table} WHERE id = $1 FOR UPDATE NOWAIT`, [id])
    return 'free'
  } catch (e) {
    return pgErrorCode(e) ?? String(e)
  }
}

/**
 * Runs `fn` in a transaction on its own connection that first takes `firstLock`, and returns what `fn`
 * started (a request) only after that transaction ended, so the waiting side can finish.
 */
async function holding<T>(
  db: Db,
  firstLock: [string, unknown[]],
  fn: (tx: Queryable, pid: number) => Promise<{ started: Promise<T> }>,
): Promise<T> {
  const box: { started?: Promise<T> } = {}
  try {
    await db.transaction(async (tx) => {
      const { pid } = await tx.one<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      await tx.query(...firstLock)
      box.started = (await fn(tx, pid)).started
    })
  } finally {
    // Whatever happened, the other side runs to its end before the test does.
    await box.started?.catch(() => {})
  }
  if (!box.started) throw new Error('nothing was started')
  return box.started
}

describe.skipIf(!PG)('row-lock order on a real Postgres (DRAFTROOM_TEST_DATABASE_URL)', () => {
  it('a guest joining through a link waits for the board row before it takes the link (PG-1: join vs revoke)', async () => {
    const w = await guestsWorld()
    const res = await w.bob.req('POST', `/api/boards/${w.board}/review-links`, {
      role: 'editor',
      allowGuests: true,
    })
    const link = ReviewLinkCreated.parse(res.json())
    // A revoke of the link, midway: it holds the board row (requireBoardAction forUpdate) ...
    const joined = await holding(
      w.api.db,
      ['SELECT id FROM boards WHERE id = $1 FOR UPDATE', [w.board]],
      async (tx, pid) => {
        const started = joinRequest(w.api, tokenOf(link.url), { name: 'Sam' }, { ip: freshIp() })
        await blockedBy(w.api.db, pid, 'the guest join')
        // ... and takes the link next. The waiting join must not hold it (it did: a deadlock, a 500).
        expect(await rowLock(w.api.db, 'invitations', link.id)).toBe('free')
        await tx.query('SELECT id FROM invitations WHERE id = $1 FOR UPDATE', [link.id])
        await tx.query('UPDATE invitations SET revoked_at = now() WHERE id = $1', [link.id])
        return { started }
      },
    )
    // The join went on after the revoke committed, and saw it.
    expect(joined.statusCode, joined.body).toBe(410)
  })

  it('an account accepting a link waits for the board row before it takes the link (PG-1: accept vs "+1 h")', async () => {
    const w = await guestsWorld()
    const res = await w.bob.req('POST', `/api/boards/${w.board}/review-links`, { role: 'editor' })
    const link = ReviewLinkCreated.parse(res.json())
    const before = await w.api.db.one<{ expires_at: Date }>(
      'SELECT expires_at FROM invitations WHERE id = $1',
      [link.id],
    )
    // "+1 h" on the link, midway: board row, then the link.
    const accepted = await holding(
      w.api.db,
      ['SELECT id FROM boards WHERE id = $1 FOR UPDATE', [w.board]],
      async (tx, pid) => {
        const started = w.erin.req('POST', `/api/invitations/${tokenOf(link.url)}/accept`)
        await blockedBy(w.api.db, pid, 'the accept')
        expect(await rowLock(w.api.db, 'invitations', link.id)).toBe('free')
        await tx.query('SELECT id FROM invitations WHERE id = $1 FOR UPDATE', [link.id])
        await tx.query("UPDATE invitations SET expires_at = expires_at + interval '1 hour' WHERE id = $1", [
          link.id,
        ])
        return { started }
      },
    )
    expect(accepted.statusCode, accepted.body).toBe(200)
    const after = await w.api.db.one<{ expires_at: Date; use_count: number }>(
      'SELECT expires_at, use_count FROM invitations WHERE id = $1',
      [link.id],
    )
    expect(after.expires_at.getTime() - before.expires_at.getTime()).toBe(3_600_000)
    expect(after.use_count).toBe(1)
  })

  it('the expired-link sweeper waits for the board row before it takes the link (PG-2: sweeper vs revoke)', async () => {
    const w = await guestsWorld()
    const res = await w.bob.req('POST', `/api/boards/${w.board}/review-links`, {
      role: 'editor',
      allowGuests: true,
      expiresInHours: 1,
    })
    const link = ReviewLinkCreated.parse(res.json())
    const joined = await joinRequest(w.api, tokenOf(link.url), { name: 'Sam' }, { ip: freshIp() })
    expect(joined.statusCode, joined.body).toBe(201)
    // A revoke with removal, midway (board row first). The link expires while it holds the board, so
    // the app's own sweeper (every 5 s) cannot get to it before this test's sweep does.
    const removed = await holding(
      w.api.db,
      ['SELECT id FROM boards WHERE id = $1 FOR UPDATE', [w.board]],
      async (tx, pid) => {
        w.api.clock.advance(61 * 60_000)
        const started = sweepLinks(w)
        await blockedBy(w.api.db, pid, 'the link sweeper')
        expect(await rowLock(w.api.db, 'invitations', link.id)).toBe('free')
        await tx.query('SELECT id FROM invitations WHERE id = $1 FOR UPDATE', [link.id])
        await tx.query('UPDATE invitations SET revoked_at = now(), swept_at = now() WHERE id = $1', [link.id])
        return { started }
      },
    )
    // The revoke swept the link; the sweeper, re-reading it under the lock, left it alone.
    expect(removed).toBe(0)
  })

  it('the file collector locks a preview job before its version, like a worker claiming it (asset GC vs claim)', async () => {
    const api: TestApi = await createTestApi({ env: { DRAFTROOM_ASSET_GC: 'off' } })
    cleanup.push(() => api.close())
    const alice = await api.login('alice')
    const board = await createBoard(alice, DEV_STUDIO, 'Mood board')
    const m = await upload(api, alice, board, 'orphan.png') // its preview job is queued
    const deps = {
      db: api.db,
      blobs: api.blobs,
      // No board shows the file.
      sync: {
        assetRefs: async (boardId: string) => ({ boardId, exists: true, canvas: [], deleted: [] }),
      },
      dataRoot: api.config.dataDir,
      now: api.clock.now,
      log: { info: () => {}, warn: () => {} },
    }
    api.clock.advance(8 * DAY)
    expect((await collectWorkspace(deps, DEV_STUDIO, 'delete'))?.marked).toBe(1)
    api.clock.advance(31 * DAY) // unreferenced long enough: the next delete pass takes it

    // A worker claiming the job right then: the job row first (FOR UPDATE SKIP LOCKED), then the version.
    const pass = await holding(
      api.db,
      ['SELECT version_id FROM preview_jobs WHERE version_id = $1 FOR UPDATE', [m.versionId]],
      async (tx, pid) => {
        const started = collectWorkspace(deps, DEV_STUDIO, 'delete')
        await blockedBy(api.db, pid, 'the delete pass')
        // The collector waits for the job without holding the version (it did: a deadlock).
        expect(await rowLock(api.db, 'asset_versions', m.versionId)).toBe('free')
        await tx.query(
          `UPDATE preview_jobs SET status = 'running', lease_owner = 'w-test', lease_until = now() + interval '2 minutes',
                  attempts = attempts + 1 WHERE version_id = $1`,
          [m.versionId],
        )
        await tx.query("UPDATE asset_versions SET status = 'processing' WHERE id = $1", [m.versionId])
        return { started }
      },
    )
    // It then saw the running job and kept the version.
    expect(pass?.deleted.versions).toBe(0)
    expect(await api.db.maybeOne('SELECT id FROM asset_versions WHERE id = $1', [m.versionId])).not.toBeNull()
  })
})
