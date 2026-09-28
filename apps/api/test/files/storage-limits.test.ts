// SEAM-02: one anonymous workshop guest must not be able to use up the whole workspace quota, so every
// name-only guest has an allowance of their own (bytes and files per workspace). Account users keep only
// the workspace quota. SEAM-11: dashboard thumbnails count toward the workspace's storage, and a
// workspace holds a bounded number of boards.

import { crc32 } from 'node:zlib'
import type { LightMyRequestResponse } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config.ts'
import { guestLink, joinAsGuest } from '../features/guests/support.ts'
import { createFakeSync } from '../features/history/helpers.ts'
import { png } from '../features/thumbnails/images.ts'
import { createBoard, createTestApi, DEV_STUDIO, ORIGIN, type TestApi, testEnv } from '../helpers.ts'

let api: TestApi | undefined
afterEach(async () => {
  await api?.close()
  api = undefined
})

const KiB = 1024
const MiB = 1024 * KiB

interface Uploader {
  cookie: string
}

const upload = async (who: Uploader, boardId: string, size: number, name = 'notes.bin') => {
  const res = await api?.app.inject({
    method: 'POST',
    url: `/api/boards/${boardId}/assets`,
    payload: Buffer.alloc(size, 1),
    headers: {
      origin: ORIGIN,
      cookie: who.cookie,
      'content-type': 'application/octet-stream',
      'x-file-name': name,
    },
  })
  if (!res) throw new Error('no api')
  return res
}

const error = (res: LightMyRequestResponse) =>
  (res.json() as { error: { code: string; message: string } }).error

describe('per-guest upload allowance (SEAM-02)', () => {
  it('defaults: 1 GB and 200 files per guest per workspace, 10,000 boards per workspace, collector report-only', () => {
    const c = loadConfig(testEnv('/tmp/dr'))
    expect(c.storage).toEqual({
      guestQuota: { maxBytes: 1024 * MiB, maxFiles: 200 },
      maxBoardsPerWorkspace: 10_000,
      assetGc: { mode: 'report', intervalMs: 6 * 3600_000, firstRunDelayMs: 10 * 60_000 },
    })
    const set = loadConfig(
      testEnv('/tmp/dr', {
        DRAFTROOM_GUEST_QUOTA_MB: '5',
        DRAFTROOM_GUEST_MAX_FILES: '7',
        DRAFTROOM_WORKSPACE_MAX_BOARDS: '9',
        DRAFTROOM_ASSET_GC: 'delete',
        DRAFTROOM_ASSET_GC_INTERVAL_MIN: '30',
      }),
    ).storage
    expect(set).toEqual({
      guestQuota: { maxBytes: 5 * MiB, maxFiles: 7 },
      maxBoardsPerWorkspace: 9,
      assetGc: { mode: 'delete', intervalMs: 30 * 60_000, firstRunDelayMs: 10 * 60_000 },
    })
    for (const [name, value] of [
      ['DRAFTROOM_GUEST_QUOTA_MB', '0'],
      ['DRAFTROOM_GUEST_MAX_FILES', 'many'],
      ['DRAFTROOM_WORKSPACE_MAX_BOARDS', '0'],
      ['DRAFTROOM_ASSET_GC', 'yes'],
      ['DRAFTROOM_ASSET_GC_INTERVAL_MIN', '1'],
    ] as const)
      expect(() => loadConfig(testEnv('/tmp/dr', { [name]: value })), `${name}=${value}`).toThrow(name)
  })

  it('a guest who used their allowance is refused with a clear message; the owner and other boards keep working', async () => {
    api = await createTestApi({
      env: {
        DRAFTROOM_WORKSPACE_QUOTA_MB: '4',
        DRAFTROOM_GUEST_QUOTA_MB: '1',
        DRAFTROOM_GUEST_MAX_FILES: '50',
      },
    })
    const alice = await api.login('alice')
    const board = await createBoard(alice, DEV_STUDIO, 'Workshop')
    const other = await createBoard(alice, DEV_STUDIO, 'Another DBC project')
    const guest = await joinAsGuest(api, (await guestLink(alice, board, { role: 'editor' })).url, 'Anon')

    expect((await upload(guest, board, MiB - 2 * KiB)).statusCode).toBe(201)
    const refused = await upload(guest, board, 8 * KiB)
    expect(refused.statusCode).toBe(413)
    expect(error(refused).code).toBe('GUEST_STORAGE_LIMIT')
    expect(error(refused).message).toMatch(/^As a guest you can add up to 1 MB of files to this workspace/)
    expect(error(refused).message).toMatch(/sign in with an account/i)
    // The finding's probe: the owner, on a board the guest never saw, can still upload.
    expect((await upload(alice, other, 8 * KiB)).statusCode).toBe(201)
    expect((await upload(alice, board, 2 * MiB)).statusCode).toBe(201)

    // Every guest has an allowance of their own.
    const second = await joinAsGuest(api, (await guestLink(alice, board, { role: 'editor' })).url, 'Bea')
    expect((await upload(second, board, 512 * KiB)).statusCode).toBe(201)
  })

  it('counts files too, and only for name-only guests: account users (even workspace guests) have only the workspace quota', async () => {
    api = await createTestApi({ env: { DRAFTROOM_GUEST_QUOTA_MB: '1', DRAFTROOM_GUEST_MAX_FILES: '2' } })
    const alice = await api.login('alice')
    const bob = await api.login('bob')
    const board = await createBoard(alice, DEV_STUDIO, 'Workshop')
    const guest = await joinAsGuest(api, (await guestLink(alice, board, { role: 'editor' })).url, 'Gus')
    expect((await upload(guest, board, 10)).statusCode).toBe(201)
    expect((await upload(guest, board, 10)).statusCode).toBe(201)
    const third = await upload(guest, board, 10)
    expect(third.statusCode).toBe(413)
    expect(error(third)).toEqual({
      code: 'GUEST_FILE_LIMIT',
      message:
        "As a guest you can add up to 2 files to this workspace, and you've reached that. Ask the person who shared the link to add more, or sign in with an account.",
    })

    // bob has an account; as a workspace guest (board invitation only) he is not held to the guest allowance.
    await api.db.query(
      "UPDATE workspace_members SET role = 'guest' WHERE workspace_id = $1 AND user_id = $2",
      [DEV_STUDIO, bob.userId],
    )
    expect(
      (await alice.req('PUT', `/api/boards/${board}/members/${bob.userId}`, { role: 'editor' })).statusCode,
    ).toBe(200)
    for (let i = 0; i < 3; i++) expect((await upload(bob, board, 10)).statusCode).toBe(201)
    expect((await upload(bob, board, 2 * MiB)).statusCode).toBe(201)
  })
})

/** A valid PNG padded to about `bytes` with a text chunk (the thumbnail route only reads the header). */
function paddedPng(bytes: number): Buffer {
  const base = png(4, 4)
  const iend = base.subarray(base.length - 12)
  const data = Buffer.concat([
    Buffer.from('pad\0'),
    Buffer.alloc(Math.max(0, bytes - base.length - 16), 0x41),
  ])
  const head = Buffer.from('tEXt', 'ascii')
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head, data])) >>> 0)
  return Buffer.concat([base.subarray(0, base.length - 12), len, head, data, crc, iend])
}

describe('thumbnails and boards count toward a workspace (SEAM-11)', () => {
  it('thumbnail bytes are part of the storage the upload quota checks', async () => {
    api = await createTestApi({ env: { DRAFTROOM_WORKSPACE_QUOTA_MB: '1' } })
    const alice = await api.login('alice')
    const thumb = paddedPng(250 * KiB)
    for (let i = 0; i < 3; i++) {
      const b = await createBoard(alice, DEV_STUDIO, `Board ${i}`)
      const res = await alice.req('PUT', `/api/boards/${b}/thumbnail`, thumb, { 'content-type': 'image/png' })
      expect(res.statusCode, res.body).toBe(200)
    }
    const board = await createBoard(alice, DEV_STUDIO, 'Files')
    // 3 x 250 KB of thumbnails are stored: a 300 KB file no longer fits in 1 MB.
    const refused = await upload(alice, board, 300 * KiB)
    expect(refused.statusCode).toBe(413)
    expect(error(refused).code).toBe('STORAGE_QUOTA_EXCEEDED')
    expect((await upload(alice, board, 200 * KiB)).statusCode).toBe(201)
  })

  it('a workspace holds at most DRAFTROOM_WORKSPACE_MAX_BOARDS boards, trashed ones included, however they are made', async () => {
    // A fake sync server: a duplicate reads the source canvas first.
    api = await createTestApi({
      env: { DRAFTROOM_WORKSPACE_MAX_BOARDS: '3' },
      deps: { syncInternal: createFakeSync() },
    })
    const alice = await api.login('alice')
    const bob = await api.login('bob')
    const a = await createBoard(alice, DEV_STUDIO, 'A')
    await createBoard(alice, DEV_STUDIO, 'B')
    const c = await createBoard(bob, DEV_STUDIO, 'C')
    expect((await alice.req('POST', `/api/boards/${c}/trash`)).statusCode).toBe(200)
    const refused = await alice.req('POST', `/api/workspaces/${DEV_STUDIO}/boards`, { title: 'D' })
    expect(refused.statusCode).toBe(409)
    expect(error(refused)).toEqual({
      code: 'BOARD_LIMIT_REACHED',
      message:
        "This workspace has reached its limit of 3 boards (boards in the trash count too), so a new board can't be made here. Ask a workspace owner for help.",
    })
    // Copies are boards too.
    const copy = await alice.req('POST', `/api/boards/${a}/duplicate`, {})
    expect(copy.statusCode).toBe(409)
    expect(error(copy).code).toBe('BOARD_LIMIT_REACHED')
    // Another workspace is not affected.
    const mine = await alice.req('POST', `/api/workspaces/${alice.personalWorkspaceId}/boards`, {
      title: 'Mine',
    })
    expect(mine.statusCode).toBe(201)
  })
})
