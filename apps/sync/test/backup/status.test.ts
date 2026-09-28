// The sync server's wiring of offsite backups: GET /internal/backups/status behind the internal
// secret, a real server uploading after its own backups, and the configuration it is built from.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig, parseBackupStore } from '../../src/config.ts'
import { note, RoomClient } from '../deleted/fixtures.ts'
import { callInternal, errorCode, TEST_INTERNAL_SECRET, TEST_TICKET_SECRET } from '../harness/tickets.ts'
import { startServer, type TestServer, waitFor } from '../http/helpers.ts'

const BOARD = 'status-board'
let cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const c of cleanups.reverse()) await c()
  cleanups = []
})

async function server(opts: Parameters<typeof startServer>[0] = {}) {
  const s = await startServer(opts)
  cleanups.push(() => s.stop())
  return s
}

/** A server with an fs offsite store (in production the root is <DATA>/blobs; any folder works here). */
async function serverWithFsStore(): Promise<TestServer> {
  const root = mkdtempSync(join(tmpdir(), 'dr-status-blobs-'))
  cleanups.push(async () => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  const s = await server({ config: { backupStore: { kind: 'fs', root } } })
  await waitFor(() => s.server.backups.status().running, 5_000, 'the offsite copy to start')
  return s
}

describe('GET /internal/backups/status', () => {
  it('needs the internal secret, like every internal route', async () => {
    const s = await server()
    for (const secret of [null, 'wrong-secret-0123456789-0123456789-0123'])
      expect((await callInternal(s.url, 'GET', '/internal/backups/status', { secret })).status).toBe(401)
    const post = await callInternal(s.url, 'POST', '/internal/backups/status')
    expect(post.status).toBe(405)
    expect(await errorCode(post)).toBe('METHOD_NOT_ALLOWED')
  })

  it('says "off" when no offsite store is configured', async () => {
    const s = await server()
    const res = await callInternal(s.url, 'GET', '/internal/backups/status')
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.json()).toEqual({
      store: 'off',
      prefix: null,
      running: false,
      lastPassAt: null,
      failuresTotal: 0,
      boards: [],
    })
    expect(s.logs).toContain('[backup] offsite backups: off')
  })

  it('shows the last offsite success per board after the server backed a board up', async () => {
    const s = await serverWithFsStore()
    expect(s.logs.some((l) => l.startsWith('[backup] offsite backups: fs ('))).toBe(true)
    const c = new RoomClient(s.server.registry.getOrCreate(BOARD), 'usr_a')
    await c.connect()
    await c.put(note('n1', 'status'))
    const entry = await s.server.registry.backupNow(BOARD)
    if (!entry) throw new Error('no backup')
    type Body = {
      store: string
      prefix: string
      running: boolean
      boards: Array<{ boardId: string; lastSuccessFile: string | null; failures: number }>
    }
    let body: Body | null = null
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      body = (await (await callInternal(s.url, 'GET', '/internal/backups/status')).json()) as Body
      if (body.boards[0]?.lastSuccessFile === entry.file) break
      await new Promise((r) => setTimeout(r, 25))
    }
    expect(body).toMatchObject({ store: 'fs', prefix: 'backups/sync', running: true })
    expect(body?.boards).toEqual([
      expect.objectContaining({ boardId: BOARD, lastSuccessFile: entry.file, failures: 0 }),
    ])
    // closing the server stops the offsite copy with it
    await s.server.close()
    expect(s.server.backups.status().running).toBe(false)
  })
})

describe('configuration', () => {
  const base = {
    DRAFTROOM_DATA_DIR: './.data-test',
    DRAFTROOM_TICKET_SECRET: TEST_TICKET_SECRET,
    DRAFTROOM_INTERNAL_SECRET: TEST_INTERNAL_SECRET,
  }
  const r2 = {
    DRAFTROOM_BACKUP_STORE: 'r2',
    R2_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
    R2_ACCESS_KEY_ID: 'AKIAFAKEACCESSKEY0001',
    R2_SECRET_ACCESS_KEY: 'fakeSecretAccessKey0123456789+/=',
    R2_BUCKET: 'draftroom-staging',
  }

  it('is off by default, in development and in production alike', () => {
    expect(loadConfig(base).backupStore).toEqual({ kind: 'off' })
    for (const v of ['', ' ', 'off'])
      expect(parseBackupStore({ DRAFTROOM_BACKUP_STORE: v }, '/d')).toEqual({ kind: 'off' })
    const prod = {
      ...base,
      NODE_ENV: 'production',
      DRAFTROOM_API_INTERNAL_URL: 'draftroom-staging-api:10000',
      ALLOWED_ORIGINS: 'https://draftroom-staging-web.onrender.com',
    }
    expect(loadConfig(prod).backupStore).toEqual({ kind: 'off' })
  })

  it('fs writes under <DATA>/blobs (the same layout as the one R2 bucket)', () => {
    expect(loadConfig({ ...base, DRAFTROOM_BACKUP_STORE: 'fs' }).backupStore).toEqual({
      kind: 'fs',
      root: join(resolve('./.data-test'), 'blobs'),
    })
  })

  it('r2 needs the four R2_* values and checks them without echoing any', () => {
    expect(parseBackupStore(r2, '/d')).toEqual({
      kind: 'r2',
      accountId: r2.R2_ACCOUNT_ID,
      accessKeyId: r2.R2_ACCESS_KEY_ID,
      secretAccessKey: r2.R2_SECRET_ACCESS_KEY,
      bucket: r2.R2_BUCKET,
      endpoint: null,
      dedicated: { bucket: false, credentials: false },
    })
    for (const k of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'] as const)
      expect(() => parseBackupStore({ ...r2, [k]: '' }, '/d'), k).toThrow(
        new RegExp(`DRAFTROOM_BACKUP_STORE=r2 requires ${k}`),
      )
    const bad: Array<[string, string, RegExp]> = [
      ['R2_ACCOUNT_ID', 'not-hex-account', /R2_ACCOUNT_ID/],
      ['R2_ACCESS_KEY_ID', 'has space in it 12345', /R2_ACCESS_KEY_ID is malformed/],
      ['R2_SECRET_ACCESS_KEY', 'quote"in-secret-0123456789', /R2_SECRET_ACCESS_KEY is malformed/],
      ['R2_SECRET_ACCESS_KEY', r2.R2_ACCESS_KEY_ID, /must differ/],
      ['R2_BUCKET', 'Bad_Bucket', /R2_BUCKET/],
      ['R2_ENDPOINT', 'http://r2.example', /R2_ENDPOINT/],
      ['R2_ENDPOINT', 'https://r2.example/path', /R2_ENDPOINT/],
    ]
    for (const [k, v, re] of bad) {
      let message = ''
      try {
        parseBackupStore({ ...r2, [k]: v }, '/d')
      } catch (e) {
        message = (e as Error).message
      }
      expect(message, `${k}=${v}`).toMatch(re)
      expect(message).not.toContain(v)
    }
    expect(parseBackupStore({ ...r2, R2_ENDPOINT: 'https://acc.r2.example:8443/' }, '/d')).toMatchObject({
      endpoint: 'https://acc.r2.example:8443',
    })
    expect(() => parseBackupStore({ DRAFTROOM_BACKUP_STORE: 's3' }, '/d')).toThrow(
      /DRAFTROOM_BACKUP_STORE must be off, fs or r2/,
    )
  })

  it('DRAFTROOM_BACKUP_INTERVAL_MS tunes the backup and retry interval (default 15 minutes)', () => {
    expect(loadConfig(base).backupIntervalMs).toBe(15 * 60_000)
    expect(loadConfig({ ...base, DRAFTROOM_BACKUP_INTERVAL_MS: '2000' }).backupIntervalMs).toBe(2_000)
    for (const v of ['999', 'abc', '86400001'])
      expect(() => loadConfig({ ...base, DRAFTROOM_BACKUP_INTERVAL_MS: v }), v).toThrow(
        /DRAFTROOM_BACKUP_INTERVAL_MS/,
      )
  })
})
