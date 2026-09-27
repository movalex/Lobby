import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from './config.ts'

const TICKET = 'test-ticket-secret-0123456789-0123456789'
const INTERNAL = 'test-internal-secret-0123456789-0123456789'
const base = {
  DRAFTROOM_DATA_DIR: './.data-test',
  DRAFTROOM_TICKET_SECRET: TICKET,
  DRAFTROOM_INTERNAL_SECRET: INTERNAL,
}

describe('loadConfig', () => {
  it('requires DRAFTROOM_DATA_DIR and resolves it to an absolute path', () => {
    const { DRAFTROOM_DATA_DIR: _, ...noDir } = base
    expect(() => loadConfig(noDir)).toThrow(/DRAFTROOM_DATA_DIR/)
    expect(loadConfig(base).dataDir).toBe(resolve('./.data-test'))
  })

  it('requires both secrets (>= 32 chars) and never echoes their values', () => {
    for (const name of ['DRAFTROOM_TICKET_SECRET', 'DRAFTROOM_INTERNAL_SECRET'] as const) {
      for (const v of [undefined, '', '   ', 'short-secret-31-chars-xxxxxxxxx']) {
        let message = ''
        try {
          loadConfig({ ...base, [name]: v })
        } catch (e) {
          message = (e as Error).message
        }
        expect(message, `${name}=${v}`).toMatch(new RegExp(name))
        if (v?.trim()) expect(message).not.toContain(v.trim())
      }
    }
    expect(loadConfig(base)).toMatchObject({ ticketSecret: TICKET, internalSecret: INTERNAL })
  })

  it('refuses one value for both secrets (whoever calls internal endpoints must not mint tickets)', () => {
    expect(() => loadConfig({ ...base, DRAFTROOM_INTERNAL_SECRET: TICKET })).toThrow(/must differ/)
  })

  it('refuses the dev placeholder secrets only when NODE_ENV=production', () => {
    const dev = {
      ...base,
      DRAFTROOM_TICKET_SECRET: 'dev-only-ticket-secret-change-me-0123456789',
      DRAFTROOM_INTERNAL_SECRET: 'dev-only-internal-secret-change-me-0123456789',
    }
    expect(loadConfig(dev).ticketSecret).toBe(dev.DRAFTROOM_TICKET_SECRET)
    expect(() => loadConfig({ ...dev, NODE_ENV: 'production' })).toThrow(
      /DRAFTROOM_TICKET_SECRET.*placeholder/,
    )
    expect(() => loadConfig({ ...dev, DRAFTROOM_TICKET_SECRET: TICKET, NODE_ENV: 'production' })).toThrow(
      /DRAFTROOM_INTERNAL_SECRET.*placeholder/,
    )
    expect(loadConfig({ ...base, NODE_ENV: 'production' }).ticketSecret).toBe(TICKET)
  })

  it('no longer reads DRAFTROOM_DEV_AUTH: identities come only from tickets', () => {
    const plain = loadConfig(base)
    expect(plain).not.toHaveProperty('devAuth')
    for (const v of [undefined, '1', '0', 'true'])
      expect(loadConfig({ ...base, DRAFTROOM_DEV_AUTH: v })).toEqual(plain)
  })

  it('applies the contract defaults (empty values count as unset)', () => {
    const expected = {
      host: '127.0.0.1',
      port: 5858,
      idleEvictMs: 30_000,
      textLeaseMs: 5_000,
      apiInternalUrl: 'http://127.0.0.1:5859',
      accessRecheckMs: 10_000,
    }
    expect(loadConfig(base)).toMatchObject(expected)
    expect(
      loadConfig({
        ...base,
        HOST: '',
        PORT: ' ',
        TEXT_LEASE_MS: '',
        DRAFTROOM_API_INTERNAL_URL: '',
        ACCESS_RECHECK_MS: '',
      }),
    ).toMatchObject(expected)
  })

  it('reads HOST, PORT (0 = ephemeral), IDLE_EVICT_MS, TEXT_LEASE_MS, ACCESS_RECHECK_MS and the API URL', () => {
    expect(
      loadConfig({
        ...base,
        HOST: '0.0.0.0',
        PORT: '0',
        IDLE_EVICT_MS: '250',
        TEXT_LEASE_MS: '1200',
        ACCESS_RECHECK_MS: '750',
        DRAFTROOM_API_INTERNAL_URL: 'https://api.internal:8443/base/',
      }),
    ).toMatchObject({
      host: '0.0.0.0',
      port: 0,
      idleEvictMs: 250,
      textLeaseMs: 1_200,
      accessRecheckMs: 750,
      apiInternalUrl: 'https://api.internal:8443/base', // no trailing slash: paths are appended
    })
  })

  it('rejects malformed or out-of-range numbers instead of silently using NaN', () => {
    for (const [k, v] of [
      ['PORT', 'abc'],
      ['PORT', '-1'],
      ['PORT', '65536'],
      ['PORT', '80.5'],
      ['IDLE_EVICT_MS', '1e3'],
      ['TEXT_LEASE_MS', '0'],
      ['TEXT_LEASE_MS', '-5'],
      ['ACCESS_RECHECK_MS', '0'],
      ['ACCESS_RECHECK_MS', '10s'],
    ] as const) {
      expect(() => loadConfig({ ...base, [k]: v }), `${k}=${v}`).toThrow(new RegExp(k))
    }
  })

  it('rejects an API URL that is not plain http(s)', () => {
    for (const v of [
      'not a url',
      'ftp://x',
      'http://127.0.0.1:5859/?x=1',
      'http://u:p@127.0.0.1:5859',
      'file:///x',
    ])
      expect(() => loadConfig({ ...base, DRAFTROOM_API_INTERNAL_URL: v }), v).toThrow(
        /DRAFTROOM_API_INTERNAL_URL/,
      )
  })
})
