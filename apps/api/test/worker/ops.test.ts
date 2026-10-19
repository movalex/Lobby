// Wave W (the foundation; docs/WAVE-W-CONTRACTS.md §3): the worker ops protocol over /api/worker/ops/* in fs mode, next
// to the unchanged preview protocol. An old worker (preview routes only) never sees an op and keeps working; a wave W
// worker is handed only ops whose kind's current capability it reports and whose switch is on; leases, outputs, the
// kind's completer, retries, releases, the stale and trashed-board rules and the requester-only event hold. The kinds
// are the foundation's stubs (501) unless the test injects its own (ApiDeps.workerOpKinds, TEST-ONLY).

import {
  FILE_OP_EVENT,
  FileOpEvent,
  WORKER_CAPABILITIES,
  WORKER_OP_LIMITS,
  WorkerOpClaimed,
  type WorkerOpKind,
} from '@draftroom/contracts'
import { newId } from '@draftroom/db'
import { afterEach, describe, expect, it } from 'vitest'
import { EventHub } from '../../src/events/hub.ts'
import {
  OP_KINDS,
  type OpKindHandler,
  OpRefused,
  type PublishedOutput,
  stubKind,
} from '../../src/worker/ops-kinds.ts'
import { claim, PNG, pathOf, type WorkerEnv, workerEnv } from './helpers.ts'

const ON = {
  DRAFTROOM_REMOVE_BACKGROUND: 'on',
  DRAFTROOM_FILE_SEARCH: 'on',
  DRAFTROOM_DECK_IMPORT: 'on',
}
const ALL_CAPS = Object.values(WORKER_CAPABILITIES)

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

/** A worker env whose hub records every publish with its audience, and a clock the test moves. */
async function setup(
  opts: { env?: Record<string, string>; kinds?: Record<WorkerOpKind, OpKindHandler> } = {},
) {
  const hub = new EventHub()
  const sent: Sent[] = []
  const orig = hub.publish.bind(hub)
  hub.publish = (boardId, event, o = {}) => {
    sent.push({ boardId, type: event.type, data: event.data, to: o.to })
    orig(boardId, event, o)
  }
  let now = new Date('2026-10-19T12:00:00Z')
  const e = await workerEnv({
    env: { ...ON, ...opts.env },
    deps: {
      events: hub,
      now: () => now,
      ...(opts.kinds ? { workerOpKinds: opts.kinds } : {}),
    },
  })
  env = e
  const m = await e.upload('photo.png')
  await e.api.db.query(`UPDATE asset_versions SET status = 'ready' WHERE id = $1`, [m.versionId])
  // the upload's preview job is done: only ops are left to claim
  await e.api.db.query(`UPDATE preview_jobs SET status = 'done' WHERE version_id = $1`, [m.versionId])
  const bob = e.bob.userId
  const workspace = (
    await e.api.db.one<{ workspace_id: string }>('SELECT workspace_id FROM boards WHERE id = $1', [e.board])
  ).workspace_id
  const queue = async (kind: WorkerOpKind = 'remove-bg', over: Record<string, unknown> = {}) => {
    const id = newId('wop')
    await e.api.db.query(
      `INSERT INTO worker_ops (id, workspace_id, board_id, kind, source_version_id, params, params_key, requested_by,
                               run_after, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $9)`,
      [
        id,
        workspace,
        e.board,
        kind,
        m.versionId,
        JSON.stringify(over.params ?? {}),
        over.params_key ?? '-',
        over.requested_by === undefined ? bob : over.requested_by,
        over.run_after ?? now,
      ],
    )
    return id
  }
  const opsClaim = (capabilities: string[] = ALL_CAPS, workerId = 'nas-1') =>
    e.worker('POST', '/api/worker/ops/claim', { workerId, capabilities })
  const op = (id: string) =>
    e.api.db.one<{ status: string; attempts: number; error_code: string | null; lease_owner: string | null }>(
      'SELECT status, attempts, error_code, lease_owner FROM worker_ops WHERE id = $1',
      [id],
    )
  return {
    e,
    m,
    sent,
    bob,
    queue,
    opsClaim,
    op,
    tick: (ms: number) => {
      now = new Date(now.getTime() + ms)
    },
  }
}

describe('an old worker (the preview protocol only)', () => {
  it('never sees an op, and its preview lifecycle is unchanged with ops queued', async () => {
    const s = await setup()
    await s.queue('remove-bg')
    await s.queue('extract-text')
    const fresh = await s.e.upload('second.png')
    const c = await claim(s.e, 'old-worker')
    expect(c?.job.versionId).toBe(fresh.versionId)
    const done = await s.e.worker('POST', `/api/worker/jobs/${fresh.versionId}/complete`, {
      workerId: 'old-worker',
      status: 'ready',
      mimeType: 'image/png',
      probe: { width: 1, height: 1 },
      derivatives: [],
    })
    expect(done.statusCode, done.body).toBe(200)
    expect(done.json()).toEqual({ versionId: fresh.versionId, status: 'ready', repeated: false })
    // nothing more for it: the ops are not preview jobs
    expect(await claim(s.e, 'old-worker')).toBeNull()
    expect(
      (
        await s.e.api.db.one<{ n: number }>(
          "SELECT count(*)::int AS n FROM worker_ops WHERE status = 'queued'",
        )
      ).n,
    ).toBe(2)
  })
})

describe('claim', () => {
  it('records the capabilities it is told; 204 with nothing to do', async () => {
    const s = await setup()
    const res = await s.opsClaim(['remove-bg:u2netp@1', 'later-kind@3'])
    expect(res.statusCode).toBe(204)
    const rows = await s.e.api.db.query<{ capability: string; worker_id: string }>(
      'SELECT capability, worker_id FROM worker_capabilities_seen ORDER BY capability',
    )
    expect(rows.rows).toEqual([
      { capability: 'later-kind@3', worker_id: 'nas-1' },
      { capability: 'remove-bg:u2netp@1', worker_id: 'nas-1' },
    ])
    // malformed capabilities refuse the whole claim (400) and record nothing
    expect((await s.opsClaim(['Remove BG'])).statusCode).toBe(400)
  })

  it('hands out only kinds whose CURRENT capability the worker reports, and the source through a q grant', async () => {
    const s = await setup()
    const id = await s.queue('remove-bg')
    expect((await s.opsClaim(['remove-bg:isnet@1', 'extract-text@1'])).statusCode).toBe(204)
    const res = await s.opsClaim()
    expect(res.statusCode, res.body).toBe(200)
    const body = WorkerOpClaimed.parse(res.json())
    expect(body.op).toMatchObject({
      id,
      kind: 'remove-bg',
      capability: 'remove-bg:u2netp@1',
      boardId: s.e.board,
      sourceVersionId: s.m.versionId,
      params: {},
      attempt: 1,
      leaseMs: WORKER_OP_LIMITS.leaseMs,
      source: { kind: 'image', name: 'photo.png', mimeType: 'image/png', sizeBytes: PNG.length },
    })
    expect(body.source.url).toMatch(/\/api\/worker\/blobs\/q\.wop_[0-9A-Za-z]+\.\d{10}\.[A-Za-z0-9_-]{22}$/)
    const got = await s.e.api.app.inject({ method: 'GET', url: pathOf(body.source.url) })
    expect(got.statusCode).toBe(200)
    expect(got.rawPayload.equals(PNG)).toBe(true)
    expect(await s.op(id)).toMatchObject({ status: 'running', attempts: 1, lease_owner: 'nas-1' })
    // leased: nobody else gets it
    expect((await s.opsClaim(ALL_CAPS, 'nas-2')).statusCode).toBe(204)
  })

  it('a kind whose switch is off is never handed out, and its queued ops fail WORKER_UNAVAILABLE', async () => {
    const s = await setup({ env: { DRAFTROOM_REMOVE_BACKGROUND: 'off' } })
    const id = await s.queue('remove-bg')
    expect((await s.opsClaim()).statusCode).toBe(204)
    expect(await s.op(id)).toMatchObject({ status: 'failed', error_code: 'WORKER_UNAVAILABLE' })
  })

  it('a queued op due longer than 15 minutes fails WORKER_UNAVAILABLE at the next claim; its requester hears it', async () => {
    const s = await setup()
    const id = await s.queue('remove-bg')
    s.tick(WORKER_OP_LIMITS.staleQueuedMs + 1_000)
    expect((await s.opsClaim([])).statusCode).toBe(204)
    expect(await s.op(id)).toMatchObject({ status: 'failed', error_code: 'WORKER_UNAVAILABLE' })
    const ev = s.sent.filter((x) => x.type === FILE_OP_EVENT)
    expect(ev).toHaveLength(1)
    const data = FileOpEvent.parse(ev[0]?.data)
    expect(data.op).toMatchObject({ id, status: 'failed', errorCode: 'WORKER_UNAVAILABLE' })
    // to the requester only
    expect(ev[0]?.to?.(s.bob)).toBe(true)
    expect(ev[0]?.to?.('usr_someoneelse0001')).toBe(false)
  })

  it('an op on a trashed board is cancelled at claim; one whose source is not ready fails SOURCE_MISSING', async () => {
    const s = await setup()
    const a = await s.queue('remove-bg')
    await s.e.api.db.query(`UPDATE boards SET status = 'trashed', trashed_at = now() WHERE id = $1`, [
      s.e.board,
    ])
    expect((await s.opsClaim()).statusCode).toBe(204)
    expect(await s.op(a)).toMatchObject({ status: 'cancelled', error_code: 'CANCELLED' })
    await s.e.api.db.query(`UPDATE boards SET status = 'active', trashed_at = NULL WHERE id = $1`, [
      s.e.board,
    ])
    await s.e.api.db.query(
      `UPDATE asset_versions SET status = 'failed', error_code = 'INTERNAL',
                              error_message = 'x' WHERE id = $1`,
      [s.m.versionId],
    )
    const b = await s.queue('extract-text')
    expect((await s.opsClaim()).statusCode).toBe(204)
    expect(await s.op(b)).toMatchObject({ status: 'failed', error_code: 'SOURCE_MISSING' })
  })

  it('refuses browser cookies and a missing token, like every worker route', async () => {
    const s = await setup()
    const body = { workerId: 'nas-1', capabilities: [] }
    expect(
      (await s.e.worker('POST', '/api/worker/ops/claim', body, { authorization: undefined })).statusCode,
    ).toBe(401)
    expect(
      (await s.e.worker('POST', '/api/worker/ops/claim', body, { cookie: 'dr_session=x' })).statusCode,
    ).toBe(403)
  })
})

describe('the lease', () => {
  it('heartbeat extends it; a wrong attempt or worker is 409 LEASE_LOST; an expired lease is reclaimed (attempt 2)', async () => {
    const s = await setup()
    const id = await s.queue()
    expect((await s.opsClaim()).statusCode).toBe(200)
    const beat = (workerId: string, attempt: number) =>
      s.e.worker('POST', `/api/worker/ops/${id}/heartbeat`, { workerId, attempt })
    expect((await beat('nas-1', 1)).json()).toEqual({ leaseMs: WORKER_OP_LIMITS.leaseMs })
    expect((await beat('nas-1', 2)).json().error.code).toBe('LEASE_LOST')
    expect((await beat('nas-2', 1)).statusCode).toBe(409)
    s.tick(WORKER_OP_LIMITS.leaseMs + 1)
    const again = WorkerOpClaimed.parse((await s.opsClaim(ALL_CAPS, 'nas-2')).json())
    expect(again.op.attempt).toBe(2)
    expect((await beat('nas-1', 1)).statusCode).toBe(409)
  })

  it('the foundation stubs refuse output, text and complete with 501 (no deployment reaches them)', async () => {
    // WS2 landed remove-bg's kind (features/formats/remove-bg/kind.ts): the stub itself is what this checks
    const s = await setup({ kinds: { ...OP_KINDS, 'remove-bg': stubKind('remove-bg') } })
    const id = await s.queue()
    await s.opsClaim()
    const lease = { workerId: 'nas-1', attempt: 1 }
    const out = await s.e.worker('POST', `/api/worker/ops/${id}/output`, {
      ...lease,
      role: 'original',
      mimeType: 'image/png',
      width: 10,
      height: 10,
      bytes: 10,
    })
    expect(out.statusCode).toBe(501)
    const text = await s.e.worker('POST', `/api/worker/ops/${id}/text`, {
      ...lease,
      pages: [{ page: 1, body: 'x' }],
    })
    expect(text.statusCode).toBe(501)
    const done = await s.e.worker('POST', `/api/worker/ops/${id}/complete`, { ...lease, result: {} })
    expect(done.statusCode).toBe(501)
    expect(await s.op(id)).toMatchObject({ status: 'running' })
    expect(OP_KINDS['remove-bg'].kind).toBe('remove-bg')
  })

  it('fail: retry queues it again after a backoff, release at once without counting, the last one fails with a known code', async () => {
    const s = await setup()
    const id = await s.queue()
    await s.opsClaim()
    const fail = (attempt: number, body: Record<string, unknown>) =>
      s.e.worker('POST', `/api/worker/ops/${id}/fail`, { workerId: 'nas-1', attempt, ...body })
    expect((await fail(1, { code: 'TIMEOUT', retry: true })).json()).toMatchObject({ status: 'queued' })
    // not due yet (15 s backoff)
    expect((await s.opsClaim()).statusCode).toBe(204)
    s.tick(15_001)
    expect(WorkerOpClaimed.parse((await s.opsClaim()).json()).op.attempt).toBe(2)
    expect((await fail(2, { code: 'INTERNAL', release: true })).json()).toMatchObject({ status: 'queued' })
    expect(WorkerOpClaimed.parse((await s.opsClaim()).json()).op.attempt).toBe(2)
    // a code the users must never see becomes INTERNAL
    expect((await fail(2, { code: '/tmp/x: core dumped' })).json()).toMatchObject({ status: 'failed' })
    expect(await s.op(id)).toMatchObject({ status: 'failed', error_code: 'INTERNAL', lease_owner: null })
    expect((await fail(2, { code: 'TIMEOUT' })).statusCode).toBe(409)
  })

  it('out of attempts: the claim after the third fails it INTERNAL', async () => {
    const s = await setup()
    const id = await s.queue()
    for (let i = 1; i <= WORKER_OP_LIMITS.maxAttempts; i++) {
      expect(WorkerOpClaimed.parse((await s.opsClaim()).json()).op.attempt).toBe(i)
      s.tick(WORKER_OP_LIMITS.leaseMs + 1) // the worker died: the lease runs out
    }
    expect((await s.opsClaim()).statusCode).toBe(204)
    expect(await s.op(id)).toMatchObject({ status: 'failed', error_code: 'INTERNAL' })
  })
})

describe('outputs and complete, through a kind the test writes', () => {
  /** A remove-bg-like kind: one original output; its completer records what it was given. */
  function testKind() {
    const seen: { outputs: PublishedOutput[]; result: Record<string, unknown> }[] = []
    const kind: OpKindHandler = {
      kind: 'remove-bg',
      async checkOutput(_tx, _op, input) {
        if (input.role !== 'original') throw new OpRefused(400, 'BAD_OUTPUT', 'only an original')
      },
      async acceptText() {
        throw new OpRefused(400, 'NO_TEXT', 'no text')
      },
      async complete(_tx, _op, done) {
        seen.push({ outputs: done.outputs, result: done.result })
        return { result: { ...done.result }, resultVersionId: null }
      },
    }
    return { kind, seen }
  }

  it('reserve, PUT through a p grant, complete: the kind gets the verified outputs; a repeat is answered as such', async () => {
    const t = testKind()
    const s = await setup({ kinds: { ...OP_KINDS, 'remove-bg': t.kind } })
    const id = await s.queue()
    await s.opsClaim()
    const lease = { workerId: 'nas-1', attempt: 1 }
    const png = Buffer.alloc(40, 9)
    const bad = await s.e.worker('POST', `/api/worker/ops/${id}/output`, {
      ...lease,
      role: 'page',
      page: 9,
      mimeType: 'image/webp',
      width: 10,
      height: 10,
      bytes: 40,
    })
    expect(bad.statusCode).toBe(400)
    expect(bad.json().error.code).toBe('BAD_OUTPUT')
    const r = await s.e.worker('POST', `/api/worker/ops/${id}/output`, {
      ...lease,
      role: 'original',
      mimeType: 'image/png',
      width: 10,
      height: 4,
      bytes: png.length,
    })
    expect(r.statusCode, r.body).toBe(200)
    const reserved = r.json() as {
      outputId: string
      upload: { url: string; headers: Record<string, string> }
    }
    expect(reserved.upload.url).toMatch(/\/api\/worker\/blobs\/p\.wpo_/)
    // complete before the upload: the blob is missing
    const early = await s.e.worker('POST', `/api/worker/ops/${id}/complete`, {
      ...lease,
      outputs: [reserved.outputId],
      result: { ok: 1 },
    })
    expect(early.statusCode).toBe(409)
    expect(early.json().error.code).toBe('OUTPUT_MISSING')
    const put = await s.e.api.app.inject({
      method: 'PUT',
      url: pathOf(reserved.upload.url),
      headers: reserved.upload.headers,
      payload: png,
    })
    expect(put.statusCode, put.body).toBe(200)
    const done = await s.e.worker('POST', `/api/worker/ops/${id}/complete`, {
      ...lease,
      outputs: [reserved.outputId],
      result: { ok: 1 },
    })
    expect(done.json()).toEqual({ opId: id, status: 'done', repeated: false })
    expect(t.seen).toHaveLength(1)
    const out = t.seen[0]?.outputs[0]
    expect(out).toMatchObject({
      role: 'original',
      page: null,
      width: 10,
      height: 4,
      bytes: 40,
      mimeType: 'image/png',
    })
    // a NEW asset and version were picked for the original
    expect(out?.assetId).not.toBe(s.m.assetId)
    expect(out?.versionId).not.toBe(s.m.versionId)
    expect(out?.blobKey).toBe(`assets/${out?.assetId}/${out?.versionId}/original`)
    const repeat = await s.e.worker('POST', `/api/worker/ops/${id}/complete`, { ...lease, result: { ok: 1 } })
    expect(repeat.json()).toEqual({ opId: id, status: 'done', repeated: true })
    expect(t.seen).toHaveLength(1)
    // the op is done; its reservations are gone; the requester heard running and done
    expect(await s.op(id)).toMatchObject({ status: 'done', lease_owner: 'nas-1' })
    expect((await s.e.api.db.one<{ n: number }>('SELECT count(*)::int AS n FROM worker_op_outputs')).n).toBe(
      0,
    )
    const states = s.sent
      .filter((x) => x.type === FILE_OP_EVENT)
      .map((x) => FileOpEvent.parse(x.data).op.status)
    expect(states).toEqual(['running', 'done'])
    // the fs-mode URL is useless once the op is done
    const late = await s.e.api.app.inject({
      method: 'PUT',
      url: pathOf(reserved.upload.url),
      headers: reserved.upload.headers,
      payload: png,
    })
    expect(late.statusCode).toBe(404)
  })

  it('a result over 4 KiB is refused; an unknown or another attempt’s output is refused', async () => {
    const t = testKind()
    const s = await setup({ kinds: { ...OP_KINDS, 'remove-bg': t.kind } })
    const id = await s.queue()
    await s.opsClaim()
    const lease = { workerId: 'nas-1', attempt: 1 }
    const big = await s.e.worker('POST', `/api/worker/ops/${id}/complete`, {
      ...lease,
      result: { pad: 'x'.repeat(5000) },
    })
    expect(big.json().error.code).toBe('RESULT_TOO_LARGE')
    const unknown = await s.e.worker('POST', `/api/worker/ops/${id}/complete`, {
      ...lease,
      outputs: ['wpo_0123456789abcdefghij'],
      result: {},
    })
    expect(unknown.json().error.code).toBe('UNKNOWN_OUTPUT')
    expect(t.seen).toHaveLength(0)
  })
})
