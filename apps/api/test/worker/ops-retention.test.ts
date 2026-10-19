// Wave W follow-up (review nit 2): the finished worker ops' retention (src/worker/ops-retention.ts). Ops that finished
// more than 30 days ago go with their outputs rows, but never the rows that keep a file out of the extract-text
// backfill: a purged permanently failed file is not tried again. A left-over output's blob goes to the file
// collector's queue only when no row uses it.

import { newId } from '@draftroom/db'
import { newId as newAssetId } from '@draftroom/dev-assets'
import { afterEach, describe, expect, it } from 'vitest'
import { createFormatsOffer } from '../../src/features/formats/offer.ts'
import { backfillFileText } from '../../src/features/search/file-backfill.ts'
import { OP_RETENTION, purgeFinishedOps } from '../../src/worker/ops-retention.ts'
import { addPdf, asWorker, EXTRACT_CAPS, type FileWorld, fileWorld } from '../features/search/file-support.ts'
import { createBoard, DEV_STUDIO } from '../helpers.ts'

let w: FileWorld | null = null
afterEach(async () => {
  await w?.close()
  w = null
})

const DAY = 24 * 60 * 60 * 1000

async function setup() {
  w = await fileWorld()
  const bob = await w.api.login('bob')
  const board = await createBoard(bob, DEV_STUDIO, 'Files')
  return { api: w.api, bob, board }
}

type S = Awaited<ReturnType<typeof setup>>

/** A finished op of `kind` on `versionId`, `ageDays` ago. */
async function finished(
  s: S,
  versionId: string,
  o: { kind?: string; status: 'done' | 'failed' | 'cancelled'; code?: string; ageDays: number },
): Promise<string> {
  const id = newId('wop')
  const at = new Date(s.api.clock.now().getTime() - o.ageDays * DAY)
  const kind = o.kind ?? 'extract-text'
  const params =
    kind === 'render-pages' ? '{"from": 9, "to": 12}' : kind === 'remove-bg' ? '{}' : '{"maxPages": 300}'
  await s.api.db.query(
    `INSERT INTO worker_ops (id, workspace_id, board_id, kind, source_version_id, params, params_key, status, error_code,
                             result, created_at, updated_at, finished_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10::jsonb, $11, $11, $11)`,
    [
      id,
      DEV_STUDIO,
      s.board,
      kind,
      versionId,
      params,
      kind === 'render-pages' ? '9-12' : '-',
      o.status,
      o.status === 'done' ? null : (o.code ?? (o.status === 'cancelled' ? 'CANCELLED' : 'INTERNAL')),
      o.status === 'done' ? '{}' : null,
      at,
    ],
  )
  return id
}

const textState = (s: S, versionId: string) =>
  s.api.db.query(
    `INSERT INTO file_text_state (version_id, workspace_id, status, extractor) VALUES ($1, $2, 'done', 'pdfjs-6.3.289')`,
    [versionId, DEV_STUDIO],
  )

const opIds = async (s: S) =>
  (await s.api.db.query<{ id: string }>('SELECT id FROM worker_ops ORDER BY id')).rows.map((r) => r.id).sort()

const ctxOf = (s: S) => ({
  db: s.api.db,
  config: s.api.config,
  formatsOffer: createFormatsOffer({
    db: s.api.db,
    now: () => s.api.clock.now(),
    switches: s.api.config.formats,
  }),
})

describe('the retention of finished worker ops', () => {
  it('purges what is older than 30 days, never what keeps a file out of the backfill', async () => {
    const s = await setup()
    expect(OP_RETENTION.keepMs).toBe(30 * DAY)
    const v = async (name: string) => (await addPdf(s.api, s.board, s.bob, name)).versionId
    const tooComplex = await v('complex.pdf')
    const failedText = await v('broken.pdf')
    const noWorker = await v('nobody.pdf')
    const withText = await v('text.pdf')
    const doneNoState = await v('odd.pdf')
    const deck = await v('deck.pdf')
    const recent = await v('recent.pdf')
    const keep = [
      await finished(s, tooComplex, { status: 'failed', code: 'FILE_TOO_COMPLEX', ageDays: 40 }),
      await finished(s, failedText, { status: 'failed', code: 'TEXT_EXTRACT_FAILED', ageDays: 90 }),
      await finished(s, doneNoState, { status: 'done', ageDays: 40 }),
      await finished(s, recent, { status: 'done', kind: 'render-pages', ageDays: 29 }),
    ]
    await textState(s, withText)
    const gone = [
      await finished(s, noWorker, { status: 'failed', code: 'WORKER_UNAVAILABLE', ageDays: 40 }),
      await finished(s, withText, { status: 'done', ageDays: 40 }),
      await finished(s, deck, { status: 'done', kind: 'render-pages', ageDays: 31 }),
      await finished(s, deck, {
        status: 'failed',
        kind: 'render-pages',
        code: 'FILE_TOO_COMPLEX',
        ageDays: 31,
      }),
      await finished(s, deck, { status: 'cancelled', kind: 'remove-bg', ageDays: 60 }),
    ]
    expect(await purgeFinishedOps(s.api.db, s.api.clock.now())).toEqual({ ops: gone.length, blobsQueued: 0 })
    expect(await opIds(s)).toEqual(keep.sort())
    // a second sweep finds nothing more
    expect(await purgeFinishedOps(s.api.db, s.api.clock.now())).toEqual({ ops: 0, blobsQueued: 0 })
  })

  it('the backfill does not try a purged permanently failed file again', async () => {
    const s = await setup()
    const failedForGood = (await addPdf(s.api, s.board, s.bob, 'complex.pdf')).versionId
    const unavailable = (await addPdf(s.api, s.board, s.bob, 'nobody.pdf')).versionId
    await finished(s, failedForGood, { status: 'failed', code: 'FILE_TOO_COMPLEX', ageDays: 45 })
    await finished(s, unavailable, { status: 'failed', code: 'WORKER_UNAVAILABLE', ageDays: 45 })
    await purgeFinishedOps(s.api.db, s.api.clock.now())
    // a capable worker checks in, so the backfill runs
    expect(
      (await asWorker(s.api, '/api/worker/ops/claim', { workerId: 'nas-1', capabilities: EXTRACT_CAPS }))
        .statusCode,
    ).toBe(204)
    const r = await backfillFileText(ctxOf(s), s.api.clock.now())
    expect(r).toMatchObject({ queued: 1, paused: null })
    const queued = await s.api.db.query<{ source_version_id: string }>(
      "SELECT source_version_id FROM worker_ops WHERE kind = 'extract-text' AND status = 'queued'",
    )
    // the file no worker could run is tried again (as before the purge); the one that failed for good is not
    expect(queued.rows.map((x) => x.source_version_id)).toEqual([unavailable])
  })

  it('a left-over output goes with its op; its blob is queued for the collector only when no row uses it', async () => {
    const s = await setup()
    const src = await addPdf(s.api, s.board, s.bob, 'deck.pdf')
    const op = await finished(s, src.versionId, { status: 'done', kind: 'render-pages', ageDays: 40 })
    const used = `assets/${src.assetId}/${src.versionId}/d/${newAssetId('drv')}.webp`
    const unused = `assets/${src.assetId}/${src.versionId}/d/${newAssetId('drv')}.webp`
    const usedDrv = used.slice(used.lastIndexOf('/') + 1, -'.webp'.length)
    await s.api.db.query(
      `INSERT INTO asset_derivatives (id, version_id, position, role, page, width, height, mime_type, bytes, blob_key)
       VALUES ($1, $2, 9, 'page', 9, 100, 100, 'image/webp', 10, $3)`,
      [usedDrv, src.versionId, used],
    )
    for (const [key, page] of [
      [used, 9],
      [unused, 10],
    ] as const)
      await s.api.db.query(
        `INSERT INTO worker_op_outputs (id, op_id, attempt, role, page, width, height, mime_type, bytes, asset_id,
                                        version_id, derivative_id, blob_key)
         VALUES ($1, $2, 1, 'page', $3, 100, 100, 'image/webp', 10, $4, $5, $6, $7)`,
        [
          newId('wpo'),
          op,
          page,
          src.assetId,
          src.versionId,
          key.slice(key.lastIndexOf('/') + 1, -'.webp'.length),
          key,
        ],
      )
    expect(await purgeFinishedOps(s.api.db, s.api.clock.now())).toEqual({ ops: 1, blobsQueued: 1 })
    const outputs = await s.api.db.one<{ n: number }>('SELECT count(*)::int AS n FROM worker_op_outputs')
    expect(outputs.n).toBe(0)
    const pending = await s.api.db.query<{ blob_key: string }>(
      'SELECT blob_key FROM asset_gc_pending_deletes',
    )
    expect(pending.rows.map((r) => r.blob_key)).toEqual([unused])
  })
})
