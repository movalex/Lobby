// J4 CKPT-FLOOD (wave J): a checkpoint is a full copy of the board and checkpoint bodies were outside every
// storage limit: 500 manual ones a board, each as large as the board (an editor can save 60 a minute, on
// every board they can edit). Their bytes are capped now (history/checkpoint-caps.ts): per board for the
// manual ones, per board for all of them, and per workspace for the manual ones. Each test fails on the code
// before J4, where every save under 500 succeeds whatever it weighs.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { checkpointByteCaps, workspaceCheckpointCap } from '../../../src/features/history/checkpoint-caps.ts'
import { type CheckpointService, checkpointSettings } from '../../../src/features/history/checkpoints.ts'
import { checkpointServices } from '../../../src/features/history/index.ts'
import { type Client, createBoard, createTestApi, DEV_STUDIO, type TestApi } from '../../helpers.ts'
import { baseRecords, createFakeSync, type FakeSync, noteRec } from './helpers.ts'

const MiB = 1024 * 1024

let api: TestApi
let sync: FakeSync
let bob: Client
let service: CheckpointService
let boardId: string
const savedSettings = { ...checkpointSettings }
const savedCaps = { ...checkpointByteCaps }

/** Builds the app (the settings are read when it is built): `env` for another quota. */
async function start(env: Record<string, string> = {}) {
  Object.assign(checkpointSettings, savedSettings, { tickMs: 0, pruneEveryMs: 0 })
  sync = createFakeSync()
  api = await createTestApi({ deps: { syncInternal: sync }, env })
  await api.login('owner')
  bob = await api.login('bob')
  boardId = await createBoard(bob, DEV_STUDIO, 'Roadmap')
  setContent(boardId, 'first idea')
  const s = checkpointServices.get(api.app)
  if (!s) throw new Error('no checkpoint service')
  service = s
}
beforeEach(() => start())
afterEach(async () => {
  vi.unstubAllEnvs()
  Object.assign(checkpointSettings, savedSettings)
  Object.assign(checkpointByteCaps, savedCaps)
  await api.close()
})

function setContent(bid: string, text: string) {
  sync.setBoard(bid, [...baseRecords(), noteRec('n1', text)])
}
const save = (name: string, bid = boardId, c: Client = bob) =>
  c.req('POST', `/api/boards/${bid}/snapshots`, { name })
const rows = async (bid = boardId) =>
  (
    await api.db.one<{ n: number }>('SELECT count(*)::int AS n FROM board_snapshots WHERE board_id = $1', [
      bid,
    ])
  ).n
const sizeOf = async (id: string) =>
  Number(
    (await api.db.one<{ size_bytes: number }>('SELECT size_bytes FROM board_snapshots WHERE id = $1', [id]))
      .size_bytes,
  )

describe('the shipped caps', () => {
  it('256 MiB of manual checkpoints and 1 GiB of all of them per board; per workspace, the upload quota', () => {
    expect(savedCaps).toEqual({
      manualBytesPerBoard: 256 * MiB,
      totalBytesPerBoard: 1024 * MiB,
      manualBytesPerWorkspace: 0,
    })
  })
})

describe('a board’s manual checkpoints stop at their byte cap', () => {
  it('409 SNAPSHOT_BYTES_LIMIT with a plain message, nothing stored for the refused one, room again after a delete', async () => {
    const first = await save('One')
    expect(first.statusCode, first.body).toBe(201)
    const S = await sizeOf(first.json().id)
    expect(S).toBeGreaterThan(500)
    checkpointByteCaps.manualBytesPerBoard = 2 * S + 10
    const second = await save('Two')
    expect(second.statusCode, second.body).toBe(201)

    // two fit; a third does not (the board is read, then the exact size is known: the stored body is removed again)
    const remove = vi.spyOn(api.blobs, 'delete')
    const third = await save('Three')
    expect(third.statusCode, third.body).toBe(409)
    expect(third.json().error.code).toBe('SNAPSHOT_BYTES_LIMIT')
    expect(third.json().error.message).toMatch(/already take up as much space/)
    expect(await rows()).toBe(2)
    expect(remove).toHaveBeenCalledTimes(1)

    // at the cap exactly, the next save is refused before the board is even read from the sync server
    checkpointByteCaps.manualBytesPerBoard = 2 * S
    const reads = sync.snapshots.length
    const put = vi.spyOn(api.blobs, 'put')
    const fourth = await save('Four')
    expect(fourth.statusCode).toBe(409)
    expect(fourth.json().error.code).toBe('SNAPSHOT_BYTES_LIMIT')
    expect(sync.snapshots).toHaveLength(reads)
    expect(put).not.toHaveBeenCalled()

    // deleting one gives room again
    expect((await bob.req('DELETE', `/api/snapshots/${first.json().id}`)).statusCode).toBe(204)
    expect((await save('Five')).statusCode).toBe(201)
    expect(await rows()).toBe(2)
  })

  it('a heavy board fills its cap with few checkpoints while a light one keeps many (bytes, not counts)', async () => {
    const cap = 40 * 1024
    checkpointByteCaps.manualBytesPerBoard = cap
    const light = await save('Light')
    expect(light.statusCode).toBe(201)
    const lightSize = await sizeOf(light.json().id)
    const lightCount = Math.floor(cap / lightSize)
    expect(lightCount).toBeGreaterThan(15)
    for (let i = 1; i < lightCount; i++) expect((await save(`Light ${i}`)).statusCode).toBe(201)
    expect((await save('One too many')).statusCode).toBe(409)

    const heavyBoard = await createBoard(bob, DEV_STUDIO, 'Huge')
    sync.setBoard(heavyBoard, [...baseRecords(), noteRec('big', 'word '.repeat(2_400))]) // about 12 kB
    const first = await save('Heavy 0', heavyBoard)
    expect(first.statusCode, first.body).toBe(201)
    const heavySize = await sizeOf(first.json().id)
    expect(heavySize).toBeGreaterThan(8 * lightSize)
    let saved = 1
    for (let i = 1; i < 10; i++) {
      const res = await save(`Heavy ${i}`, heavyBoard)
      if (res.statusCode !== 201) {
        expect(res.json().error.code).toBe('SNAPSHOT_BYTES_LIMIT')
        break
      }
      saved++
    }
    expect(saved).toBe(Math.floor(cap / heavySize))
    expect(saved).toBeLessThan(lightCount / 5)
  })

  it('simultaneous saves at the boundary: exactly as many as fit succeed (the rest are 409)', async () => {
    const first = await save('Seed')
    const S = await sizeOf(first.json().id)
    checkpointByteCaps.manualBytesPerBoard = Math.floor(3.5 * S) // the first plus two more
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => save(`Race ${i}`)))
    const ok = results.filter((r) => r.statusCode === 201)
    const refused = results.filter((r) => r.statusCode === 409)
    expect(ok.length + refused.length, results.map((r) => r.statusCode).join(',')).toBe(8)
    expect(ok).toHaveLength(2)
    expect(refused.every((r) => r.json().error.code === 'SNAPSHOT_BYTES_LIMIT')).toBe(true)
    expect(await rows()).toBe(3)
  })
})

describe('a board’s total (manual and automatic)', () => {
  it('a manual save is refused past it, an automatic one is skipped like at the count cap, and a restore goes on without its safety checkpoint', async () => {
    const auto = await service.capture(boardId, 'hourly')
    expect(auto.status).toBe('saved')
    if (auto.status !== 'saved') return
    const S = auto.checkpoint.sizeBytes
    checkpointByteCaps.totalBytesPerBoard = S + Math.floor(S / 2)

    // different content: not "unchanged", so it is the size that decides
    setContent(boardId, 'second idea')
    expect(await service.capture(boardId, 'hourly')).toEqual({ status: 'skipped', why: 'limit' })
    expect(await rows()).toBe(1)

    const manual = await save('Named')
    expect(manual.statusCode, manual.body).toBe(409)
    expect(manual.json().error.code).toBe('SNAPSHOT_BYTES_LIMIT')
    expect(manual.json().error.message).toMatch(/version history has reached its size limit/)

    // restoring a checkpoint as a new board must not fail because the safety checkpoint of the old board was skipped
    const restored = await bob.req('POST', `/api/snapshots/${auto.checkpoint.id}/restore-as-new`, {})
    expect(restored.statusCode, restored.body).toBe(201)
    expect(await rows()).toBe(1) // still only the one checkpoint of the source board
  })

  it('retention gets its chance first: an automatic checkpoint is saved when pruning the board’s old ones makes room', async () => {
    const probe = await service.capture(boardId, 'hourly')
    if (probe.status !== 'saved') throw new Error('not saved')
    const S = probe.checkpoint.sizeBytes
    // a year-old automatic checkpoint that retention will delete, and that is big enough to put the board over its cap
    await api.db.query(
      `INSERT INTO board_snapshots (id, workspace_id, board_id, name, kind, reason, created_at, document_clock,
                                    record_count, size_bytes, storage_key)
       VALUES ('snp_oldfiller0001', $1, $2, 'old', 'auto', 'hourly', now() - interval '400 days', 0, 0, $3,
               'snapshots/' || $2 || '/snp_oldfiller0001.json')`,
      [DEV_STUDIO, boardId, 10 * S],
    )
    checkpointByteCaps.totalBytesPerBoard = 3 * S
    setContent(boardId, 'second idea')
    const next = await service.capture(boardId, 'session_end')
    expect(next.status).toBe('saved')
    const left = await api.db.query<{ id: string }>('SELECT id FROM board_snapshots WHERE board_id = $1', [
      boardId,
    ])
    expect(left.rows.map((r) => r.id)).not.toContain('snp_oldfiller0001')
  })
})

describe('a workspace’s manual checkpoints', () => {
  it('are capped across its boards, per workspace, and the cap defaults to the upload quota', async () => {
    const S = await sizeOf((await save('Probe')).json().id)
    checkpointByteCaps.manualBytesPerWorkspace = 3 * S + 10 // the probe and two more, on any boards
    const second = await createBoard(bob, DEV_STUDIO, 'Other board')
    sync.setBoard(second, [...baseRecords(), noteRec('n1', 'first idea')])
    expect((await save('On the other board', second)).statusCode).toBe(201)
    expect((await save('Again')).statusCode).toBe(201)
    const over = await save('One too many', second)
    expect(over.statusCode, over.body).toBe(409)
    expect(over.json().error.code).toBe('SNAPSHOT_BYTES_LIMIT')
    expect(over.json().error.message).toMatch(/workspace’s saved checkpoints have reached their size limit/)

    // another workspace has its own allowance
    const mine = await createBoard(bob, bob.personalWorkspaceId, 'Personal')
    sync.setBoard(mine, [...baseRecords(), noteRec('n1', 'first idea')])
    expect((await save('Elsewhere', mine)).statusCode).toBe(201)
  })

  it('by default the allowance is the workspace’s upload quota (DRAFTROOM_WORKSPACE_QUOTA_MB)', async () => {
    await api.close()
    await start({ DRAFTROOM_WORKSPACE_QUOTA_MB: '1' })
    expect(checkpointByteCaps.manualBytesPerWorkspace).toBe(0)
    sync.setBoard(boardId, [...baseRecords(), noteRec('big', 'word '.repeat(80_000))]) // about 400 kB
    expect((await save('One')).statusCode).toBe(201)
    expect((await save('Two')).statusCode).toBe(201)
    const third = await save('Three') // 1.2 MB of a 1 MiB allowance
    expect(third.statusCode, third.body).toBe(409)
    expect(third.json().error.code).toBe('SNAPSHOT_BYTES_LIMIT')
  })

  it('DRAFTROOM_CHECKPOINT_WORKSPACE_MB sets the allowance on its own: raising the upload quota does not raise it', async () => {
    vi.stubEnv('DRAFTROOM_CHECKPOINT_WORKSPACE_MB', '1')
    await api.close()
    await start({ DRAFTROOM_WORKSPACE_QUOTA_MB: '5000' }) // a big upload quota
    expect(checkpointByteCaps.manualBytesPerWorkspace).toBe(0)
    sync.setBoard(boardId, [...baseRecords(), noteRec('big', 'word '.repeat(80_000))]) // about 400 kB
    expect((await save('One')).statusCode).toBe(201)
    expect((await save('Two')).statusCode).toBe(201)
    const third = await save('Three') // 1.2 MB of the 1 MiB the variable allows
    expect(third.statusCode, third.body).toBe(409)
    expect(third.json().error.code).toBe('SNAPSHOT_BYTES_LIMIT')
  })

  it('the variable is a whole number of MB in 1 to 1,048,576, else the upload quota applies; the setting wins over both', () => {
    const quota = 2048 * MiB
    expect(workspaceCheckpointCap(quota, {})).toBe(quota)
    expect(workspaceCheckpointCap(quota, { DRAFTROOM_CHECKPOINT_WORKSPACE_MB: '512' })).toBe(512 * MiB)
    expect(workspaceCheckpointCap(quota, { DRAFTROOM_CHECKPOINT_WORKSPACE_MB: ' 4096 ' })).toBe(4096 * MiB)
    for (const bad of ['', '0', '-5', '12x', '1.5', '2000000', 'lots'])
      expect(workspaceCheckpointCap(quota, { DRAFTROOM_CHECKPOINT_WORKSPACE_MB: bad }), bad).toBe(quota)
    checkpointByteCaps.manualBytesPerWorkspace = 7 * MiB
    expect(workspaceCheckpointCap(quota, { DRAFTROOM_CHECKPOINT_WORKSPACE_MB: '512' })).toBe(7 * MiB)
  })

  it('automatic checkpoints are not capped per workspace (they are the safety net)', async () => {
    const S = await sizeOf((await save('Probe')).json().id)
    checkpointByteCaps.manualBytesPerWorkspace = S // the workspace's manual allowance is used up
    expect((await save('Refused')).statusCode).toBe(409)
    setContent(boardId, 'second idea')
    expect((await service.capture(boardId, 'before_restore')).status).toBe('saved')
  })
})
