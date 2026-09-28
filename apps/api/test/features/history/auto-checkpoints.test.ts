// Automatic checkpoints and retention (docs/WAVE4-CONTRACTS.md checkpoints-2, REV-10): the sync
// server's reports, the scheduler (hourly, session end, backoff), the checkpoints made before a
// restore and at an import, the manual cap, and retention deleting rows with their stored bodies.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { INTERNAL_SECRET_HEADER } from '@draftroom/auth-tickets'
import type { BlobStore } from '@draftroom/blob-store'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventHub } from '../../../src/events/hub.ts'
import { type CheckpointService, checkpointSettings } from '../../../src/features/history/checkpoints.ts'
import { checkpointServices } from '../../../src/features/history/index.ts'
import {
  type Client,
  createBoard,
  createTestApi,
  DEV_STUDIO,
  INTERNAL_SECRET,
  type TestApi,
} from '../../helpers.ts'
import { baseRecords, createFakeSync, type FakeSync, noteRec, type Rec, recordEvents } from './helpers.ts'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

let api: TestApi
let sync: FakeSync
let events: EventHub
let bob: Client // member; owns the board
let service: CheckpointService
let boardId: string
const saved = { ...checkpointSettings }

beforeEach(() => start())
afterEach(async () => {
  Object.assign(checkpointSettings, saved)
  await api.close()
})

/** Builds the app (settings are read when it is built); tests that need other settings call it again. */
async function start(overrides: Partial<typeof checkpointSettings> = {}) {
  // The app's own timers stay off: these tests run the scheduler and retention themselves.
  Object.assign(checkpointSettings, saved, { tickMs: 0, pruneEveryMs: 0, maxFailures: 3 }, overrides)
  sync = createFakeSync()
  events = new EventHub()
  api = await createTestApi({ deps: { syncInternal: sync, events } })
  await api.login('owner')
  bob = await api.login('bob')
  boardId = await createBoard(bob, DEV_STUDIO, 'Roadmap')
  setContent(boardId, 'first idea')
  const s = checkpointServices.get(api.app)
  if (!s) throw new Error('no checkpoint service')
  service = s
}
/** Closes the app built by beforeEach and builds another with `overrides`. */
async function restart(overrides: Partial<typeof checkpointSettings>) {
  await api.close()
  await start(overrides)
}

/** The board's content on the (fake) sync server: a page and one note with `text`, plus `extra`. */
function setContent(bid: string, text: string, extra: Rec[] = []) {
  sync.setBoard(bid, [...baseRecords(), noteRec('n1', text), ...extra])
}

const internal = (path: string, secret: string | null = INTERNAL_SECRET) =>
  api.app.inject({
    method: 'GET',
    url: path,
    headers: secret ? { [INTERNAL_SECRET_HEADER]: secret } : {},
  })
const at = () => api.clock.now().getTime()
/** Moves the test clock forward to `minutes` past the next full UTC hour (retention buckets are hours). */
const alignTo = (minutes: number) => api.clock.advance(HOUR - (at() % HOUR) + minutes * MIN)
/** What the sync server sends after accepted canvas writes (apps/sync/src/touch.ts). */
const touch = async (bid = boardId) => {
  const res = await internal(`/internal/boards/${bid}/touched?at=${at()}`)
  expect(res.statusCode).toBe(204)
}
/** What the sync server sends when the last editor left after changes (apps/sync/src/session-end.ts). */
const sessionEnded = (bid = boardId, secret: string | null = INTERNAL_SECRET) =>
  internal(`/internal/boards/${bid}/session-ended?at=${at()}`, secret)

interface ListedCheckpoint {
  id: string
  name: string
  kind: string
  reason: string | null
  createdBy: unknown
  createdAt: string
}
async function checkpoints(bid = boardId): Promise<ListedCheckpoint[]> {
  const res = await bob.req('GET', `/api/boards/${bid}/snapshots`)
  expect(res.statusCode).toBe(200)
  return res.json().snapshots
}
const autos = async (bid = boardId) => (await checkpoints(bid)).filter((c) => c.kind === 'auto')
const state = (bid = boardId) =>
  api.db.maybeOne<{ dirty_since: Date | null; session_ended_at: Date | null; failures: number }>(
    'SELECT dirty_since, session_ended_at, failures FROM board_checkpoint_state WHERE board_id = $1',
    [bid],
  )
const bodyKey = (bid: string, sid: string) => `snapshots/${bid}/${sid}.json`
const bodyFile = (bid: string, sid: string) =>
  join(api.config.dataDir, 'blobs', 'snapshots', bid, `${sid}.json`)
async function storedText(bid: string, sid: string): Promise<string> {
  const obj = await api.blobs.get(bodyKey(bid, sid))
  if (!obj) throw new Error('no body')
  const chunks: Buffer[] = []
  for await (const c of obj.body as AsyncIterable<Buffer>) chunks.push(Buffer.from(c))
  return Buffer.concat(chunks).toString('utf8')
}
const saveManual = (name: string) => bob.req('POST', `/api/boards/${boardId}/snapshots`, { name })

describe('hourly checkpoints while people edit', () => {
  it('an edit report marks the board; an hour after the first unsaved change one "hourly" checkpoint is saved, then at most one an hour', async () => {
    const got = recordEvents(events, boardId)
    await touch()
    expect(await state()).toMatchObject({ dirty_since: expect.any(Date) })
    expect(await service.runDue()).toBe(0)
    api.clock.advance(59 * MIN)
    await touch() // still editing
    expect(await service.runDue()).toBe(0)
    expect(sync.snapshots).toEqual([]) // nothing read from sync before it is due

    api.clock.advance(2 * MIN)
    expect(await service.runDue()).toBe(1)
    const [first, ...rest] = await autos()
    expect(rest).toEqual([])
    expect(first).toMatchObject({
      kind: 'auto',
      reason: 'hourly',
      name: 'Hourly checkpoint',
      createdBy: null,
    })
    expect(JSON.parse(await storedText(boardId, first?.id ?? ''))).toMatchObject({
      format: 'draftroom-checkpoint',
      boardId,
    })
    expect(got).toContainEqual({ type: 'history.snapshot', data: { snapshotId: first?.id } })
    expect(await state()).toMatchObject({ dirty_since: null })

    // More editing right away: the next hourly one comes an hour after this one, not before.
    setContent(boardId, 'second idea')
    await touch()
    api.clock.advance(40 * MIN)
    expect(await service.runDue()).toBe(0)
    api.clock.advance(21 * MIN)
    expect(await service.runDue()).toBe(1)
    expect((await autos()).map((c) => c.reason)).toEqual(['hourly', 'hourly'])
  })

  it('never saves content equal to the newest checkpoint: no change, an undone change, or only a user record', async () => {
    expect((await saveManual('Baseline')).statusCode).toBe(201)
    await touch()
    api.clock.advance(61 * MIN)
    expect(await service.runDue()).toBe(1) // looked at...
    expect(await autos()).toEqual([]) // ...and saved nothing
    expect(await state()).toMatchObject({ dirty_since: null })
    const reads = sync.snapshots.length
    api.clock.advance(2 * HOUR)
    expect(await service.runDue()).toBe(0) // not dirty any more: sync is not asked again
    expect(sync.snapshots).toHaveLength(reads)

    // Someone opened it as an editor: tldraw wrote their user record. Not board content.
    setContent(boardId, 'first idea', [
      { id: 'user:usr_someone', typeName: 'user', name: 'Someone', color: '#123456', meta: {} },
    ])
    await touch()
    api.clock.advance(61 * MIN)
    await service.runDue()
    expect(await autos()).toEqual([])
  })

  it('reports for unknown or trashed boards are ignored, and a board trashed meanwhile forgets its pending checkpoint', async () => {
    await touch('b-nosuchbrd')
    expect(await state('b-nosuchbrd')).toBeNull()

    await touch()
    expect((await bob.req('POST', `/api/boards/${boardId}/trash`)).statusCode).toBe(200)
    api.clock.advance(61 * MIN)
    await service.runDue()
    expect(await state()).toBeNull()
    expect(await api.db.one('SELECT count(*)::int AS n FROM board_snapshots')).toEqual({ n: 0 })
    await touch() // a late report for the trashed board
    expect(await state()).toBeNull()
  })

  it('a report without the internal secret changes nothing', async () => {
    const res = await internal(
      `/internal/boards/${boardId}/touched?at=${at()}`,
      'wrong-secret-0123456789abcdefghij',
    )
    expect(res.statusCode).toBe(401)
    expect(await state()).toBeNull()
  })
})

describe('when the last editor leaves', () => {
  it('GET /internal/boards/:bid/session-ended needs the internal secret; then a "session_end" checkpoint is saved at once', async () => {
    expect((await sessionEnded(boardId, null)).statusCode).toBe(401)
    expect((await sessionEnded(boardId, 'wrong-secret-0123456789abcdefghij')).statusCode).toBe(401)
    expect((await sessionEnded('NOT-A-BOARD')).statusCode).toBe(404)
    expect(await autos()).toEqual([])

    const got = recordEvents(events, boardId)
    expect((await sessionEnded()).statusCode).toBe(204)
    await service.idle()
    const [cp] = await autos()
    expect(cp).toMatchObject({ reason: 'session_end', name: 'After an editing session' })
    expect(got.map((e) => e.type)).toEqual(['history.snapshot'])
    expect(await state()).toMatchObject({ dirty_since: null, session_ended_at: null })
  })

  it('a second session end soon after waits until 10 minutes after the previous automatic checkpoint', async () => {
    alignTo(50) // the two checkpoints fall into different hours, so retention keeps both
    await sessionEnded()
    await service.idle()
    setContent(boardId, 'edited again')
    api.clock.advance(4 * MIN)
    await sessionEnded()
    await service.idle()
    expect(await autos()).toHaveLength(1)
    api.clock.advance(7 * MIN)
    expect(await service.runDue()).toBe(1)
    expect((await autos()).map((c) => c.reason)).toEqual(['session_end', 'session_end'])
  })

  it('a sync server that cannot be reached is retried with a backoff, then given up until the next change', async () => {
    sync.unavailable = true
    await sessionEnded()
    await service.idle()
    expect(await state()).toMatchObject({ failures: 1 })
    expect(await service.runDue()).toBe(0) // waiting for its retry time
    api.clock.advance(31_000)
    expect(await service.runDue()).toBe(1)
    expect(await state()).toMatchObject({ failures: 2 })
    api.clock.advance(61_000)
    expect(await service.runDue()).toBe(1) // third failure = maxFailures in this test
    expect(await state()).toMatchObject({ failures: 0, dirty_since: null, session_ended_at: null })
    sync.unavailable = false
    api.clock.advance(HOUR)
    expect(await service.runDue()).toBe(0)
    expect(await autos()).toEqual([])
    await sessionEnded() // the next session starts over
    await service.idle()
    expect(await autos()).toHaveLength(1)
  })
})

describe('before risky operations', () => {
  it('restoring a checkpoint as a new board first saves the board as it is now, unless it is unchanged', async () => {
    const v1 = (await saveManual('Version 1')).json()
    setContent(boardId, 'rewritten since')
    const res = await bob.req('POST', `/api/snapshots/${v1.id}/restore-as-new`, {})
    expect(res.statusCode).toBe(201)
    const [before] = await autos()
    expect(before).toMatchObject({ reason: 'before_restore', name: 'Before restoring “Version 1”' })
    expect(await storedText(boardId, before?.id ?? '')).toContain('rewritten since')

    // Restoring again with no change in between saves nothing more.
    expect((await bob.req('POST', `/api/snapshots/${v1.id}/restore-as-new`, {})).statusCode).toBe(201)
    expect(await autos()).toHaveLength(1)
  })

  it('restoring an automatic checkpoint after the board changed keeps that checkpoint (same hour, retention ran)', async () => {
    alignTo(5)
    await sessionEnded()
    await service.idle()
    const [sessionEnd] = await autos()
    setContent(boardId, 'changed after the session')
    api.clock.advance(2 * MIN)
    const res = await bob.req('POST', `/api/snapshots/${sessionEnd?.id}/restore-as-new`, {})
    expect(res.statusCode, res.body).toBe(201)
    expect((await autos()).map((c) => c.reason)).toEqual(['before_restore', 'session_end'])
    // And again: the restored checkpoint is still there to restore.
    expect((await bob.req('POST', `/api/snapshots/${sessionEnd?.id}/restore-as-new`, {})).statusCode).toBe(
      201,
    )
  })

  it('the restore still works when that checkpoint cannot be saved', async () => {
    const v1 = (await saveManual('Version 1')).json()
    setContent(boardId, 'rewritten since')
    const snapshot = sync.snapshot.bind(sync)
    let calls = 0
    sync.snapshot = async (bid) => {
      if (bid === boardId && calls++ === 0) throw new Error('sync hiccup')
      return snapshot(bid)
    }
    expect((await bob.req('POST', `/api/snapshots/${v1.id}/restore-as-new`, {})).statusCode).toBe(201)
    expect(await autos()).toEqual([])
  })

  it('an imported board gets an "As imported" checkpoint of its content before anyone edits it', async () => {
    const archive = (await bob.req('GET', `/api/boards/${boardId}/export`)).json()
    const res = await bob.req('POST', `/api/workspaces/${DEV_STUDIO}/boards/import`, archive)
    expect(res.statusCode).toBe(201)
    const newId = res.json().board.id as string
    const [cp] = await autos(newId)
    expect(cp).toMatchObject({ reason: 'import', name: 'As imported' })
    expect(await storedText(newId, cp?.id ?? '')).toContain('first idea')
  })
})

describe('manual checkpoints', () => {
  it('the 500 cap counts manual checkpoints only', async () => {
    const insert = (kind: 'manual' | 'auto', n: number) =>
      api.db.query(
        `INSERT INTO board_snapshots (id, workspace_id, board_id, name, kind, reason, created_at, document_clock,
                                      record_count, size_bytes, storage_key)
         SELECT 'snp_fill' || lpad(g::text, 8, '0') || $3, $1, $2, 'filler', $3,
                CASE WHEN $3 = 'auto' THEN 'hourly' END, now(), 0, 0, 0,
                'snapshots/' || $2 || '/snp_fill' || lpad(g::text, 8, '0') || $3 || '.json'
           FROM generate_series(1, $4::int) g`,
        [DEV_STUDIO, boardId, kind, n],
      )
    await insert('auto', 600)
    expect((await saveManual('Still fine')).statusCode).toBe(201)
    await insert('manual', 499)
    const refused = await saveManual('One too many')
    expect(refused.statusCode).toBe(409)
    expect(refused.json().error.code).toBe('SNAPSHOT_LIMIT')
  })

  it('stores a content hash, so an automatic checkpoint right after an equal manual one is skipped', async () => {
    expect((await saveManual('Named')).statusCode).toBe(201)
    const row = await api.db.one<{ content_hash: string | null }>('SELECT content_hash FROM board_snapshots')
    expect(row.content_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(await service.capture(boardId, 'hourly')).toEqual({ status: 'unchanged' })
  })

  it('a checkpoint saved before 0014 (no hash) is compared by its document clock', async () => {
    expect((await saveManual('Legacy')).statusCode).toBe(201)
    await api.db.query('UPDATE board_snapshots SET content_hash = NULL')
    expect(await service.capture(boardId, 'hourly')).toEqual({ status: 'unchanged' }) // same clock (42)
    const board = sync.boards.get(boardId)
    if (board) board.documentClock = 43
    expect((await service.capture(boardId, 'hourly')).status).toBe('saved')
  })
})

describe('retention', () => {
  it('deletes older automatic checkpoints with their stored bodies, never a manual one', async () => {
    alignTo(10) // three captures a minute apart, all in one hour
    const manual = (await saveManual('Keep forever')).json()
    const got = recordEvents(events, boardId)
    const ids: string[] = []
    for (const text of ['a', 'b', 'c']) {
      setContent(boardId, text)
      const out = await service.capture(boardId, 'hourly')
      if (out.status !== 'saved') throw new Error(`not saved: ${out.status}`)
      ids.push(out.checkpoint.id)
      api.clock.advance(MIN)
    }
    // Three in one hour: the newest one of the hour stays.
    expect((await autos()).map((c) => c.id)).toEqual([ids[2]])
    for (const gone of [ids[0], ids[1]]) {
      expect(await api.blobs.head(bodyKey(boardId, gone ?? ''))).toBeNull()
      expect(existsSync(bodyFile(boardId, gone ?? ''))).toBe(false)
    }
    expect(got.filter((e) => e.type === 'history.snapshot.removed')).toEqual([
      { type: 'history.snapshot.removed', data: { snapshotIds: [ids[0]] } },
      { type: 'history.snapshot.removed', data: { snapshotIds: [ids[1]] } },
    ])

    // Six months later the last automatic one goes too; the manual one never does.
    api.clock.advance(184 * DAY)
    bob = await api.login('bob') // sessions last 30 days
    expect(await service.pruneAll()).toBe(1)
    expect((await checkpoints()).map((c) => c.id)).toEqual([manual.id])
    expect(await api.blobs.head(bodyKey(boardId, ids[2] ?? ''))).toBeNull()
    expect(await api.blobs.head(bodyKey(boardId, manual.id))).not.toBeNull()
    expect(await api.db.one('SELECT count(*)::int AS n FROM board_snapshot_blob_deletions')).toEqual({ n: 0 })
  })

  it('a body that cannot be deleted stays queued and is deleted by the next pass', async () => {
    setContent(boardId, 'x')
    const out = await service.capture(boardId, 'hourly')
    if (out.status !== 'saved') throw new Error('not saved')
    const id = out.checkpoint.id
    const blobs = api.blobs as BlobStore & { delete: BlobStore['delete'] }
    const realDelete = blobs.delete.bind(blobs)
    blobs.delete = async () => {
      throw new Error('storage unavailable')
    }
    api.clock.advance(200 * DAY)
    bob = await api.login('bob') // sessions last 30 days
    await service.pruneAll()
    expect(await autos()).toEqual([]) // the row is gone at once
    expect(await api.blobs.head(bodyKey(boardId, id))).not.toBeNull()
    expect(
      await api.db.one(
        'SELECT storage_key, attempts FROM board_snapshot_blob_deletions WHERE board_id = $1',
        [boardId],
      ),
    ).toEqual({ storage_key: bodyKey(boardId, id), attempts: 2 }) // after the delete, and after pruneAll's drain
    blobs.delete = realDelete
    expect(await service.drainBlobDeletions()).toBe(1)
    expect(await api.blobs.head(bodyKey(boardId, id))).toBeNull()
    expect(await api.db.one('SELECT count(*)::int AS n FROM board_snapshot_blob_deletions')).toEqual({ n: 0 })
  })
})

describe('failures and limits never lose or starve a pending checkpoint', () => {
  it('a sync outage of several hours keeps the pending checkpoint; it is saved once sync is back (default retries)', async () => {
    await restart({ maxFailures: saved.maxFailures })
    sync.unavailable = true
    await sessionEnded()
    await service.idle()
    // Six hours of failures while the scheduler ticks every minute; nobody edits the board again.
    for (let m = 0; m < 6 * 60; m++) {
      api.clock.advance(MIN)
      await service.runDue()
    }
    expect(await state()).toMatchObject({ session_ended_at: expect.any(Date), dirty_since: expect.any(Date) })
    expect(await autos()).toEqual([])
    sync.unavailable = false
    for (let m = 0; m < 31; m++) {
      api.clock.advance(MIN)
      await service.runDue()
    }
    expect((await autos()).map((c) => c.reason)).toEqual(['session_end'])
    expect(await state()).toMatchObject({ dirty_since: null, session_ended_at: null, failures: 0 })
  })

  it('checkpoints made before restores (which viewers can run) never use up the room session-end and hourly ones need', async () => {
    await restart({ maxAutoPerBoard: 10 })
    const v1 = (await saveManual('Version 1')).json()
    // Someone restores over and over while the board keeps changing: each restore saves the board first.
    for (let i = 0; i < 12; i++) {
      setContent(boardId, `edit ${i}`)
      const res = await bob.req('POST', `/api/snapshots/${v1.id}/restore-as-new`, {})
      expect(res.statusCode, res.body).toBe(201)
      api.clock.advance(MIN)
    }
    expect((await autos()).every((c) => c.reason === 'before_restore')).toBe(true)
    expect((await autos()).length).toBeLessThan(10)
    // Then the last editor leaves after more changes: that checkpoint is still saved.
    setContent(boardId, 'the final state')
    await sessionEnded()
    await service.idle()
    api.clock.advance(11 * MIN)
    expect(await service.runDue()).toBe(1)
    const [newest] = await autos()
    expect(newest).toMatchObject({ reason: 'session_end' })
    expect(await storedText(boardId, newest?.id ?? '')).toContain('the final state')
  })

  it('a board at the automatic-checkpoint limit is tried again an hour later, not re-read from sync every minute', async () => {
    await restart({ maxAutoPerBoard: 2 })
    alignTo(5)
    for (const text of ['a', 'b']) {
      setContent(boardId, text)
      expect((await service.capture(boardId, 'hourly')).status).toBe('saved')
      api.clock.advance(HOUR) // distinct hours: retention keeps both
    }
    setContent(boardId, 'c')
    await touch()
    api.clock.advance(61 * MIN)
    expect(await service.runDue()).toBe(1)
    expect(await autos()).toHaveLength(2) // at the limit: nothing saved
    const reads = sync.snapshots.length
    for (let m = 0; m < 30; m++) {
      api.clock.advance(MIN)
      await service.runDue()
    }
    expect(sync.snapshots).toHaveLength(reads)
    expect(await state()).toMatchObject({ dirty_since: expect.any(Date) }) // still pending
  })
})
