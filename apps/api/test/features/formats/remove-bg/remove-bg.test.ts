// Wave W, WS2 (docs/WAVE-W-CONTRACTS.md §4, §8): background removal on the api, end to end with a fake worker that
// speaks /api/worker/ops/* the way apps/worker does (fs mode, PGlite). The request route and its order of refusals,
// the op routes (state and cancel, the requester only), the completer (a NEW asset and version derived from the
// source, its preview job, the events), the quota at request and at complete, the windows, and the idempotent
// complete. Never the real model and never real image work: the worker's side is apps/worker/test/remove-bg.test.ts.

import { createHash } from 'node:crypto'
import {
  FILE_OP_EVENT,
  FileOpEvent,
  FileOpState,
  REMOVE_BG_LIMITS,
  WORKER_CAPABILITIES,
  WORKER_OP_LIMITS,
  WorkerOpClaimed,
} from '@draftroom/contracts'
import { newId } from '@draftroom/db'
import { afterEach, describe, expect, it } from 'vitest'
import { EventHub } from '../../../../src/events/hub.ts'
import { sourceRefusal } from '../../../../src/features/formats/remove-bg/index.ts'
import { removeBgQuota } from '../../../../src/features/formats/remove-bg/kind.ts'
import { type Client, createBoard, DEV_STUDIO } from '../../../helpers.ts'
import { PNG, pathOf, type WorkerEnv, workerEnv } from '../../../worker/helpers.ts'

const CAP = WORKER_CAPABILITIES['remove-bg']
const UNKNOWN = { error: { code: 'NOT_FOUND', message: 'Not found.' } }
/** The worker's "result": any bytes will do for the api (it checks size and type, never pixels). */
const OUT = PNG
const OUT_SHA = createHash('sha256').update(OUT).digest('hex')

let env: WorkerEnv | null = null
afterEach(async () => {
  await env?.close()
  env = null
})

interface Sent {
  boardId: string
  type: string
  data: unknown
  to: ((uid: string) => boolean) | undefined
}

async function setup(opts: { env?: Record<string, string> } = {}) {
  const hub = new EventHub()
  const sent: Sent[] = []
  const orig = hub.publish.bind(hub)
  hub.publish = (boardId, event, o = {}) => {
    sent.push({ boardId, type: event.type, data: event.data, to: o.to })
    orig(boardId, event, o)
  }
  let now = new Date('2026-10-19T12:00:00Z')
  const e = await workerEnv({
    env: { DRAFTROOM_REMOVE_BACKGROUND: 'on', ...opts.env },
    deps: { events: hub, now: () => now },
  })
  env = e
  const ready = async (versionId: string, probe: Record<string, unknown> = { width: 1, height: 1 }) => {
    await e.api.db.query(`UPDATE asset_versions SET status = 'ready', probe = $2::jsonb WHERE id = $1`, [
      versionId,
      JSON.stringify(probe),
    ])
    await e.api.db.query(`UPDATE preview_jobs SET status = 'done' WHERE version_id = $1`, [versionId])
  }
  const m = await e.upload('photo.png')
  await ready(m.versionId)
  const login = async (handle: string, role?: 'viewer' | 'commenter' | 'editor') => {
    const c = await e.api.login(handle)
    if (role) {
      const r = await e.bob.req('PUT', `/api/boards/${e.board}/members/${c.userId}`, { role })
      expect(r.statusCode, r.body).toBe(200)
    }
    return c
  }
  const ask = (c: Client, versionId = m.versionId, boardId = e.board) =>
    c.req('POST', `/api/files/${versionId}/remove-background`, { boardId })
  /** A worker reports the capability (an ops claim; nothing is queued yet, so it gets 204). */
  const seeWorker = async (capabilities = [CAP]) => {
    const r = await e.worker('POST', '/api/worker/ops/claim', { workerId: 'nas-1', capabilities })
    return r
  }
  const opsClaim = async () => {
    const r = await e.worker('POST', '/api/worker/ops/claim', { workerId: 'nas-1', capabilities: [CAP] })
    return r.statusCode === 204 ? null : WorkerOpClaimed.parse(r.json())
  }
  const lease = (attempt = 1) => ({ workerId: 'nas-1', attempt })
  /** Reserve the PNG output, PUT it (fs mode) and return its id. */
  const upload = async (opId: string, bytes = OUT, over: Record<string, unknown> = {}) => {
    const r = await e.worker('POST', `/api/worker/ops/${opId}/output`, {
      ...lease(),
      role: 'original',
      mimeType: 'image/png',
      width: 1,
      height: 1,
      bytes: bytes.length,
      ...over,
    })
    expect(r.statusCode, r.body).toBe(200)
    const { outputId, upload: up } = r.json() as {
      outputId: string
      upload: { url: string; headers: Record<string, string> }
    }
    const put = await e.api.app.inject({
      method: 'PUT',
      url: pathOf(up.url),
      headers: up.headers,
      payload: bytes,
    })
    expect(put.statusCode, put.body).toBeLessThan(300)
    return outputId
  }
  const complete = (opId: string, outputs: string[], result: Record<string, unknown> = {}) =>
    e.worker('POST', `/api/worker/ops/${opId}/complete`, {
      ...lease(),
      outputs,
      result: { sha256: OUT_SHA, width: 1, height: 1, bytes: OUT.length, ...result },
    })
  const op = (id: string) =>
    e.api.db.one<{ status: string; error_code: string | null; result_version_id: string | null }>(
      'SELECT status, error_code, result_version_id FROM worker_ops WHERE id = $1',
      [id],
    )
  const versions = async () =>
    (await e.api.db.one<{ n: number }>('SELECT count(*)::int AS n FROM asset_versions')).n
  return {
    e,
    m,
    sent,
    ready,
    login,
    ask,
    seeWorker,
    opsClaim,
    upload,
    complete,
    op,
    versions,
    tick: (ms: number) => {
      now = new Date(now.getTime() + ms)
    },
    now: () => now,
  }
}

describe('POST /api/files/:ver/remove-background: hidden until it can run', () => {
  it('switch off: the unknown route, even with a capable worker', async () => {
    const s = await setup({ env: { DRAFTROOM_REMOVE_BACKGROUND: 'off' } })
    await s.seeWorker()
    const r = await s.ask(s.e.bob)
    expect(r.statusCode).toBe(404)
    expect(r.json()).toEqual(UNKNOWN)
  })

  it('switch on, no worker with the capability (none, another version, or one seen too long ago): 404 as well', async () => {
    const s = await setup()
    expect((await s.ask(s.e.bob)).json()).toEqual(UNKNOWN)
    await s.seeWorker(['remove-bg:u2netp@2', 'extract-text@1'])
    expect((await s.ask(s.e.bob)).statusCode).toBe(404)
    await s.seeWorker()
    s.tick(WORKER_OP_LIMITS.capabilityFreshMs + 1)
    expect((await s.ask(s.e.bob)).json()).toEqual(UNKNOWN)
    expect(
      (await s.e.api.db.one<{ n: number }>('SELECT count(*)::int AS n FROM worker_ops')).n,
      'nothing queued',
    ).toBe(0)
  })
})

describe('the request: who may, and on what', () => {
  it('an editor with an account gets 202 and a queued op; the op routes show it to them alone', async () => {
    const s = await setup()
    await s.seeWorker()
    const r = await s.ask(s.e.bob)
    expect(r.statusCode, r.body).toBe(202)
    const state = FileOpState.parse(r.json())
    expect(state).toMatchObject({
      kind: 'remove-bg',
      status: 'queued',
      boardId: s.e.board,
      sourceVersionId: s.m.versionId,
      resultVersionId: null,
      errorCode: null,
    })
    const row = await s.e.api.db.one<{ params: unknown; params_key: string; requested_by: string }>(
      'SELECT params, params_key, requested_by FROM worker_ops WHERE id = $1',
      [state.id],
    )
    expect(row).toEqual({ params: {}, params_key: '-', requested_by: s.e.bob.userId })
    const mine = await s.e.bob.req('GET', `/api/file-ops/${state.id}`)
    expect(mine.statusCode).toBe(200)
    expect(FileOpState.parse(mine.json()).id).toBe(state.id)
    const frank = await s.login('frank', 'editor')
    expect((await frank.req('GET', `/api/file-ops/${state.id}`)).json()).toEqual(UNKNOWN)
    expect((await frank.req('POST', `/api/file-ops/${state.id}/cancel`)).json()).toEqual(UNKNOWN)
    expect((await s.e.bob.req('GET', '/api/file-ops/nope')).statusCode).toBe(404)
    expect((await s.e.bob.req('GET', `/api/file-ops/${newId('wop')}`)).statusCode).toBe(404)
  })

  it('viewer and commenter 403; a member without access, an outsider and a stranger board 404; anonymous 401', async () => {
    const s = await setup()
    await s.seeWorker()
    const dave = await s.login('dave', 'viewer')
    const ed = await s.login('ed', 'commenter')
    const carol = await s.login('carol')
    for (const c of [dave, ed]) {
      const r = await s.ask(c)
      expect(r.statusCode, r.body).toBe(403)
    }
    expect((await s.ask(carol)).statusCode).toBe(404)
    // carol's own board, with bob's version: not served there
    const hers = await createBoard(carol, DEV_STUDIO, 'Carol')
    expect((await s.ask(carol, s.m.versionId, hers)).statusCode).toBe(404)
    expect(
      (await s.e.api.anon('POST', `/api/files/${s.m.versionId}/remove-background`, { boardId: s.e.board }))
        .statusCode,
    ).toBe(401)
    expect(
      (
        await s.e.bob.req('POST', `/api/files/${s.m.versionId}/remove-background`, {
          boardId: s.e.board,
          extra: 1,
        })
      ).statusCode,
    ).toBe(400)
    expect(
      (await s.e.bob.req('POST', '/api/files/ver_bad/remove-background', { boardId: s.e.board })).statusCode,
    ).toBe(404)
  })

  it('the version must be served on that board: another board’s file is 404; a linked one is served', async () => {
    const s = await setup()
    await s.seeWorker()
    const other = await createBoard(s.e.bob, DEV_STUDIO, 'Other')
    const there = await s.e.upload('there.png', PNG, 'image/png', other)
    await s.ready(there.versionId)
    expect((await s.ask(s.e.bob, there.versionId)).statusCode).toBe(404)
    await s.e.api.db.query(
      `INSERT INTO board_asset_links (workspace_id, board_id, asset_id, version_id, created_at)
       VALUES ($1, $2, $3, $4, now())`,
      [DEV_STUDIO, s.e.board, there.assetId, there.versionId],
    )
    expect((await s.ask(s.e.bob, there.versionId)).statusCode).toBe(202)
  })

  it('a PDF, a GIF, a file still processing and one past the limits are refused before anything is queued', async () => {
    const s = await setup()
    await s.seeWorker()
    const pdf = await s.e.upload('brief.pdf', Buffer.from('%PDF-1.4\n%%EOF\n'), 'application/pdf')
    await s.ready(pdf.versionId, { pageCount: 1 })
    const pdfRes = await s.ask(s.e.bob, pdf.versionId)
    expect(pdfRes.statusCode).toBe(400)
    expect(pdfRes.json().error.code).toBe('FILE_OP_UNSUPPORTED')
    const gif = await s.e.upload('a.gif', PNG, 'image/gif')
    await s.ready(gif.versionId)
    await s.e.api.db.query(`UPDATE asset_versions SET mime_type = 'image/gif' WHERE id = $1`, [gif.versionId])
    expect((await s.ask(s.e.bob, gif.versionId)).json().error.code).toBe('FILE_OP_UNSUPPORTED')
    const fresh = await s.e.upload('fresh.png')
    const notReady = await s.ask(s.e.bob, fresh.versionId)
    expect(notReady.statusCode).toBe(409)
    expect(notReady.json().error.code).toBe('FILE_NOT_READY')
    for (const probe of [
      { width: 8000, height: 8000 }, // 64 MP
      { width: 12_001, height: 10 }, // the long edge
    ]) {
      const big = await s.e.upload('big.png')
      await s.ready(big.versionId, probe)
      const r = await s.ask(s.e.bob, big.versionId)
      expect(r.statusCode, JSON.stringify(probe)).toBe(400)
      expect(r.json().error.code).toBe('FILE_OP_UNSUPPORTED')
    }
    expect((await s.e.api.db.one<{ n: number }>('SELECT count(*)::int AS n FROM worker_ops')).n).toBe(0)
  })

  it('sourceRefusal: the size cap in bytes too', () => {
    const ok = {
      kind: 'image',
      mime_type: 'image/jpeg',
      size_bytes: 10,
      status: 'ready',
      probe: { width: 10, height: 10 },
    }
    expect(sourceRefusal(ok)).toBeNull()
    expect(sourceRefusal({ ...ok, size_bytes: REMOVE_BG_LIMITS.maxInputBytes + 1 })?.code).toBe(
      'FILE_OP_UNSUPPORTED',
    )
    expect(sourceRefusal({ ...ok, mime_type: 'image/webp' })).toBeNull()
    expect(sourceRefusal({ ...ok, status: 'failed' })?.code).toBe('FILE_NOT_READY')
  })

  it('an archived board is 409 BOARD_ARCHIVED (read-only until restored)', async () => {
    const s = await setup()
    await s.seeWorker()
    expect((await s.e.bob.req('POST', `/api/boards/${s.e.board}/archive`)).statusCode).toBe(200)
    const r = await s.ask(s.e.bob)
    expect(r.statusCode).toBe(409)
    expect(r.json().error.code).toBe('BOARD_ARCHIVED')
  })

  it('one op per file: the requester’s second request names the first (409); another editor’s is 409 too', async () => {
    const s = await setup()
    await s.seeWorker()
    const first = FileOpState.parse((await s.ask(s.e.bob)).json())
    const again = await s.ask(s.e.bob)
    expect(again.statusCode).toBe(409)
    expect(again.json()).toMatchObject({ error: { code: 'FILE_OP_ACTIVE' }, op: { id: first.id } })
    const frank = await s.login('frank', 'editor')
    const theirs = await s.ask(frank)
    expect(theirs.statusCode).toBe(409)
    expect(theirs.json()).toEqual({
      error: { code: 'FILE_OP_ACTIVE', message: expect.any(String) },
    })
  })

  it('a queued op whose capable worker went away for 10 minutes reads as failed, and the file may be asked for again', async () => {
    const s = await setup()
    await s.seeWorker()
    const first = FileOpState.parse((await s.ask(s.e.bob)).json())
    s.tick(WORKER_OP_LIMITS.workerAbsentMs + 1)
    const read = FileOpState.parse((await s.e.bob.req('GET', `/api/file-ops/${first.id}`)).json())
    expect(read).toMatchObject({ status: 'failed', errorCode: 'WORKER_UNAVAILABLE' })
    // another worker's claim writes it failed; then a capable worker checks in again and a new request is a new op
    await s.seeWorker(['extract-text@1'])
    expect(await s.op(first.id)).toMatchObject({ status: 'failed', error_code: 'WORKER_UNAVAILABLE' })
    const back = await s.e.worker('POST', '/api/worker/ops/checkin', {
      workerId: 'nas-1',
      capabilities: [CAP],
    })
    expect(back.statusCode).toBe(204)
    const next = await s.ask(s.e.bob)
    expect(next.statusCode, next.body).toBe(202)
    expect(FileOpState.parse(next.json()).id).not.toBe(first.id)
  })
})

describe('the windows and the quota at request', () => {
  it('one active op per person, then 30 an hour per person', async () => {
    const s = await setup()
    await s.seeWorker()
    const second = await s.e.upload('second.png')
    await s.ready(second.versionId)
    expect((await s.ask(s.e.bob)).statusCode).toBe(202)
    const busy = await s.ask(s.e.bob, second.versionId)
    expect(busy.statusCode).toBe(429)
    expect(busy.json().error).toMatchObject({
      code: 'FILE_OP_LIMIT',
      message: expect.stringMatching(/one background at a time/),
    })
    // the first one is done: the next goes, until the hour holds 30
    await s.e.api.db.query(`UPDATE worker_ops SET status = 'done', finished_at = created_at`)
    for (let i = 0; i < REMOVE_BG_LIMITS.perUserPerHour - 1; i++)
      await s.e.api.db.query(
        `INSERT INTO worker_ops (id, workspace_id, board_id, kind, source_version_id, requested_by, status, run_after,
                                 created_at, finished_at)
         VALUES ($1, $2, $3, 'remove-bg', $4, $5, 'done', $6, $6, $6)`,
        [newId('wop'), DEV_STUDIO, s.e.board, s.m.versionId, s.e.bob.userId, s.now()],
      )
    const hour = await s.ask(s.e.bob, second.versionId)
    expect(hour.statusCode).toBe(429)
    expect(hour.json().error.message).toMatch(/last hour/)
    s.tick(60 * 60_000 + 1)
    await s.seeWorker()
    expect((await s.ask(s.e.bob, second.versionId)).statusCode).toBe(202)
  })

  it('300 a day per workspace, and 3 active per workspace', async () => {
    const s = await setup()
    await s.seeWorker()
    for (let i = 0; i < REMOVE_BG_LIMITS.perWorkspacePerDay; i++)
      await s.e.api.db.query(
        `INSERT INTO worker_ops (id, workspace_id, board_id, kind, source_version_id, requested_by, status, run_after,
                                 created_at, finished_at)
         VALUES ($1, $2, $3, 'remove-bg', $4, NULL, 'done', $5, $5, $5)`,
        [newId('wop'), DEV_STUDIO, s.e.board, s.m.versionId, s.now()],
      )
    const day = await s.ask(s.e.bob)
    expect(day.statusCode).toBe(429)
    expect(day.json().error.message).toMatch(/today/)
    await s.e.api.db.query('DELETE FROM worker_ops')
    for (let i = 0; i < REMOVE_BG_LIMITS.perWorkspaceActive; i++) {
      const v = await s.e.upload(`f${i}.png`)
      await s.ready(v.versionId)
      await s.e.api.db.query(
        `INSERT INTO worker_ops (id, workspace_id, board_id, kind, source_version_id, requested_by, run_after, created_at)
         VALUES ($1, $2, $3, 'remove-bg', $4, NULL, $5, $5)`,
        [newId('wop'), DEV_STUDIO, s.e.board, v.versionId, s.now()],
      )
    }
    const ws = await s.ask(s.e.bob)
    expect(ws.statusCode).toBe(429)
    expect(ws.json().error.message).toMatch(/Several backgrounds/)
  })

  it('no room for the result: 507 QUOTA_EXCEEDED, nothing queued', async () => {
    const s = await setup({ env: { DRAFTROOM_WORKSPACE_MAX_FILES: '1' } })
    await s.seeWorker()
    const r = await s.ask(s.e.bob)
    expect(r.statusCode).toBe(507)
    expect(r.json().error.code).toBe('QUOTA_EXCEEDED')
    expect((await s.e.api.db.one<{ n: number }>('SELECT count(*)::int AS n FROM worker_ops')).n).toBe(0)
  })
})

describe('the worker’s run and the completer', () => {
  it('claim, one PNG, complete: a NEW asset and version derived from the source, its preview job, the events', async () => {
    const s = await setup()
    await s.seeWorker()
    const state = FileOpState.parse((await s.ask(s.e.bob)).json())
    const c = await s.opsClaim()
    expect(c?.op).toMatchObject({
      id: state.id,
      kind: 'remove-bg',
      capability: CAP,
      sourceVersionId: s.m.versionId,
      params: {},
      source: { kind: 'image', mimeType: 'image/png', sizeBytes: PNG.length },
    })
    // the source original, through its fs-mode grant
    const src = await s.e.worker('GET', pathOf(c?.source.url ?? ''))
    expect(src.statusCode).toBe(200)
    expect(Buffer.from(src.rawPayload).equals(PNG)).toBe(true)
    const before = await s.versions()
    const outputId = await s.upload(state.id)
    s.sent.length = 0
    const done = await s.complete(state.id, [outputId])
    expect(done.statusCode, done.body).toBe(200)
    expect(done.json()).toEqual({ opId: state.id, status: 'done', repeated: false })
    expect(await s.versions()).toBe(before + 1)

    const row = await s.op(state.id)
    expect(row.status).toBe('done')
    const v = await s.e.api.db.one<{
      id: string
      asset_id: string
      board_id: string
      name: string
      kind: string
      mime_type: string
      size_bytes: number
      sha256: string
      uploaded_by: string
      status: string
      derived_from_version_id: string
    }>(
      `SELECT id, asset_id, board_id, name, kind, mime_type, size_bytes::float8 AS size_bytes, sha256, uploaded_by,
              status, derived_from_version_id
         FROM asset_versions WHERE id = $1`,
      [row.result_version_id],
    )
    expect(v).toMatchObject({
      board_id: s.e.board,
      name: 'photo (no background).png',
      kind: 'image',
      mime_type: 'image/png',
      size_bytes: OUT.length,
      sha256: OUT_SHA,
      uploaded_by: s.e.bob.userId,
      status: 'queued',
      derived_from_version_id: s.m.versionId,
    })
    expect(v.asset_id).not.toBe(s.m.assetId) // a new asset, not a version in the source's chain
    const job = await s.e.api.db.one<{ status: string }>(
      'SELECT status FROM preview_jobs WHERE version_id = $1',
      [v.id],
    )
    expect(job.status).toBe('queued')
    // the original is kept
    expect((await s.e.meta({ assetId: s.m.assetId, versionId: s.m.versionId })).status).toBe('ready')
    // the new one is served on the board, as an upload would be
    const meta = await s.e.meta({ assetId: v.asset_id, versionId: v.id })
    expect(meta).toMatchObject({ name: 'photo (no background).png', kind: 'image', status: 'queued' })

    // file.op to the requester only; assets.version to the board
    const ops = s.sent.filter((x) => x.type === FILE_OP_EVENT)
    expect(ops).toHaveLength(1)
    const ev = ops[0] as Sent
    expect(ev.to?.(s.e.bob.userId)).toBe(true)
    expect(ev.to?.('usr_someoneelse0000000')).toBe(false)
    expect(FileOpEvent.parse(ev.data).op).toMatchObject({
      id: state.id,
      status: 'done',
      resultVersionId: v.id,
      resultAssetId: v.asset_id,
    })
    expect(
      s.sent.some((x) => x.type === 'assets.version' && (x.data as { versionId: string }).versionId === v.id),
    ).toBe(true)
    // and the op's state says the same
    expect(FileOpState.parse((await s.e.bob.req('GET', `/api/file-ops/${state.id}`)).json())).toMatchObject({
      status: 'done',
      resultVersionId: v.id,
      resultAssetId: v.asset_id,
    })

    // a repeated complete of the same attempt answers the stored status and makes nothing more
    const again = await s.complete(state.id, [outputId])
    expect(again.json()).toEqual({ opId: state.id, status: 'done', repeated: true })
    expect(await s.versions()).toBe(before + 1)
  })

  it('the outputs it accepts: one PNG original, within the output limits', async () => {
    const s = await setup()
    await s.seeWorker()
    const state = FileOpState.parse((await s.ask(s.e.bob)).json())
    await s.opsClaim()
    const reserve = (over: Record<string, unknown>) =>
      s.e.worker('POST', `/api/worker/ops/${state.id}/output`, {
        workerId: 'nas-1',
        attempt: 1,
        role: 'original',
        mimeType: 'image/png',
        width: 10,
        height: 10,
        bytes: 10,
        ...over,
      })
    for (const [over, code] of [
      [{ role: 'page', page: 9 }, 'OUTPUT_NOT_ALLOWED'],
      [{ mimeType: 'image/webp' }, 'OUTPUT_NOT_ALLOWED'],
      [{ width: REMOVE_BG_LIMITS.maxOutputEdge + 1 }, 'OUTPUT_TOO_LARGE'],
      [{ bytes: REMOVE_BG_LIMITS.maxOutputBytes + 1 }, 'OUTPUT_TOO_LARGE'],
    ] as const) {
      const r = await reserve(over)
      expect(r.statusCode, JSON.stringify(over)).toBe(400)
      expect(r.json().error.code).toBe(code)
    }
    expect((await reserve({})).statusCode).toBe(200)
    const second = await reserve({})
    expect(second.statusCode).toBe(400)
    expect(second.json().error.code).toBe('OUTPUT_NOT_ALLOWED')
    // text is not remove-bg's
    const text = await s.e.worker('POST', `/api/worker/ops/${state.id}/text`, {
      workerId: 'nas-1',
      attempt: 1,
      pages: [{ page: 1, body: 'x' }],
    })
    expect(text.statusCode).toBe(400)
  })

  it('a result that disagrees with its PNG, or no PNG at all, is refused and the op stays running', async () => {
    const s = await setup()
    await s.seeWorker()
    const state = FileOpState.parse((await s.ask(s.e.bob)).json())
    await s.opsClaim()
    const before = await s.versions()
    expect((await s.complete(state.id, [])).json().error.code).toBe('BAD_OUTPUT')
    const outputId = await s.upload(state.id)
    for (const result of [{ width: 2 }, { bytes: OUT.length + 1 }, { sha256: 'nope' }]) {
      const r = await s.complete(state.id, [outputId], result)
      expect(r.statusCode, JSON.stringify(result)).toBe(400)
      expect(r.json().error.code).toBe('BAD_RESULT')
    }
    expect((await s.op(state.id)).status).toBe('running')
    expect(await s.versions()).toBe(before)
  })

  it('the api hashes the stored PNG itself: a well-formed but wrong sha256 is refused (review m10)', async () => {
    const s = await setup()
    await s.seeWorker()
    const state = FileOpState.parse((await s.ask(s.e.bob)).json())
    await s.opsClaim()
    const outputId = await s.upload(state.id)
    const before = await s.versions()
    // the sha256 of another file (a backup packs originals by sha256: this would ship that file's bytes for both)
    const other = createHash('sha256').update('some other file').digest('hex')
    const r = await s.complete(state.id, [outputId], { sha256: other })
    expect(r.statusCode, r.body).toBe(409)
    expect(r.json().error.code).toBe('OUTPUT_MISMATCH')
    expect((await s.op(state.id)).status).toBe('running')
    expect(await s.versions()).toBe(before)
    // the true hash completes, and the new version carries it
    const ok = await s.complete(state.id, [outputId])
    expect(ok.json()).toMatchObject({ status: 'done' })
    const made = await s.op(state.id)
    const v = await s.e.api.db.one<{ sha256: string }>('SELECT sha256 FROM asset_versions WHERE id = $1', [
      made.result_version_id,
    ])
    expect(v.sha256).toBe(OUT_SHA)
  })

  it('the quota filled up while the worker ran: 409 QUOTA_EXCEEDED, nothing made; the worker then fails the op with it', async () => {
    const s = await setup()
    await s.seeWorker()
    const state = FileOpState.parse((await s.ask(s.e.bob)).json())
    await s.opsClaim()
    const outputId = await s.upload(state.id)
    const before = await s.versions()
    const saved = { ...removeBgQuota }
    removeBgQuota.maxFiles = before // full: one more file does not fit
    try {
      const r = await s.complete(state.id, [outputId])
      expect(r.statusCode).toBe(409)
      expect(r.json().error.code).toBe('QUOTA_EXCEEDED')
    } finally {
      Object.assign(removeBgQuota, saved)
    }
    expect(await s.versions()).toBe(before)
    expect((await s.op(state.id)).status).toBe('running')
    // what apps/worker ops/loop.ts does with that refusal
    const failed = await s.e.worker('POST', `/api/worker/ops/${state.id}/fail`, {
      workerId: 'nas-1',
      attempt: 1,
      code: 'QUOTA_EXCEEDED',
    })
    expect(failed.json()).toMatchObject({ status: 'failed' })
    expect(FileOpState.parse((await s.e.bob.req('GET', `/api/file-ops/${state.id}`)).json())).toMatchObject({
      status: 'failed',
      errorCode: 'QUOTA_EXCEEDED',
      message: 'This workspace is out of storage. Free some space and try again.',
    })
    // its reserved blob was dropped with the op's reservations
    expect(
      (
        await s.e.api.db.one<{ n: number }>(
          'SELECT count(*)::int AS n FROM worker_op_outputs WHERE op_id = $1',
          [state.id],
        )
      ).n,
    ).toBe(0)
  })

  it('the board was archived, or the requester lost edit, while the worker ran: 409 CANCELLED, nothing made', async () => {
    for (const change of ['archive', 'demote'] as const) {
      const s = await setup()
      await s.seeWorker()
      const frank = await s.login('frank', 'editor')
      const state = FileOpState.parse((await s.ask(frank)).json())
      await s.opsClaim()
      const outputId = await s.upload(state.id)
      if (change === 'archive') await s.e.bob.req('POST', `/api/boards/${s.e.board}/archive`)
      else await s.e.bob.req('PUT', `/api/boards/${s.e.board}/members/${frank.userId}`, { role: 'viewer' })
      const before = await s.versions()
      const r = await s.complete(state.id, [outputId])
      expect(r.statusCode, change).toBe(409)
      expect(r.json().error.code).toBe('CANCELLED')
      expect(await s.versions()).toBe(before)
      await env?.close()
      env = null
    }
  })

  it('a board trashed before any worker came cancels the op at claim', async () => {
    const s = await setup()
    await s.seeWorker()
    const state = FileOpState.parse((await s.ask(s.e.bob)).json())
    expect((await s.e.bob.req('POST', `/api/boards/${s.e.board}/trash`)).statusCode).toBe(200)
    expect(await s.opsClaim()).toBeNull()
    expect(await s.op(state.id)).toMatchObject({ status: 'cancelled', error_code: 'CANCELLED' })
  })
})

describe('cancel', () => {
  it('the requester cancels a queued op (cancelled, their file.op); a running one is 409; a finished one answers its state', async () => {
    const s = await setup()
    await s.seeWorker()
    const state = FileOpState.parse((await s.ask(s.e.bob)).json())
    s.sent.length = 0
    const r = await s.e.bob.req('POST', `/api/file-ops/${state.id}/cancel`)
    expect(r.statusCode, r.body).toBe(200)
    expect(FileOpState.parse(r.json())).toMatchObject({ status: 'cancelled', errorCode: 'CANCELLED' })
    const ev = s.sent.find((x) => x.type === FILE_OP_EVENT)
    expect(ev?.to?.(s.e.bob.userId)).toBe(true)
    expect(FileOpEvent.parse(ev?.data).op.status).toBe('cancelled')
    expect(await s.opsClaim()).toBeNull() // nothing left for a worker
    expect(
      FileOpState.parse((await s.e.bob.req('POST', `/api/file-ops/${state.id}/cancel`)).json()).status,
    ).toBe('cancelled')
    const next = FileOpState.parse((await s.ask(s.e.bob)).json())
    expect(await s.opsClaim()).not.toBeNull()
    const running = await s.e.bob.req('POST', `/api/file-ops/${next.id}/cancel`)
    expect(running.statusCode).toBe(409)
    expect(running.json().error.code).toBe('FILE_OP_RUNNING')
  })

  it('an op whose kind is switched off is an unknown op, even while the routes are open for deck import', async () => {
    const s = await setup({ env: { DRAFTROOM_REMOVE_BACKGROUND: 'off', DRAFTROOM_DECK_IMPORT: 'on' } })
    const id = newId('wop')
    await s.e.api.db.query(
      `INSERT INTO worker_ops (id, workspace_id, board_id, kind, source_version_id, requested_by, run_after, created_at)
       VALUES ($1, $2, $3, 'remove-bg', $4, $5, $6, $6)`,
      [id, DEV_STUDIO, s.e.board, s.m.versionId, s.e.bob.userId, s.now()],
    )
    expect((await s.e.bob.req('GET', `/api/file-ops/${id}`)).json()).toEqual(UNKNOWN)
    expect((await s.e.bob.req('POST', `/api/file-ops/${id}/cancel`)).json()).toEqual(UNKNOWN)
  })

  it('a requester who can no longer view the board does not see the op', async () => {
    const s = await setup()
    await s.seeWorker()
    const frank = await s.login('frank', 'editor')
    const state = FileOpState.parse((await s.ask(frank)).json())
    expect((await frank.req('GET', `/api/file-ops/${state.id}`)).statusCode).toBe(200)
    await s.e.bob.req('DELETE', `/api/boards/${s.e.board}/members/${frank.userId}`)
    expect((await frank.req('GET', `/api/file-ops/${state.id}`)).json()).toEqual(UNKNOWN)
  })
})
