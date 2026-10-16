// Wave S, WS2 on a real Postgres (docs/WAVE-S-CONTRACTS.md §3.1, §3.4): uploads run on separate pool connections at
// once, so the chain's rules must hold under real locks, not PGlite's one connection:
//   - two (or more) people superseding the same version at once: exactly one new version joins the chain; every other
//     upload is 409 VERSION_NOT_LATEST naming the winner, and leaves no row (the chain stays linear: the
//     unique index on `supersedes`, and the FOR SHARE re-check in the upload's transaction);
//   - an upload superseding a version while a delete-mode pass collects it: either the version is deleted first and
//     the upload is 404 (nothing stored), or the upload commits first and the version and its new successor both stay.
//     Never a new version whose predecessor vanished under it;
//   - a new version while an approval of the item is being given on another connection (its row locked, 'approved'
//     not committed): the upload's review reset waits for it and resets it to pending about the new version. (The reset
//     used to lock with a `status <> 'pending'` filter in the same statement, so it skipped the item and the approval
//     committed on the old version.)
// Opt-in like apps/api/test/concurrency.pg.test.ts: set DRAFTROOM_TEST_DATABASE_URL (a database these tests may create
// and drop schemas in) to run it; skipped otherwise. DRAFTROOM_PG_STRESS_ITER sets the rounds.

import { VersionNotLatestBody } from '@draftroom/contracts'
import type { AssetVersionMeta } from '@draftroom/dev-assets'
import { SUPERSEDES_HEADER } from '@draftroom/dev-assets'
import { afterEach, describe, expect, it } from 'vitest'
import { originalKey } from '../../src/files/blobs.ts'
import { type AssetGcDeps, collectWorkspace } from '../../src/files/gc.ts'
import { type VersionRef, versionsInRecords } from '../../src/files/gc-refs.ts'
import { baseRecords, createFakeSync, upload } from '../features/history/helpers.ts'
import { createBoard, createTestApi, DEV_STUDIO, ORIGIN, type TestApi } from '../helpers.ts'

const PG_URL = process.env.DRAFTROOM_TEST_DATABASE_URL ?? ''
const ITER = Number(process.env.DRAFTROOM_PG_STRESS_ITER ?? 5)
const DAY = 86_400_000
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const race = <T>(jobs: (() => Promise<T>)[], jitterMs: number) =>
  Promise.all(
    jobs.map(async (j) => {
      await sleep(Math.random() * jitterMs)
      return j()
    }),
  )

let api: TestApi | undefined
afterEach(async () => {
  await api?.close()
  api = undefined
})

async function world() {
  const base = createFakeSync()
  const sync = Object.assign(base, {
    async assetRefs(boardId: string) {
      return {
        boardId,
        exists: base.boards.has(boardId),
        canvas: versionsInRecords(base.records(boardId)),
        deleted: [] as VersionRef[],
        unusedAssetRecords: [],
      }
    },
  })
  api = await createTestApi({ deps: { syncInternal: sync } })
  const t = api
  const alice = await t.login('alice', 'Alice')
  const bob = await t.login('bob', 'Bob')
  const board = await createBoard(alice, DEV_STUDIO, 'Cuts')
  sync.setBoard(board, baseRecords())
  const res = await alice.req('PUT', `/api/boards/${board}/members/${bob.userId}`, { role: 'editor' })
  expect(res.statusCode, res.body).toBe(200)
  const supersede = (cookie: string, prev: AssetVersionMeta, name: string) =>
    t.app.inject({
      method: 'POST',
      url: `/api/boards/${board}/assets`,
      payload: PNG,
      headers: {
        origin: ORIGIN,
        'content-type': 'image/png',
        'x-file-name': name,
        cookie,
        [SUPERSEDES_HEADER]: prev.versionId,
      },
    })
  const deps: AssetGcDeps = {
    db: t.db,
    blobs: t.blobs,
    sync,
    dataRoot: t.config.dataDir,
    now: t.clock.now,
    log: { info: () => {}, warn: () => {} },
  }
  return { t, alice, bob, board, supersede, deps }
}

describe.skipIf(!PG_URL)('versions on real Postgres (DRAFTROOM_TEST_DATABASE_URL)', () => {
  it('two supersedes racing on one version: one joins the chain, the others 409 naming it, nothing else stored', async () => {
    for (let i = 0; i < ITER; i++) {
      const w = await world()
      const v1 = await upload(w.t, w.alice, w.board, 'cut.png')
      const people = [w.alice, w.bob, w.alice, w.bob]
      const res = await race(
        people.map((c, k) => () => w.supersede(c.cookie, v1, `cut-${k}.png`)),
        5,
      )
      const won = res.filter((r) => r.statusCode === 201)
      expect(won, res.map((r) => `${r.statusCode} ${r.body}`).join('\n')).toHaveLength(1)
      const winner = (won[0]?.json() as AssetVersionMeta | undefined)?.versionId
      for (const r of res.filter((x) => x.statusCode !== 201)) {
        expect(r.statusCode, r.body).toBe(409)
        expect(VersionNotLatestBody.parse(r.json()).latestVersionId).toBe(winner)
      }
      const rows = await w.t.db.query<{ id: string; supersedes: string | null }>(
        'SELECT id, supersedes FROM asset_versions WHERE asset_id = $1 ORDER BY created_at, id',
        [v1.assetId],
      )
      expect(rows.rows.map((r) => r.supersedes).sort()).toEqual([v1.versionId, null].sort())
      expect(rows.rows.find((r) => r.supersedes === v1.versionId)?.id).toBe(winner)
      await w.t.close()
      api = undefined
    }
  })

  it('a new version while an approval is being given (two connections): the approval is reset, never left on v1', async () => {
    for (let i = 0; i < ITER; i++) {
      const w = await world()
      const v1 = await upload(w.t, w.alice, w.board, 'cut.png')
      const marked = await w.alice.req('POST', `/api/boards/${w.board}/review/items`, {
        elementId: 'card-1',
        kind: 'file',
        assetId: v1.assetId,
        label: 'Cut',
      })
      expect(marked.statusCode, marked.body).toBe(201)
      const itemId = (marked.json() as { item: { id: string } }).item.id
      // connection 1: an approval that holds the item's row lock and has set 'approved', not committed yet
      let holding: () => void = () => {}
      const held = new Promise<void>((r) => {
        holding = r
      })
      let release: () => void = () => {}
      const gate = new Promise<void>((r) => {
        release = r
      })
      const approval = w.t.db.transaction(async (tx) => {
        await tx.query('SELECT id FROM review_items WHERE id = $1 FOR UPDATE', [itemId])
        await tx.query(
          `UPDATE review_items SET status = 'approved', status_seq = status_seq + 1, status_version_id = $2
            WHERE id = $1`,
          [itemId, v1.versionId],
        )
        holding()
        await gate
      })
      await held
      // connection 2: "Upload new version" (its reset runs in the upload's transaction) while the approval is open
      const up = w.supersede(w.bob.cookie, v1, 'cut-2.png')
      await sleep(300)
      release()
      await approval
      const res = await up
      expect(res.statusCode, res.body).toBe(201)
      const v2 = res.json() as AssetVersionMeta
      // the reset waited for the approval's lock, then saw 'approved' and reset it to pending about v2
      const row = await w.t.db.one<{ status: string; status_version_id: string | null }>(
        'SELECT status, status_version_id FROM review_items WHERE id = $1',
        [itemId],
      )
      expect(row).toEqual({ status: 'pending', status_version_id: v2.versionId })
      const ev = await w.t.db.one<{ reason: string; version_id: string }>(
        "SELECT reason, version_id FROM review_events WHERE item_id = $1 AND kind = 'status' ORDER BY seq DESC LIMIT 1",
        [itemId],
      )
      expect(ev).toEqual({ reason: 'new_version', version_id: v2.versionId })
      await w.t.close()
      api = undefined
    }
  })

  it('a supersede racing the collector’s delete: either 404 and the version gone, or both versions kept', async () => {
    const seen = new Set<string>()
    for (let i = 0; i < ITER * 2; i++) {
      const w = await world()
      const v1 = await upload(w.t, w.alice, w.board, 'cut.png')
      // no board shows it; a complete pass marked it 40 days ago: delete mode may remove it now
      w.t.clock.advance(41 * DAY)
      await w.t.db.query('UPDATE asset_versions SET unreferenced_since = $2 WHERE id = $1', [
        v1.versionId,
        new Date(w.t.clock.now().getTime() - 40 * DAY),
      ])
      const [up] = await race<{ statusCode: number; body: string; json(): unknown } | unknown>(
        [
          () => w.supersede(w.bob.cookie, v1, 'cut-2.png'),
          () => collectWorkspace(w.deps, DEV_STUDIO, 'delete'),
        ],
        8,
      )
      const res = up as { statusCode: number; body: string; json(): unknown }
      const v1Row = await w.t.db.maybeOne('SELECT 1 FROM asset_versions WHERE id = $1', [v1.versionId])
      const v1Blob = await w.t.blobs.head(originalKey(v1.assetId, v1.versionId))
      if (res.statusCode === 201) {
        seen.add('kept')
        const v2 = res.json() as AssetVersionMeta
        expect(v1Row).not.toBeNull()
        expect(v1Blob).not.toBeNull()
        const row = await w.t.db.one<{ supersedes: string | null }>(
          'SELECT supersedes FROM asset_versions WHERE id = $1',
          [v2.versionId],
        )
        expect(row.supersedes).toBe(v1.versionId)
      } else {
        seen.add('collected')
        expect(res.statusCode, res.body).toBe(404)
        expect(v1Row).toBeNull()
        const { n } = await w.t.db.one<{ n: number }>(
          'SELECT count(*)::int AS n FROM asset_versions WHERE asset_id = $1',
          [v1.assetId],
        )
        expect(n).toBe(0)
      }
      await w.t.close()
      api = undefined
    }
    // which side wins is up to the scheduler; both outcomes are correct
    expect(seen.size).toBeGreaterThan(0)
  })
})
