// FC-1 wired into the real API (docs/SECURITY-REVIEW-2026-09-27.md): the upload quota and rate limit
// come from the environment with staging defaults, and the rate limit is keyed on the session user
// (every browser behind one office NAT, or one proxy, has its own budget).

import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.ts'
import {
  type Client,
  createBoard,
  createTestApi,
  DEV_STUDIO,
  ORIGIN,
  type TestApi,
  testEnv,
} from './helpers.ts'

let api: TestApi | undefined
afterEach(async () => {
  await api?.close()
  api = undefined
})

const MiB = 1024 * 1024

const upload = (c: Client, boardId: string, size = 5, declared?: number) =>
  api?.app.inject({
    method: 'POST',
    url: `/api/boards/${boardId}/assets`,
    payload: Buffer.alloc(size, 1),
    headers: {
      origin: ORIGIN,
      cookie: c.cookie,
      'content-type': 'application/octet-stream',
      'x-file-name': 'notes.bin',
      ...(declared === undefined ? {} : { 'content-length': String(declared) }),
    },
  })

describe('upload limits configuration', () => {
  it('defaults: 2 GB and 5,000 files per workspace, 120 uploads per user per minute', () => {
    const c = loadConfig(testEnv('/tmp/dr'))
    expect(c.uploads).toEqual({
      workspaceQuotaBytes: 2048 * MiB,
      workspaceMaxFiles: 5_000,
      perUserPerMinute: 120,
    })
  })

  it('reads DRAFTROOM_WORKSPACE_QUOTA_MB, DRAFTROOM_WORKSPACE_MAX_FILES and DRAFTROOM_UPLOADS_PER_MINUTE, and refuses nonsense', () => {
    const c = loadConfig(
      testEnv('/tmp/dr', {
        DRAFTROOM_WORKSPACE_QUOTA_MB: '10',
        DRAFTROOM_WORKSPACE_MAX_FILES: '3',
        DRAFTROOM_UPLOADS_PER_MINUTE: '2',
      }),
    )
    expect(c.uploads).toEqual({ workspaceQuotaBytes: 10 * MiB, workspaceMaxFiles: 3, perUserPerMinute: 2 })
    for (const [name, value] of [
      ['DRAFTROOM_WORKSPACE_QUOTA_MB', '0'],
      ['DRAFTROOM_WORKSPACE_QUOTA_MB', '-5'],
      ['DRAFTROOM_WORKSPACE_MAX_FILES', 'lots'],
      ['DRAFTROOM_UPLOADS_PER_MINUTE', '0'],
    ] as const)
      expect(() => loadConfig(testEnv('/tmp/dr', { [name]: value })), `${name}=${value}`).toThrow(name)
  })
})

describe('upload limits in the API', () => {
  it('rate limit is per signed-in user: an editor who repeats uploads gets 429, a colleague on the same connection does not', async () => {
    api = await createTestApi({ env: { DRAFTROOM_UPLOADS_PER_MINUTE: '2' } })
    const alice = await api.login('alice')
    const bob = await api.login('bob')
    const carol = await api.login('carol')
    const boardId = await createBoard(alice, DEV_STUDIO, 'Mood board')
    for (const c of [bob, carol])
      expect(
        (await alice.req('PUT', `/api/boards/${boardId}/members/${c.userId}`, { role: 'editor' })).statusCode,
      ).toBe(200)
    const codes: number[] = []
    for (let i = 0; i < 3; i++) codes.push((await upload(bob, boardId))?.statusCode ?? 0)
    expect(codes).toEqual([201, 201, 429])
    const refused = await upload(bob, boardId)
    expect(refused?.json()).toEqual({ error: { code: 'RATE_LIMITED', message: expect.any(String) } })
    expect(Number(refused?.headers['retry-after'])).toBeGreaterThan(0)
    expect((await upload(carol, boardId))?.statusCode).toBe(201)
    api.clock.advance(61_000)
    expect((await upload(bob, boardId))?.statusCode).toBe(201)
  })

  it('the workspace quota applies to every editor of the workspace’s boards (413 with a user-safe message)', async () => {
    api = await createTestApi({
      env: { DRAFTROOM_WORKSPACE_QUOTA_MB: '1', DRAFTROOM_WORKSPACE_MAX_FILES: '3' },
    })
    const alice = await api.login('alice')
    const bob = await api.login('bob')
    const a = await createBoard(alice, DEV_STUDIO, 'A')
    const b = await createBoard(bob, DEV_STUDIO, 'B')
    expect((await upload(alice, a, MiB - 10))?.statusCode).toBe(201)
    const full = await upload(bob, b, 11)
    expect(full?.statusCode).toBe(413)
    expect(full?.json()).toEqual({
      error: {
        code: 'STORAGE_QUOTA_EXCEEDED',
        message: expect.stringMatching(/1 MB of file storage/),
      },
    })
    expect((await upload(bob, b, 10))?.statusCode).toBe(201)
    // Bob's personal workspace is separate.
    const mine = await createBoard(bob, bob.personalWorkspaceId, 'Mine')
    expect((await upload(bob, mine, 100))?.statusCode).toBe(201)
    expect((await upload(bob, mine, 1))?.statusCode).toBe(201)
    expect((await upload(bob, mine, 1))?.statusCode).toBe(201)
    const files = await upload(bob, mine, 1)
    expect(files?.statusCode).toBe(413)
    expect(files?.json().error.code).toBe('FILE_LIMIT_REACHED')
  })
})
