// A separate backup bucket and token (SEAM-09): DRAFTROOM_BACKUP_R2_* take precedence over the shared
// R2_* values, so the owner can move offsite backups to a least-privilege bucket without a code change,
// and sync can then run without the api's token at all.
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { describeBackupStore, openBackupStore } from '../../src/backup/store.ts'
import { type BackupStoreConfig, parseBackupStore } from '../../src/config.ts'

const ACCOUNT = '0123456789abcdef0123456789abcdef'
const OTHER_ACCOUNT = 'fedcba9876543210fedcba9876543210'
const shared = {
  DRAFTROOM_BACKUP_STORE: 'r2',
  R2_ACCOUNT_ID: ACCOUNT,
  R2_ACCESS_KEY_ID: 'AKIASHAREDACCESSKEY01',
  R2_SECRET_ACCESS_KEY: 'sharedSecretAccessKey0123456789+/=',
  R2_BUCKET: 'draftroom-staging',
}
const backupOnly = {
  DRAFTROOM_BACKUP_R2_BUCKET: 'draftroom-staging-backups',
  DRAFTROOM_BACKUP_R2_ACCESS_KEY_ID: 'AKIABACKUPACCESSKEY01',
  DRAFTROOM_BACKUP_R2_SECRET_ACCESS_KEY: 'backupSecretAccessKey0123456789+/=',
}

function message(fn: () => unknown): string {
  try {
    fn()
  } catch (e) {
    return (e as Error).message
  }
  return ''
}

describe('DRAFTROOM_BACKUP_R2_*: a backup bucket and token of their own', () => {
  it('take precedence over the shared R2_* values', () => {
    expect(parseBackupStore({ ...shared, ...backupOnly }, '/d')).toEqual({
      kind: 'r2',
      accountId: ACCOUNT,
      accessKeyId: backupOnly.DRAFTROOM_BACKUP_R2_ACCESS_KEY_ID,
      secretAccessKey: backupOnly.DRAFTROOM_BACKUP_R2_SECRET_ACCESS_KEY,
      bucket: backupOnly.DRAFTROOM_BACKUP_R2_BUCKET,
      endpoint: null,
      dedicated: { bucket: true, credentials: true },
    })
  })

  it('let sync run without the api token at all (least privilege: no R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY or R2_BUCKET)', () => {
    const env = { DRAFTROOM_BACKUP_STORE: 'r2', R2_ACCOUNT_ID: ACCOUNT, ...backupOnly }
    expect(parseBackupStore(env, '/d')).toMatchObject({
      bucket: backupOnly.DRAFTROOM_BACKUP_R2_BUCKET,
      accessKeyId: backupOnly.DRAFTROOM_BACKUP_R2_ACCESS_KEY_ID,
      dedicated: { bucket: true, credentials: true },
    })
    // another Cloudflare account entirely: its own account id, and R2_ENDPOINT (the shared account's
    // jurisdiction) is not inherited
    const elsewhere = {
      DRAFTROOM_BACKUP_STORE: 'r2',
      ...backupOnly,
      DRAFTROOM_BACKUP_R2_ACCOUNT_ID: OTHER_ACCOUNT,
      R2_ACCOUNT_ID: ACCOUNT,
      R2_ENDPOINT: `https://${ACCOUNT}.eu.r2.cloudflarestorage.com`,
    }
    expect(parseBackupStore(elsewhere, '/d')).toMatchObject({ accountId: OTHER_ACCOUNT, endpoint: null })
    expect(
      parseBackupStore(
        {
          ...elsewhere,
          DRAFTROOM_BACKUP_R2_ENDPOINT: `https://${OTHER_ACCOUNT}.eu.r2.cloudflarestorage.com/`,
        },
        '/d',
      ),
    ).toMatchObject({ endpoint: `https://${OTHER_ACCOUNT}.eu.r2.cloudflarestorage.com` })
    // the same account keeps the shared endpoint
    expect(
      parseBackupStore({ ...shared, ...backupOnly, R2_ENDPOINT: 'https://acc.r2.example/' }, '/d'),
    ).toMatchObject({ endpoint: 'https://acc.r2.example' })
  })

  it('fall back one by one: a separate bucket with the shared token, or the shared bucket with a second token', () => {
    expect(
      parseBackupStore({ ...shared, DRAFTROOM_BACKUP_R2_BUCKET: 'draftroom-staging-backups' }, '/d'),
    ).toMatchObject({
      bucket: 'draftroom-staging-backups',
      accessKeyId: shared.R2_ACCESS_KEY_ID,
      dedicated: { bucket: true, credentials: false },
    })
    const { DRAFTROOM_BACKUP_R2_BUCKET: _, ...tokenOnly } = backupOnly
    expect(parseBackupStore({ ...shared, ...tokenOnly }, '/d')).toMatchObject({
      bucket: shared.R2_BUCKET,
      accessKeyId: backupOnly.DRAFTROOM_BACKUP_R2_ACCESS_KEY_ID,
      dedicated: { bucket: false, credentials: true },
    })
    // nothing backup-specific: exactly as before
    expect(parseBackupStore(shared, '/d')).toMatchObject({
      bucket: shared.R2_BUCKET,
      accessKeyId: shared.R2_ACCESS_KEY_ID,
      dedicated: { bucket: false, credentials: false },
    })
    // naming the shared bucket or token again is not "dedicated"
    expect(
      parseBackupStore(
        {
          ...shared,
          DRAFTROOM_BACKUP_R2_BUCKET: shared.R2_BUCKET,
          DRAFTROOM_BACKUP_R2_ACCESS_KEY_ID: shared.R2_ACCESS_KEY_ID,
          DRAFTROOM_BACKUP_R2_SECRET_ACCESS_KEY: shared.R2_SECRET_ACCESS_KEY,
        },
        '/d',
      ),
    ).toMatchObject({ dedicated: { bucket: false, credentials: false } })
  })

  it('never mix one half of the backup token with the other half of the shared one', () => {
    for (const half of [
      'DRAFTROOM_BACKUP_R2_ACCESS_KEY_ID',
      'DRAFTROOM_BACKUP_R2_SECRET_ACCESS_KEY',
    ] as const) {
      const m = message(() => parseBackupStore({ ...shared, [half]: backupOnly[half] }, '/d'))
      expect(m).toBe(
        'DRAFTROOM_BACKUP_R2_ACCESS_KEY_ID and DRAFTROOM_BACKUP_R2_SECRET_ACCESS_KEY must be set together',
      )
      expect(m).not.toContain(backupOnly[half])
    }
  })

  it('name the variable that is missing or malformed, never its value', () => {
    expect(message(() => parseBackupStore({ DRAFTROOM_BACKUP_STORE: 'r2', ...backupOnly }, '/d'))).toBe(
      'DRAFTROOM_BACKUP_STORE=r2 requires R2_ACCOUNT_ID (or DRAFTROOM_BACKUP_R2_ACCOUNT_ID)',
    )
    expect(message(() => parseBackupStore({ DRAFTROOM_BACKUP_STORE: 'r2' }, '/d'))).toBe(
      'DRAFTROOM_BACKUP_STORE=r2 requires R2_ACCOUNT_ID (or DRAFTROOM_BACKUP_R2_ACCOUNT_ID), ' +
        'R2_ACCESS_KEY_ID (or DRAFTROOM_BACKUP_R2_ACCESS_KEY_ID), ' +
        'R2_SECRET_ACCESS_KEY (or DRAFTROOM_BACKUP_R2_SECRET_ACCESS_KEY), R2_BUCKET (or DRAFTROOM_BACKUP_R2_BUCKET)',
    )
    const bad: Array<[string, string, string]> = [
      [
        'DRAFTROOM_BACKUP_R2_ACCOUNT_ID',
        'not-hex',
        'DRAFTROOM_BACKUP_R2_ACCOUNT_ID must be the 32-character hex account id',
      ],
      ['DRAFTROOM_BACKUP_R2_BUCKET', 'Bad_Bucket', 'DRAFTROOM_BACKUP_R2_BUCKET must be a valid bucket name'],
      [
        'DRAFTROOM_BACKUP_R2_ACCESS_KEY_ID',
        'has space in it 12345',
        'DRAFTROOM_BACKUP_R2_ACCESS_KEY_ID is malformed',
      ],
      [
        'DRAFTROOM_BACKUP_R2_SECRET_ACCESS_KEY',
        'quote"in-secret-0123456789',
        'DRAFTROOM_BACKUP_R2_SECRET_ACCESS_KEY is malformed',
      ],
      ['DRAFTROOM_BACKUP_R2_SECRET_ACCESS_KEY', backupOnly.DRAFTROOM_BACKUP_R2_ACCESS_KEY_ID, 'must differ'],
      [
        'DRAFTROOM_BACKUP_R2_ENDPOINT',
        'http://r2.example',
        'DRAFTROOM_BACKUP_R2_ENDPOINT must be an https origin',
      ],
    ]
    for (const [k, v, expected] of bad) {
      const m = message(() => parseBackupStore({ ...shared, ...backupOnly, [k]: v }, '/d'))
      expect(m, `${k}=${v}`).toContain(expected)
      expect(m).not.toContain(v)
    }
  })

  it('the startup line says which bucket and whose token, never a credential', () => {
    const line = (env: Record<string, string>) => describeBackupStore(parseBackupStore(env, '/d'))
    expect(line({ ...shared, ...backupOnly })).toBe(
      'r2 (bucket draftroom-staging-backups; backup-only bucket and token)',
    )
    expect(line({ ...shared, DRAFTROOM_BACKUP_R2_BUCKET: 'draftroom-staging-backups' })).toBe(
      'r2 (bucket draftroom-staging-backups; backup-only bucket, shared R2_* token)',
    )
    expect(line(shared)).toBe(
      'r2 (bucket draftroom-staging; shared with the api: R2_BUCKET and the R2_* token, see docs/DEPLOY.md "Backups")',
    )
    for (const env of [shared, { ...shared, ...backupOnly }])
      for (const v of Object.values(env).filter((x) => /Key|AKIA/.test(x))) expect(line(env)).not.toContain(v)
  })
})

describe('the store is opened with the backup bucket and token', () => {
  let server: Server
  afterEach(() => new Promise<void>((r) => server.close(() => r())))

  it('requests go to the backup bucket, signed with the backup key id', async () => {
    const seen: Array<{ path: string; auth: string }> = []
    server = createServer((req: IncomingMessage, res) => {
      seen.push({ path: req.url ?? '', auth: String(req.headers.authorization ?? '') })
      req.resume()
      req.on('end', () => {
        res.writeHead(200, { etag: '"x"' })
        res.end()
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const parsed = parseBackupStore({ ...shared, ...backupOnly }, '/d')
    if (parsed.kind !== 'r2') throw new Error('expected r2')
    // a loopback S3 stand-in (the config itself only accepts https endpoints)
    const config: BackupStoreConfig = {
      ...parsed,
      endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    }
    const store = openBackupStore(config)
    await store?.put('backups/sync/index.json', Buffer.from('{}'), {
      contentType: 'application/json',
      contentLength: 2,
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.path).toBe('/draftroom-staging-backups/backups/sync/index.json')
    expect(seen[0]?.auth).toContain(`Credential=${backupOnly.DRAFTROOM_BACKUP_R2_ACCESS_KEY_ID}/`)
    expect(seen[0]?.auth).not.toContain(shared.R2_ACCESS_KEY_ID)
  })
})
