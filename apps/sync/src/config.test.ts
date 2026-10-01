import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { backupSigningSecret, isAllowedOrigin, isLoopbackHost, loadConfig, parseTestHooks } from './config.ts'

const TICKET = 'test-ticket-secret-0123456789-0123456789'
const INTERNAL = 'test-internal-secret-0123456789-0123456789'
const base = {
  DRAFTROOM_DATA_DIR: './.data-test',
  DRAFTROOM_TICKET_SECRET: TICKET,
  DRAFTROOM_INTERNAL_SECRET: INTERNAL,
}
// What production additionally requires (Render: fromService hostport + the static site's origin).
const prodExtras = {
  DRAFTROOM_API_INTERNAL_URL: 'draftroom-staging-api:10000',
  ALLOWED_ORIGINS: 'https://draftroom-staging-web.onrender.com',
}
const prod = { ...base, ...prodExtras, NODE_ENV: 'production' }

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
    expect(loadConfig({ ...base, ...prodExtras, NODE_ENV: 'production' }).ticketSecret).toBe(TICKET)
  })

  it('refuses an unknown NODE_ENV (security audit M2): any value but production turned every guard off', () => {
    // before: NODE_ENV=staging booted with test hooks on and no Origin check, as if it were development
    for (const v of ['staging', 'prod', 'Production', 'dev'])
      expect(() => loadConfig({ ...base, NODE_ENV: v, DRAFTROOM_TEST_HOOKS: '1' })).toThrow(
        /NODE_ENV must be production, development or test/,
      )
    expect(() => loadConfig({ ...base, NODE_ENV: 'staging' })).toThrow(/"staging"/)
    expect(loadConfig(base).nodeEnv).toBe('development')
    expect(loadConfig({ ...base, NODE_ENV: '' }).nodeEnv).toBe('development')
    expect(loadConfig({ ...base, NODE_ENV: 'test' }).nodeEnv).toBe('test')
    expect(loadConfig(prod).nodeEnv).toBe('production')
    // the CLI entry points check it too
    expect(() => parseTestHooks({ NODE_ENV: 'staging', DRAFTROOM_TEST_HOOKS: '1' })).toThrow(/NODE_ENV must/)
    expect(() => backupSigningSecret({ NODE_ENV: 'staging', DRAFTROOM_INTERNAL_SECRET: INTERNAL })).toThrow(
      /NODE_ENV must/,
    )
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

describe('production: DRAFTROOM_API_INTERNAL_URL (docs/DEPLOY.md blocker 2)', () => {
  it('is required: the loopback default would make every access re-check fail (and fail open)', () => {
    for (const v of [undefined, '', ' '])
      expect(() => loadConfig({ ...prod, DRAFTROOM_API_INTERNAL_URL: v }), String(v)).toThrow(
        /DRAFTROOM_API_INTERNAL_URL is required when NODE_ENV=production/,
      )
    expect(loadConfig({ ...base, DRAFTROOM_API_INTERNAL_URL: '' }).apiInternalUrl).toBe(
      'http://127.0.0.1:5859',
    )
  })

  it('refuses loopback addresses in production (URL or host:port), allows them in development', () => {
    for (const v of [
      'http://127.0.0.1:5859',
      '127.0.0.1:10000',
      'http://127.1:5859',
      'http://localhost:5859',
      'localhost:10000',
      'http://api.localhost:5859',
      'http://[::1]:5859',
      '[::1]:10000',
      'http://[::ffff:127.0.0.1]:5859',
      'http://0.0.0.0:5859',
    ])
      expect(() => loadConfig({ ...prod, DRAFTROOM_API_INTERNAL_URL: v }), v).toThrow(
        /DRAFTROOM_API_INTERNAL_URL must not be a loopback address/,
      )
    expect(loadConfig({ ...base, DRAFTROOM_API_INTERNAL_URL: 'localhost:5859' }).apiInternalUrl).toBe(
      'http://localhost:5859',
    )
  })

  it('accepts Render hostport (host:port) and full URLs', () => {
    const url = (v: string) => loadConfig({ ...prod, DRAFTROOM_API_INTERNAL_URL: v }).apiInternalUrl
    expect(url('draftroom-staging-api:10000')).toBe('http://draftroom-staging-api:10000')
    expect(url('draftroom-staging-api-x9k2:10000')).toBe('http://draftroom-staging-api-x9k2:10000')
    expect(url('10.0.3.4:10000')).toBe('http://10.0.3.4:10000')
    expect(url('[fd00::4]:10000')).toBe('http://[fd00::4]:10000')
    expect(url('https://api.internal/')).toBe('https://api.internal')
    for (const bad of ['api:99999', 'api', 'api:', ':10000', 'http://api:10000/#x'])
      expect(() => loadConfig({ ...prod, DRAFTROOM_API_INTERNAL_URL: bad }), bad).toThrow(
        /DRAFTROOM_API_INTERNAL_URL/,
      )
  })

  it('isLoopbackHost only matches this-machine hosts', () => {
    for (const h of ['localhost', '127.0.0.1', '[::1]', '0.0.0.0', 'x.localhost', '[::ffff:7f00:1]'])
      expect(isLoopbackHost(h), h).toBe(true)
    for (const h of ['api', 'draftroom-staging-api', '10.0.0.1', '[fd00::1]', 'localhost.example'])
      expect(isLoopbackHost(h), h).toBe(false)
  })
})

describe('ALLOWED_ORIGINS (board WebSocket Origin allowlist)', () => {
  it('is required in production and must be https there', () => {
    for (const v of [undefined, '', ' , '])
      expect(() => loadConfig({ ...prod, ALLOWED_ORIGINS: v }), String(v)).toThrow(/ALLOWED_ORIGINS/)
    expect(() => loadConfig({ ...prod, ALLOWED_ORIGINS: 'http://draftroom.example' })).toThrow(
      /ALLOWED_ORIGINS entries must be https when NODE_ENV=production/,
    )
    expect(loadConfig(prod).allowedOrigins).toEqual(['https://draftroom-staging-web.onrender.com'])
  })

  it('is optional in development (null = no Origin check; the Vite proxy forwards any page)', () => {
    expect(loadConfig(base).allowedOrigins).toBeNull()
    expect(loadConfig({ ...base, ALLOWED_ORIGINS: 'http://127.0.0.1:5173' }).allowedOrigins).toEqual([
      'http://127.0.0.1:5173',
    ])
  })

  it('normalizes entries the way browsers serialize Origin, and de-duplicates them', () => {
    expect(
      loadConfig({
        ...prod,
        ALLOWED_ORIGINS:
          'https://Draftroom.Example/, https://draftroom.example:443 https://review.example:8443',
      }).allowedOrigins,
    ).toEqual(['https://draftroom.example', 'https://review.example:8443'])
  })

  it('rejects entries that are not bare origins', () => {
    for (const v of [
      'draftroom.example',
      '*',
      'https://draftroom.example/app',
      'https://draftroom.example?x=1',
      'https://draftroom.example#x',
      'https://u:p@draftroom.example',
      'ws://draftroom.example',
      'null',
    ])
      expect(() => loadConfig({ ...base, ALLOWED_ORIGINS: v }), v).toThrow(/ALLOWED_ORIGINS/)
  })

  it('isAllowedOrigin: exact match only; a missing or "null" Origin is refused once a list exists', () => {
    const list = ['https://draftroom.example']
    expect(isAllowedOrigin(list, 'https://draftroom.example')).toBe(true)
    for (const o of [
      undefined,
      '',
      'null',
      'https://evil.example',
      'https://draftroom.example.evil.example',
      'http://draftroom.example',
      'https://draftroom.example:8443',
      ['https://draftroom.example'],
    ])
      expect(isAllowedOrigin(list, o), String(o)).toBe(false)
    // No list (development): everything passes, including no Origin at all.
    for (const o of [undefined, 'https://anything.example']) {
      expect(isAllowedOrigin(null, o)).toBe(true)
      expect(isAllowedOrigin(undefined, o)).toBe(true)
    }
  })
})
