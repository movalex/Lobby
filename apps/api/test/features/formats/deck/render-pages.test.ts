// WS4 (wave W, deck import; docs/WAVE-W-CONTRACTS.md §6, §8): POST /api/files/:ver/render-pages and the render-pages
// kind on the worker side, against the whole api (PGlite, fs-mode blobs, a test clock) and a fake worker that talks
// /api/worker/ops/* the way apps/worker does. The pages of a deck past the preview's eight become `page` derivatives of
// the SOURCE version, one row a page whatever runs twice; the request is held to its switch, its capable worker, the
// board's rules and the version's.

import {
  DECK_LIMITS,
  deckRenderRuns,
  FILE_OP_EVENT,
  FileOpEvent,
  FileOpState,
  FORMAT_GUESTS_MESSAGE,
  renderPagesPath,
  WorkerOpClaimed,
} from '@draftroom/contracts'
import { newId as newAssetId } from '@draftroom/dev-assets'
import { afterEach, describe, expect, it } from 'vitest'
import { EventHub } from '../../../../src/events/hub.ts'
import { DECK_MESSAGES } from '../../../../src/features/formats/deck/index.ts'
import { renderPagesKind } from '../../../../src/features/formats/deck/kind.ts'
import { OP_KINDS } from '../../../../src/worker/ops-kinds.ts'
import { type Client, createBoard, DEV_STUDIO } from '../../../helpers.ts'
import { pathOf, type WorkerEnv, workerEnv } from '../../../worker/helpers.ts'
import { guestLink, joinAsGuest } from '../../guests/support.ts'

const PDF = Buffer.from('%PDF-1.4\n1 0 obj <<>> endobj\ntrailer <<>>\n%%EOF\n')
const PAGE_BYTES = Buffer.alloc(64, 7)

let env: WorkerEnv | null = null
afterEach(async () => {
  await env?.close()
  env = null
})

interface Sent {
  type: string
  data: unknown
}

async function setup(opts: { env?: Record<string, string>; capable?: boolean } = {}) {
  const hub = new EventHub()
  const sent: Sent[] = []
  const orig = hub.publish.bind(hub)
  hub.publish = (boardId, event, o = {}) => {
    sent.push({ type: event.type, data: event.data })
    orig(boardId, event, o)
  }
  let now = new Date('2026-10-19T12:00:00Z')
  const e = await workerEnv({
    env: { DRAFTROOM_DECK_IMPORT: 'on', ...opts.env },
    deps: { events: hub, now: () => now },
  })
  env = e
  const db = e.api.db

  /** bob's deck of `pages` pages on `board`, ready, with the preview's pages 1..min(8, pages) rendered. */
  async function deck(
    pages: number,
    o: { name?: string; mime?: string; board?: string; status?: string } = {},
  ) {
    const m = await e.upload(o.name ?? 'deck.pdf', PDF, 'application/pdf', o.board ?? e.board)
    await db.query(
      `UPDATE asset_versions SET status = $2, mime_type = $3, probe = jsonb_build_object('pageCount', $4::int)
        WHERE id = $1`,
      [m.versionId, o.status ?? 'ready', o.mime ?? 'application/pdf', pages],
    )
    await db.query(`UPDATE preview_jobs SET status = 'done' WHERE version_id = $1`, [m.versionId])
    for (let n = 1; n <= Math.min(pages, DECK_LIMITS.eagerPages); n++) await pageRow(m, n, n - 1)
    return m
  }
  async function pageRow(m: { assetId: string; versionId: string }, page: number, position: number) {
    const id = newAssetId('drv')
    await db.query(
      `INSERT INTO asset_derivatives (id, version_id, position, role, page, width, height, mime_type, bytes, blob_key)
       VALUES ($1, $2, $3, 'page', $4, 1024, 768, 'image/webp', 10, $5)`,
      [id, m.versionId, position, page, `assets/${m.assetId}/${m.versionId}/d/${id}.webp`],
    )
  }
  const pagesOf = async (versionId: string) =>
    (
      await db.query<{ page: number; position: number }>(
        `SELECT page, position FROM asset_derivatives WHERE version_id = $1 AND role = 'page' ORDER BY page, position`,
        [versionId],
      )
    ).rows
  const opsClaim = (workerId = 'nas-1', capabilities = ['render-pages@1']) =>
    e.worker('POST', '/api/worker/ops/claim', { workerId, capabilities })
  if (opts.capable !== false) expect((await opsClaim()).statusCode).toBe(204)
  const request = (c: Pick<Client, 'req'>, versionId: string, boardId: string = e.board) =>
    c.req('POST', renderPagesPath(versionId), { boardId })
  const ops = (versionId: string) =>
    db
      .query<{ id: string; params: unknown; params_key: string; requested_by: string; status: string }>(
        `SELECT id, params, params_key, requested_by, status FROM worker_ops WHERE source_version_id = $1
          ORDER BY params_key`,
        [versionId],
      )
      .then((r) => r.rows)

  /** The fake worker: claims, reserves and PUTs `pages`, completes. */
  async function work(pages: (run: { from: number; to: number }) => number[], workerId = 'nas-1') {
    const claimed = await opsClaim(workerId)
    expect(claimed.statusCode, claimed.body).toBe(200)
    const op = WorkerOpClaimed.parse(claimed.json()).op
    const lease = { workerId, attempt: op.attempt }
    const run = op.params as { from: number; to: number }
    const outputs: string[] = []
    const refused: { page: number; code: string }[] = []
    for (const page of pages(run)) {
      const r = await reserve(op.id, lease, page)
      if (r.statusCode !== 200) {
        refused.push({ page, code: r.json().error.code })
        continue
      }
      const reserved = r.json() as {
        outputId: string
        upload: { url: string; headers: Record<string, string> }
      }
      const put = await e.api.app.inject({
        method: 'PUT',
        url: pathOf(reserved.upload.url),
        headers: reserved.upload.headers,
        payload: PAGE_BYTES,
      })
      expect(put.statusCode, put.body).toBe(200)
      outputs.push(reserved.outputId)
    }
    const made = pages(run).filter((p) => !refused.some((x) => x.page === p))
    const complete = () =>
      e.worker('POST', `/api/worker/ops/${op.id}/complete`, {
        ...lease,
        outputs,
        result: { pageCount: op.source.pageCount ?? 1, rendered: made },
      })
    return { op, lease, run, refused, complete }
  }
  const reserve = (opId: string, lease: { workerId: string; attempt: number }, page: number, over = {}) =>
    e.worker('POST', `/api/worker/ops/${opId}/output`, {
      ...lease,
      role: 'page',
      page,
      mimeType: 'image/webp',
      width: 1024,
      height: 768,
      bytes: PAGE_BYTES.length,
      ...over,
    })

  return {
    e,
    db,
    sent,
    deck,
    pageRow,
    pagesOf,
    request,
    ops,
    opsClaim,
    work,
    reserve,
    tick: (ms: number) => {
      now = new Date(now.getTime() + ms)
    },
  }
}

describe('POST /api/files/:ver/render-pages', () => {
  it('one queued op per missing run of pages 9..min(N, 100), in one go; 202 with the first op’s state', async () => {
    const s = await setup()
    const m = await s.deck(40)
    const res = await s.request(s.e.bob, m.versionId)
    expect(res.statusCode, res.body).toBe(202)
    const state = FileOpState.parse(res.json())
    expect(state).toMatchObject({
      kind: 'render-pages',
      status: 'queued',
      boardId: s.e.board,
      sourceVersionId: m.versionId,
      resultVersionId: null,
      pagesReady: null,
      errorCode: null,
    })
    const rows = await s.ops(m.versionId)
    expect(rows.map((r) => [r.params_key, r.params, r.status, r.requested_by])).toEqual([
      ['39-40', { from: 39, to: 40 }, 'queued', s.e.bob.userId],
      ['9-38', { from: 9, to: 38 }, 'queued', s.e.bob.userId],
    ])
    expect(rows.map((r) => r.id)).toContain(state.id)
    expect(rows.find((r) => r.params_key === '9-38')?.id).toBe(state.id)
    // both are active: asking again makes nothing
    const again = await s.request(s.e.bob, m.versionId)
    expect(again.statusCode).toBe(409)
    expect(again.json().error).toEqual({ code: 'FILE_OP_ACTIVE', message: DECK_MESSAGES.active })
    expect(await s.ops(m.versionId)).toHaveLength(2)
  })

  it('a deck of more than 100 pages gets pages 9..100 only, in runs of at most 30', async () => {
    const s = await setup()
    const m = await s.deck(240)
    expect((await s.request(s.e.bob, m.versionId)).statusCode).toBe(202)
    expect((await s.ops(m.versionId)).map((r) => r.params_key).sort()).toEqual(
      ['9-38', '39-68', '69-98', '99-100'].sort(),
    )
    expect(deckRenderRuns(240)).toEqual([
      { from: 9, to: 38 },
      { from: 39, to: 68 },
      { from: 69, to: 98 },
      { from: 99, to: 100 },
    ])
  })

  it('8 pages or fewer, or every page made already: 409 NOTHING_TO_RENDER (the web places at once)', async () => {
    const s = await setup()
    const small = await s.deck(8)
    const res = await s.request(s.e.bob, small.versionId)
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toEqual({ code: 'NOTHING_TO_RENDER', message: DECK_MESSAGES.nothing })
    const full = await s.deck(10)
    await s.pageRow(full, 9, 9)
    await s.pageRow(full, 10, 10)
    expect((await s.request(s.e.bob, full.versionId)).json().error.code).toBe('NOTHING_TO_RENDER')
    expect(await s.ops(small.versionId)).toEqual([])
    expect(await s.ops(full.versionId)).toEqual([])
  })

  it('only the runs that miss a page, and not one already running for someone else', async () => {
    const s = await setup()
    const m = await s.deck(70)
    // pages 9..38 were made before; 39..68 are being made for another request
    for (let n = 9; n <= 38; n++) await s.pageRow(m, n, n - 1)
    const carol = await s.e.api.login('carol')
    const grant = await s.e.bob.req('PUT', `/api/boards/${s.e.board}/members/${carol.userId}`, {
      role: 'editor',
    })
    expect(grant.statusCode, grant.body).toBe(200)
    const first = await s.request(carol, m.versionId)
    expect(first.statusCode, first.body).toBe(202)
    expect((await s.ops(m.versionId)).map((r) => r.params_key).sort()).toEqual(['39-68', '69-70'])
    // bob now: both missing runs are active (carol's): nothing new, and nothing of carol's is shown to him
    const bob = await s.request(s.e.bob, m.versionId)
    expect(bob.statusCode).toBe(409)
    expect(bob.body).not.toContain('wop_')
    // one of them ends: bob's request makes that run again, only that one
    await s.e.api.db.query(
      `UPDATE worker_ops SET status = 'failed', error_code = 'TIMEOUT', finished_at = now() WHERE params_key = '69-70'`,
    )
    const retry = await s.request(s.e.bob, m.versionId)
    expect(retry.statusCode, retry.body).toBe(202)
    const rows = await s.ops(m.versionId)
    expect(rows.filter((r) => r.status === 'queued').map((r) => [r.params_key, r.requested_by])).toEqual([
      ['39-68', carol.userId],
      ['69-70', s.e.bob.userId],
    ])
  })

  it('the version: kind, type and state are checked; a file of another board is not served here', async () => {
    const s = await setup()
    const docx = await s.deck(20, {
      name: 'notes.docx',
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    })
    const r1 = await s.request(s.e.bob, docx.versionId)
    expect(r1.statusCode).toBe(400)
    expect(r1.json().error).toEqual({ code: 'FILE_OP_UNSUPPORTED', message: DECK_MESSAGES.unsupported })
    const pptx = await s.deck(20, {
      name: 'deck.pptx',
      mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    })
    expect((await s.request(s.e.bob, pptx.versionId)).statusCode).toBe(202)
    const busy = await s.deck(20, { status: 'processing' })
    const r2 = await s.request(s.e.bob, busy.versionId)
    expect(r2.statusCode).toBe(409)
    expect(r2.json().error.code).toBe('FILE_NOT_READY')
    const image = await s.e.upload('photo.png')
    expect((await s.request(s.e.bob, image.versionId)).json().error.code).toBe('FILE_OP_UNSUPPORTED')
    // a deck uploaded to bob's other board: not served on this one (no link)
    const other = await createBoard(s.e.bob, DEV_STUDIO, 'Elsewhere')
    const there = await s.deck(20, { board: other })
    expect((await s.request(s.e.bob, there.versionId)).statusCode).toBe(404)
    expect((await s.request(s.e.bob, there.versionId, other)).statusCode).toBe(202)
    // a made-up or malformed version id
    expect((await s.request(s.e.bob, 'ver_00000000000000000000')).statusCode).toBe(404)
    expect((await s.request(s.e.bob, 'nope')).statusCode).toBe(404)
  })

  it('who may: an editor with an account; 401, 403 below edit, 404 off the board, 409 archived; guests 403', async () => {
    const s = await setup()
    const m = await s.deck(20)
    const viewer = await s.e.api.login('vera')
    const commenter = await s.e.api.login('cole')
    const outsider = await s.e.api.login('erin')
    for (const [c, role] of [
      [viewer, 'viewer'],
      [commenter, 'commenter'],
    ] as const) {
      const g = await s.e.bob.req('PUT', `/api/boards/${s.e.board}/members/${c.userId}`, { role })
      expect(g.statusCode, g.body).toBe(200)
      const r = await s.request(c, m.versionId)
      expect(r.statusCode, role).toBe(403)
    }
    expect((await s.request(outsider, m.versionId)).statusCode).toBe(404)
    expect(
      (await s.e.api.anon('POST', renderPagesPath(m.versionId), { boardId: s.e.board })).statusCode,
    ).toBe(401)
    // a name-only guest with an editor link: the guard refuses before any board check
    const link = await guestLink(s.e.bob, s.e.board, { role: 'editor' })
    const sam = await joinAsGuest(s.e.api, link.url, 'Sam')
    const g = await sam.req('POST', renderPagesPath(m.versionId), { boardId: s.e.board })
    expect(g.statusCode).toBe(403)
    expect(g.json().error).toEqual({ code: 'GUEST_ACCOUNT_REQUIRED', message: FORMAT_GUESTS_MESSAGE })
    // the body is strict
    expect(
      (await s.e.bob.req('POST', renderPagesPath(m.versionId), { boardId: s.e.board, x: 1 })).statusCode,
    ).toBe(400)
    // archived: 409, nothing queued
    expect((await s.e.bob.req('POST', `/api/boards/${s.e.board}/archive`)).statusCode).toBe(200)
    const a = await s.request(s.e.bob, m.versionId)
    expect(a.statusCode).toBe(409)
    expect(a.json().error).toEqual({ code: 'BOARD_ARCHIVED', message: DECK_MESSAGES.archived })
    expect(await s.ops(m.versionId)).toEqual([])
  })

  it('no worker that can make slides seen in 10 minutes, or the switch off: the unknown route', async () => {
    const off = await setup({ capable: false })
    const m = await off.deck(20)
    const r = await off.request(off.e.bob, m.versionId)
    expect(r.statusCode).toBe(404)
    expect(r.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Not found.' } })
    // a worker reports it: offered (the claim forgets the offer's cache)
    expect((await off.opsClaim()).statusCode).toBe(204)
    expect((await off.request(off.e.bob, m.versionId)).statusCode).toBe(202)
    await env?.close()
    env = null
    const sw = await setup({ env: { DRAFTROOM_DECK_IMPORT: 'off' } })
    const d = await sw.deck(20)
    const res = await sw.request(sw.e.bob, d.versionId)
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Not found.' } })
  })
})

describe('the render-pages kind', () => {
  it('pages become page derivatives of the source after the existing ones; the requester hears pagesReady', async () => {
    const s = await setup()
    const m = await s.deck(12)
    expect((await s.request(s.e.bob, m.versionId)).statusCode).toBe(202)
    const w = await s.work((r) =>
      [r.from, r.from + 1, r.from + 2, r.to].filter((p, i, a) => a.indexOf(p) === i),
    )
    expect(w.run).toEqual({ from: 9, to: 12 })
    expect(w.op.source).toMatchObject({ kind: 'pdf', pageCount: 12 })
    const done = await w.complete()
    expect(done.json()).toEqual({ opId: w.op.id, status: 'done', repeated: false })
    const pages = await s.pagesOf(m.versionId)
    expect(pages.map((p) => p.page)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    expect(pages.slice(8).map((p) => p.position)).toEqual([8, 9, 10, 11])
    // the meta route lists them, as it lists a preview's pages
    const meta = await s.e.meta(m)
    expect(meta.derivatives.filter((d) => d.role === 'page').map((d) => d.page)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ])
    const events = s.sent.filter((x) => x.type === FILE_OP_EVENT).map((x) => FileOpEvent.parse(x.data).op)
    expect(events.map((o) => [o.status, o.pagesReady])).toEqual([
      ['running', null],
      ['done', 12],
    ])
    // the source version did not change status: no assets.version event for it
    expect(s.sent.some((x) => x.type === 'assets.version')).toBe(false)
    // a double complete is answered as such and adds nothing
    const repeat = await w.complete()
    expect(repeat.json()).toEqual({ opId: w.op.id, status: 'done', repeated: true })
    expect(await s.pagesOf(m.versionId)).toHaveLength(12)
  })

  it('what a lease holder may reserve: pages of its run only, at the preview size, once, and never one that exists', async () => {
    const s = await setup()
    const m = await s.deck(40)
    await s.pageRow(m, 20, 20)
    expect((await s.request(s.e.bob, m.versionId)).statusCode).toBe(202)
    const claimed = WorkerOpClaimed.parse((await s.opsClaim()).json()).op
    expect(claimed.params).toEqual({ from: 9, to: 38 })
    const lease = { workerId: 'nas-1', attempt: 1 }
    const code = async (page: number, over = {}) => {
      const r = await s.reserve(claimed.id, lease, page, over)
      return r.statusCode === 200 ? 200 : `${r.statusCode} ${r.json().error.code}`
    }
    expect(await code(8)).toBe('400 PAGE_OUT_OF_RANGE')
    expect(await code(39)).toBe('400 PAGE_OUT_OF_RANGE')
    expect(await code(9, { role: 'original', page: undefined })).toBe('400 OUTPUT_REFUSED')
    expect(await code(9, { width: 2048 })).toBe('400 OUTPUT_REFUSED')
    expect(await code(9, { height: 5000 })).toBe('400 OUTPUT_REFUSED')
    expect(await code(20)).toBe('409 PAGE_EXISTS')
    expect(await code(9)).toBe(200)
    expect(await code(9)).toBe('409 DUPLICATE_PAGE')
    // a tall page: narrower than the width, up to the child's 4096 cap
    expect(await code(10, { width: 300, height: 4096 })).toBe(200)
    // text is not this kind's
    const t = await s.e.worker('POST', `/api/worker/ops/${claimed.id}/text`, {
      ...lease,
      pages: [{ page: 9, body: 'x' }],
    })
    expect(t.statusCode).toBe(400)
    expect(t.json().error.code).toBe('TEXT_REFUSED')
  })

  it('a re-run renders only what is missing, and a page made meanwhile is kept once (no unique index)', async () => {
    const s = await setup()
    const m = await s.deck(14)
    expect((await s.request(s.e.bob, m.versionId)).statusCode).toBe(202)
    expect((await (await s.work((r) => range(r.from, r.to))).complete()).statusCode).toBe(200)
    expect((await s.pagesOf(m.versionId)).map((p) => p.page)).toEqual(range(1, 14))
    // page 11 is lost (say a damaged blob was cleared): asking again makes the run once more, and the worker's
    // reservations of the pages that exist are refused, so only page 11 is rendered and published
    await s.db.query(`DELETE FROM asset_derivatives WHERE version_id = $1 AND page = 11`, [m.versionId])
    const again = await s.request(s.e.bob, m.versionId)
    expect(again.statusCode, again.body).toBe(202)
    const w = await s.work((r) => range(r.from, r.to))
    expect(w.refused.map((x) => x.page)).toEqual([9, 10, 12, 13, 14])
    expect(new Set(w.refused.map((x) => x.code))).toEqual(new Set(['PAGE_EXISTS']))
    // meanwhile another op published page 11 too: the completer skips it under the version's lock
    await s.pageRow(m, 11, 40)
    const done = await w.complete()
    expect(done.json()).toMatchObject({ status: 'done', repeated: false })
    const pages = await s.pagesOf(m.versionId)
    expect(pages.map((p) => p.page)).toEqual(range(1, 14))
    const events = s.sent.filter((x) => x.type === FILE_OP_EVENT).map((x) => FileOpEvent.parse(x.data).op)
    expect(events.at(-1)).toMatchObject({ status: 'done', pagesReady: 14 })
  })

  it('a result that does not match its outputs is refused, and the op stays running', async () => {
    const s = await setup()
    const m = await s.deck(12)
    expect((await s.request(s.e.bob, m.versionId)).statusCode).toBe(202)
    const w = await s.work(() => [9, 10])
    const bad = (result: unknown) =>
      s.e.worker('POST', `/api/worker/ops/${w.op.id}/complete`, { ...w.lease, outputs: [], result })
    expect((await bad({ pageCount: 12, rendered: [9, 10] })).json().error.code).toBe('BAD_RESULT')
    expect((await bad({ pageCount: 12, rendered: [], extra: 1 })).json().error.code).toBe('BAD_RESULT')
    const row = await s.db.one<{ status: string }>('SELECT status FROM worker_ops WHERE id = $1', [w.op.id])
    expect(row.status).toBe('running')
    expect(await s.pagesOf(m.versionId)).toHaveLength(8)
  })

  it('is the registered kind', () => {
    expect(OP_KINDS['render-pages']).toBe(renderPagesKind)
    expect(renderPagesKind.kind).toBe('render-pages')
  })
})

function range(from: number, to: number): number[] {
  const out: number[] = []
  for (let n = from; n <= to; n++) out.push(n)
  return out
}
