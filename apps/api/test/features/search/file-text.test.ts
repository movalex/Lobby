// Wave W (WS3, docs/WAVE-W-CONTRACTS.md §3, §5): the extract-text op on the api. The kind stores a version's pages from
// the worker's `/text` batches and writes its file_text_state at complete, within the caps (per page, per version, per
// workspace), cleaning what it stores; the api queues the op when a PDF or Office document becomes ready, and the
// backfill queues the rest, paused while previews wait or while no capable worker was seen.

import { FILE_TEXT_LIMITS, WORKER_OP_LIMITS } from '@draftroom/contracts'
import { newId } from '@draftroom/db'
import { afterEach, describe, expect, it } from 'vitest'
import { createFormatsOffer } from '../../../src/features/formats/offer.ts'
import { backfillFileText, enqueueFileText } from '../../../src/features/search/file-backfill.ts'
import { boardsMaybeShowingFiles } from '../../../src/features/search/file-refs.ts'
import { REFS_RETRY_BASE_MS } from '../../../src/features/search/indexer.ts'
import { type Client, createBoard, DEV_STUDIO } from '../../helpers.ts'
import { workerEnv } from '../../worker/helpers.ts'
import {
  addPdf,
  asWorker,
  claimExtract,
  completeExtract,
  EXTRACT_CAPS,
  extract,
  type FileWorld,
  fileWorld,
  queueExtract,
  sendPages,
} from './file-support.ts'

let w: FileWorld | null = null
afterEach(async () => {
  await w?.close()
  w = null
})

async function setup(env?: Record<string, string>) {
  w = await fileWorld(env ? { env } : {})
  const bob = await w.api.login('bob')
  const board = await createBoard(bob, DEV_STUDIO, 'Files')
  return { w, api: w.api, bob, board }
}

const state = (s: { api: FileWorld['api'] }, versionId: string) =>
  s.api.db.maybeOne<{ status: string; pages: number; bytes: number; truncated: boolean; extractor: string }>(
    'SELECT status, pages, bytes, truncated, extractor FROM file_text_state WHERE version_id = $1',
    [versionId],
  )
const pagesOf = async (s: { api: FileWorld['api'] }, versionId: string) =>
  (
    await s.api.db.query<{ page: number; body: string }>(
      'SELECT page, body FROM file_text_pages WHERE version_id = $1 ORDER BY page',
      [versionId],
    )
  ).rows

const ctxOf = (api: FileWorld['api']) => ({
  db: api.db,
  config: api.config,
  formatsOffer: createFormatsOffer({ db: api.db, now: () => api.clock.now(), switches: api.config.formats }),
})

describe('the extract-text kind', () => {
  it('stores cleaned pages and completes done; the op makes no output files', async () => {
    const s = await setup()
    const v = await addPdf(s.api, s.board, s.bob)
    await queueExtract(s.api, v)
    const c = await claimExtract(s.api)
    if (!c) throw new Error('no claim')
    expect(c.op).toMatchObject({
      kind: 'extract-text',
      sourceVersionId: v.versionId,
      params: { maxPages: 300 },
    })
    const out = await asWorker(s.api, `/api/worker/ops/${c.op.id}/output`, {
      workerId: 'nas-1',
      attempt: 1,
      role: 'original',
      mimeType: 'image/png',
      width: 1,
      height: 1,
      bytes: 1,
    })
    expect(out.statusCode).toBe(400)
    expect(out.json().error.code).toBe('NO_OUTPUTS')
    // control characters (the snippet markers among them) and runs of spaces never reach the index
    const [r] = await sendPages(s.api, c, {
      1: 'Hello\u0002 \u0003world\n\n  again',
      3: '   ',
      4: 'Last page',
    })
    expect(r?.statusCode, r?.body).toBe(200)
    const done = await completeExtract(s.api, c, { pages: 3, bytes: 40 })
    expect(done.statusCode, done.body).toBe(200)
    expect(done.json()).toMatchObject({ status: 'done', repeated: false })
    expect(await pagesOf(s, v.versionId)).toEqual([
      { page: 1, body: 'Hello world again' },
      { page: 4, body: 'Last page' },
    ])
    expect(await state(s, v.versionId)).toEqual({
      status: 'done',
      pages: 2,
      bytes: 26,
      truncated: true, // the worker had three pages with text, two are kept
      extractor: FILE_TEXT_LIMITS.extractor,
    })
    // the op is done and has no requester: nobody hears of it
    const op = await s.api.db.one<{ status: string; requested_by: string | null; result: unknown }>(
      'SELECT status, requested_by, result FROM worker_ops WHERE id = $1',
      [c.op.id],
    )
    expect(op).toMatchObject({ status: 'done', requested_by: null })
  })

  it('refuses pages out of order, twice, or past the op range, and a result of the wrong shape', async () => {
    const s = await setup()
    const v = await addPdf(s.api, s.board, s.bob)
    const id = newId('wop')
    await s.api.db.query(
      `INSERT INTO worker_ops (id, workspace_id, board_id, kind, source_version_id, params, params_key, run_after)
       VALUES ($1, $2, $3, 'extract-text', $4, '{"maxPages": 2}'::jsonb, '-', $5)`,
      [id, DEV_STUDIO, s.board, v.versionId, s.api.clock.now()],
    )
    const c = await claimExtract(s.api)
    if (!c) throw new Error('no claim')
    const text = (pages: { page: number; body: string }[]) =>
      asWorker(s.api, `/api/worker/ops/${id}/text`, { workerId: 'nas-1', attempt: 1, pages })
    expect((await text([{ page: 3, body: 'x' }])).json().error.code).toBe('PAGE_OUT_OF_RANGE')
    expect(
      (
        await text([
          { page: 2, body: 'b' },
          { page: 1, body: 'a' },
        ])
      ).json().error.code,
    ).toBe('PAGES_OUT_OF_ORDER')
    expect(
      (
        await text([
          { page: 1, body: 'a' },
          { page: 1, body: 'a' },
        ])
      ).json().error.code,
    ).toBe('PAGES_OUT_OF_ORDER')
    // another worker, or a stale attempt: the lease is not theirs
    const other = await asWorker(s.api, `/api/worker/ops/${id}/text`, {
      workerId: 'nas-2',
      attempt: 1,
      pages: [{ page: 1, body: 'a' }],
    })
    expect(other.statusCode).toBe(409)
    const bad = await asWorker(s.api, `/api/worker/ops/${id}/complete`, {
      workerId: 'nas-1',
      attempt: 1,
      outputs: [],
      result: { pages: 1, bytes: 1, truncated: false, extractor: 'PDF JS', extra: 1 },
    })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().error.code).toBe('INVALID_RESULT')
    expect(await state(s, v.versionId)).toBeNull()
    // a page past what the protocol carries is refused by the contract itself
    expect((await text([{ page: 1, body: 'x'.repeat(8_001) }])).statusCode).toBe(400)
  })

  it('a file with no text (a scan) is empty; its pages are not kept', async () => {
    const s = await setup()
    const v = await addPdf(s.api, s.board, s.bob)
    await queueExtract(s.api, v)
    const c = await claimExtract(s.api)
    if (!c) throw new Error('no claim')
    expect((await completeExtract(s.api, c, { pages: 0 })).statusCode).toBe(200)
    expect(await state(s, v.versionId)).toMatchObject({ status: 'empty', pages: 0, bytes: 0 })
  })

  it('caps a version at 512 KiB of text: later pages are left out, and it says truncated', async () => {
    const s = await setup()
    const v = await addPdf(s.api, s.board, s.bob)
    const pages: Record<number, string> = {}
    for (let p = 1; p <= 70; p++) pages[p] = `${String(p).padStart(4, '0')} ${'a'.repeat(7_990)}`
    await extract(s.api, v, pages)
    const st = await state(s, v.versionId)
    expect(st?.status).toBe('done')
    expect(st?.truncated).toBe(true)
    expect(st?.bytes).toBeLessThanOrEqual(FILE_TEXT_LIMITS.maxVersionBytes)
    expect(st?.pages).toBe(Math.floor(FILE_TEXT_LIMITS.maxVersionBytes / 7_995))
  })

  it('past the workspace budget an extraction stores nothing and says skipped', async () => {
    const s = await setup()
    // 400 versions of 512 KiB each fill the 200 MiB budget exactly (their state rows: no pages needed)
    const per = FILE_TEXT_LIMITS.maxVersionBytes
    const n = Math.ceil(FILE_TEXT_LIMITS.maxWorkspaceBytes / per)
    await s.api.db.query(
      `INSERT INTO asset_versions (id, asset_id, workspace_id, board_id, name, declared_mime_type, mime_type, kind,
                                   size_bytes, sha256, uploaded_by, status)
       SELECT 'ver_fill' || lpad(g::text, 8, '0'), 'ast_fill' || lpad(g::text, 8, '0'), $1, $2, 'f.pdf',
              'application/pdf', 'application/pdf', 'pdf', 1, $3, $4, 'ready'
         FROM generate_series(1, $5::int) AS g`,
      [DEV_STUDIO, s.board, '0'.repeat(64), s.bob.userId, n],
    )
    await s.api.db.query(
      `INSERT INTO file_text_state (version_id, workspace_id, status, pages, bytes, extractor)
       SELECT 'ver_fill' || lpad(g::text, 8, '0'), $1, 'done', 1, $2, 'pdfjs-6.3.289' FROM generate_series(1, $3::int) AS g`,
      [DEV_STUDIO, per, n],
    )
    const v = await addPdf(s.api, s.board, s.bob)
    await extract(s.api, v, { 1: 'over the budget' })
    expect(await state(s, v.versionId)).toMatchObject({ status: 'skipped', pages: 0, bytes: 0 })
    expect(await pagesOf(s, v.versionId)).toEqual([])
  })

  it('a retried run leaves none of the earlier attempt pages behind', async () => {
    const s = await setup()
    const v = await addPdf(s.api, s.board, s.bob)
    const id = await queueExtract(s.api, v)
    const c1 = await claimExtract(s.api)
    if (!c1) throw new Error('no claim')
    await sendPages(s.api, c1, { 1: 'first one', 2: 'first two', 3: 'first three' })
    const fail = await asWorker(s.api, `/api/worker/ops/${id}/fail`, {
      workerId: 'nas-1',
      attempt: 1,
      code: 'TIMEOUT',
      retry: true,
    })
    expect(fail.json()).toMatchObject({ status: 'queued' })
    s.api.clock.advance(WORKER_OP_LIMITS.leaseMs)
    const c2 = await claimExtract(s.api)
    expect(c2?.op.attempt).toBe(2)
    if (!c2) return
    // every run starts with page 1 (empty when it holds no text): the earlier attempt's pages all go
    await sendPages(s.api, c2, { 1: '', 2: 'second two' })
    expect((await completeExtract(s.api, c2, { pages: 1 })).statusCode).toBe(200)
    expect(await pagesOf(s, v.versionId)).toEqual([{ page: 2, body: 'second two' }])
    expect(await state(s, v.versionId)).toMatchObject({ status: 'done', pages: 1, truncated: false })
  })

  it('a later batch drops the stale pages it skips over (ascending order)', async () => {
    const s = await setup()
    const v = await addPdf(s.api, s.board, s.bob)
    await queueExtract(s.api, v)
    const c = await claimExtract(s.api)
    if (!c) throw new Error('no claim')
    await s.api.db.query(
      `INSERT INTO file_text_pages (version_id, workspace_id, page, body, tsv)
       VALUES ($1, $2, 3, 'stale', to_tsvector('simple', 'stale'))`,
      [v.versionId, DEV_STUDIO],
    )
    await sendPages(s.api, c, { 1: 'one' })
    await asWorker(s.api, `/api/worker/ops/${c.op.id}/text`, {
      workerId: 'nas-1',
      attempt: 1,
      pages: [
        { page: 2, body: 'two' },
        { page: 4, body: 'four' },
      ],
    })
    expect((await pagesOf(s, v.versionId)).map((p) => p.page)).toEqual([1, 2, 4])
  })
})

describe('queueing extract-text', () => {
  it('a PDF that becomes ready gets its op, once a capable worker was seen and only with the switch on', async () => {
    const env = await workerEnv({ env: { DRAFTROOM_FILE_SEARCH: 'on' } })
    try {
      const ops = async () =>
        (
          await env.api.db.query<{ source_version_id: string; requested_by: string | null }>(
            "SELECT source_version_id, requested_by FROM worker_ops WHERE kind = 'extract-text'",
          )
        ).rows
      const ready = async (name: string, type: string) => {
        const m = await env.upload(name, Buffer.from('%PDF-1.7\n'), type)
        const claimed = await env.worker('POST', '/api/worker/claim', { workerId: 'w-1' })
        expect(claimed.statusCode, claimed.body).toBe(200)
        const done = await env.worker('POST', `/api/worker/jobs/${m.versionId}/complete`, {
          workerId: 'w-1',
          status: 'ready',
          mimeType: type,
          probe: { pageCount: 1 },
          derivatives: [],
        })
        expect(done.statusCode, done.body).toBe(200)
        return m.versionId
      }
      // no capable worker was seen yet: nothing is queued (the backfill takes it once one is)
      await ready('a.pdf', 'application/pdf')
      expect(await ops()).toEqual([])
      const seen = await env.worker('POST', '/api/worker/ops/claim', {
        workerId: 'nas-1',
        capabilities: EXTRACT_CAPS,
      })
      expect(seen.statusCode).toBe(204)
      const b = await ready('b.pdf', 'application/pdf')
      expect(await ops()).toEqual([{ source_version_id: b, requested_by: null }])
      // an image is never read
      await env.upload('c.png')
      expect(await ops()).toHaveLength(1)
    } finally {
      await env.close()
    }
    const off = await workerEnv({ env: { DRAFTROOM_FILE_SEARCH: 'off' } })
    try {
      const m = await off.upload('d.pdf', Buffer.from('%PDF-1.7\n'), 'application/pdf')
      expect(await enqueueFileText(ctxOf(off.api), m.versionId, off.api.clock.now())).toBe(false)
    } finally {
      await off.close()
    }
  })

  it('the backfill: newest first, at most 10 queued, not while previews or requests wait or without a worker; skips what is done', async () => {
    const s = await setup()
    const ctx = ctxOf(s.api)
    const made: string[] = []
    for (let i = 0; i < 23; i++) {
      s.api.clock.advance(1_000)
      made.push((await addPdf(s.api, s.board, s.bob, `f${i}.pdf`)).versionId)
    }
    // no worker reported extract-text recently
    expect(await backfillFileText(ctx, s.api.clock.now())).toMatchObject({ queued: 0, paused: 'no-worker' })
    expect(
      (await asWorker(s.api, '/api/worker/ops/claim', { workerId: 'nas-1', capabilities: EXTRACT_CAPS }))
        .statusCode,
    ).toBe(204)
    ctx.formatsOffer.invalidate()
    // a preview waiting keeps priority
    const preview = await addPdf(s.api, s.board, s.bob, 'queued.pdf', { status: 'queued' })
    await s.api.db.query(
      `INSERT INTO preview_jobs (version_id, profile, status) VALUES ($1, 'm0-preview-v1', 'queued')`,
      [preview.versionId],
    )
    expect(await backfillFileText(ctx, s.api.clock.now())).toMatchObject({ queued: 0, paused: 'previews' })
    await s.api.db.query('DELETE FROM preview_jobs WHERE version_id = $1', [preview.versionId])
    // one already has text, one failed for good, one failed because no worker could run it, one is not a PDF
    await s.api.db.query(
      `INSERT INTO file_text_state (version_id, workspace_id, status, extractor) VALUES ($1, $2, 'empty', 'pdfjs-6.3.289')`,
      [made[22], DEV_STUDIO],
    )
    const failed = async (versionId: string, code: string) =>
      s.api.db.query(
        `INSERT INTO worker_ops (id, workspace_id, board_id, kind, source_version_id, params, status, error_code,
                                 finished_at)
         VALUES ($1, $2, $3, 'extract-text', $4, '{"maxPages": 300}'::jsonb, 'failed', $5, $6)`,
        [newId('wop'), DEV_STUDIO, s.board, versionId, code, s.api.clock.now()],
      )
    await failed(made[21] as string, 'TEXT_EXTRACT_FAILED')
    await failed(made[20] as string, 'WORKER_UNAVAILABLE')
    const image = await addPdf(s.api, s.board, s.bob, 'p.psd', { mime: 'image/vnd.adobe.photoshop' })
    const queuedNow = async () =>
      (
        await s.api.db.query<{ source_version_id: string }>(
          "SELECT source_version_id FROM worker_ops WHERE kind = 'extract-text' AND status = 'queued'",
        )
      ).rows.map((x) => x.source_version_id)
    // the worker drains what is queued (the test marks it done)
    const drain = () =>
      s.api.db.query(
        `UPDATE worker_ops SET status = 'done', finished_at = $1, updated_at = $1
          WHERE kind = 'extract-text' AND status = 'queued'`,
        [s.api.clock.now()],
      )
    // review M2: never more than backfillMaxQueued (10) queued extract-text ops, so at most 10 of the 20 a sweep may take
    expect(FILE_TEXT_LIMITS.backfillMaxQueued).toBeLessThan(FILE_TEXT_LIMITS.backfillPerSweep)
    const r = await backfillFileText(ctx, s.api.clock.now())
    expect(r).toMatchObject({ queued: FILE_TEXT_LIMITS.backfillMaxQueued, paused: null })
    // newest first: f20 (no worker then: tried again) … f11; never f22 (has text), f21 (failed for good), the PSD
    expect((await queuedNow()).sort()).toEqual(made.slice(11, 21).sort())
    expect(await queuedNow()).not.toContain(image.versionId)
    // while 10 are queued, a sweep adds nothing
    expect(await backfillFileText(ctx, s.api.clock.now())).toMatchObject({ queued: 0, paused: 'backlog' })
    // nor while an op a person asked for waits, whatever the backlog
    await drain()
    const asked = newId('wop')
    await s.api.db.query(
      `INSERT INTO worker_ops (id, workspace_id, board_id, kind, source_version_id, params, params_key, requested_by)
       VALUES ($1, $2, $3, 'render-pages', $4, '{"from": 9, "to": 12}'::jsonb, '9-12', $5)`,
      [asked, DEV_STUDIO, s.board, made[0], s.bob.userId],
    )
    expect(await backfillFileText(ctx, s.api.clock.now())).toMatchObject({ queued: 0, paused: 'requests' })
    await s.api.db.query(
      `UPDATE worker_ops SET status = 'cancelled', error_code = 'CANCELLED', finished_at = $2 WHERE id = $1`,
      [asked, s.api.clock.now()],
    )
    const next = await backfillFileText(ctx, s.api.clock.now())
    expect(next.queued).toBe(10)
    expect((await queuedNow()).sort()).toEqual(made.slice(1, 11).sort())
    await drain()
    // a last sweep makes no second op for any of them, and finds f0
    const again = await backfillFileText(ctx, s.api.clock.now())
    expect(again.queued).toBe(1)
    expect(
      (
        await s.api.db.one<{ n: number }>(
          "SELECT count(*)::int AS n FROM worker_ops WHERE kind = 'extract-text'",
        )
      ).n,
    ).toBe(23)
  })

  it('the backfill clears the pages a run left without a state; never those of a running op', async () => {
    const s = await setup()
    const ctx = ctxOf(s.api)
    const left = await addPdf(s.api, s.board, s.bob)
    const running = await addPdf(s.api, s.board, s.bob)
    for (const v of [left, running])
      await s.api.db.query(
        `INSERT INTO file_text_pages (version_id, workspace_id, page, body, tsv)
         VALUES ($1, $2, 1, 'partial', to_tsvector('simple', 'partial'))`,
        [v.versionId, DEV_STUDIO],
      )
    await queueExtract(s.api, running)
    expect((await backfillFileText(ctx, s.api.clock.now())).orphansCleared).toBe(1)
    expect(await pagesOf(s, left.versionId)).toEqual([])
    expect(await pagesOf(s, running.versionId)).toHaveLength(1)
  })
})

describe('board_file_refs', () => {
  it('a board indexed before this build gets its refs once per process; a failed read is tried again', async () => {
    const s = await setup()
    const v = await addPdf(s.api, s.board, s.bob)
    s.w.sync.setRefs(s.board, [v])
    // the board's canvas text is current: no reindex would read its refs
    await s.w.indexer.refreshCanvas(s.board)
    await s.api.db.query('DELETE FROM board_file_refs WHERE board_id = $1', [s.board])
    s.w.sync.refsFailing = true
    await s.w.indexer.runPass()
    expect(s.w.indexer.fileRefsWalkFinished()).toBe(false)
    s.w.sync.refsFailing = false
    // tried again once its backoff is over (review m2)
    s.api.clock.advance(REFS_RETRY_BASE_MS)
    await s.w.indexer.runPass()
    const rows = await s.api.db.query('SELECT version_id FROM board_file_refs WHERE board_id = $1', [s.board])
    expect(rows.rows).toEqual([{ version_id: v.versionId }])
    expect(s.w.indexer.fileRefsWalkFinished()).toBe(true)
    // the walk is over the open boards with a PDF (uploaded or linked) only
    const plain = await createBoard(s.bob as Client, DEV_STUDIO, 'Plain')
    const walked = (await boardsMaybeShowingFiles(s.api.db, '', 100)).map((r) => r.id)
    expect(walked).toContain(s.board)
    expect(walked).not.toContain(plain)
  })

  it('a refresh asked for while one is in flight reads again after it: a removed card never comes back (review m1)', async () => {
    const s = await setup()
    const v = await addPdf(s.api, s.board, s.bob)
    s.w.sync.setRefs(s.board, [v])
    const original = s.w.sync.assetRefs
    if (!original) throw new Error('the fake sync answers asset refs')
    const read = original.bind(s.w.sync)
    let release: () => void = () => {}
    let gate: Promise<void> | null = new Promise<void>((r) => {
      release = r
    })
    // the first read sees the card, then waits (a slow sync answer)
    s.w.sync.assetRefs = async (boardId: string) => {
      const answer = await read(boardId)
      if (gate) await gate
      return answer
    }
    const before = s.w.sync.refsCalls.length
    const first = s.w.indexer.refreshFileRefs(s.board)
    await new Promise((r) => setTimeout(r, 10))
    // the card is deleted, and the canvas reindex asks for the refs again while the first read is in flight
    s.w.sync.setRefs(s.board, [], { deleted: [v] })
    const second = s.w.indexer.refreshFileRefs(s.board)
    const third = s.w.indexer.refreshFileRefs(s.board)
    gate = null
    release()
    await Promise.all([first, second, third])
    // two reads, not one (the asks during the first coalesce into one more), and the last write is the new canvas
    expect(s.w.sync.refsCalls.length - before).toBe(2)
    const rows = await s.api.db.query('SELECT version_id FROM board_file_refs WHERE board_id = $1', [s.board])
    expect(rows.rows).toEqual([])
  })

  it('a failed refresh is retried with a backoff, not by every pass (review m2)', async () => {
    const s = await setup()
    const v = await addPdf(s.api, s.board, s.bob)
    s.w.sync.setRefs(s.board, [v])
    // the walk is done, so only the retry list reads boards
    await s.w.indexer.runPass()
    expect(s.w.indexer.fileRefsWalkFinished()).toBe(true)
    s.w.sync.refsFailing = true
    await s.w.indexer.refreshFileRefs(s.board)
    const calls = () => s.w.sync.refsCalls.filter((b) => b === s.board).length
    const n0 = calls()
    await s.w.indexer.runPass()
    await s.w.indexer.runPass()
    expect(calls()).toBe(n0)
    s.api.clock.advance(REFS_RETRY_BASE_MS)
    await s.w.indexer.runPass()
    expect(calls()).toBe(n0 + 1)
    // failed again: the next wait is twice as long
    s.api.clock.advance(REFS_RETRY_BASE_MS)
    await s.w.indexer.runPass()
    expect(calls()).toBe(n0 + 1)
    s.api.clock.advance(REFS_RETRY_BASE_MS)
    s.w.sync.refsFailing = false
    await s.w.indexer.runPass()
    expect(calls()).toBe(n0 + 2)
    expect(s.w.indexer.fileRefsWalkFinished()).toBe(true)
  })
})
