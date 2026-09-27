import { afterEach, describe, expect, it } from 'vitest'
import { createApiServer } from '../src/app.ts'
import { createDevAuthProvider } from '../src/auth/dev.ts'
import { isLoopbackHost, loadConfig, parseTrustProxy } from '../src/config.ts'
import { createTestApi, ORIGIN, type TestApi, testEnv } from './helpers.ts'

const base = testEnv('./.data-test-never-created')
const prodSecrets = {
  NODE_ENV: 'production',
  DRAFTROOM_DEV_AUTH: '',
  AUTH_PROVIDER: 'clerk',
  CLERK_SECRET_KEY: 'sk_live_x',
  CLERK_PUBLISHABLE_KEY: 'pk_live_x',
  PUBLIC_ORIGIN: 'https://draftroom.example',
  DRAFTROOM_TICKET_SECRET: 'prod-ticket-secret-0123456789abcdefghijkl',
  DRAFTROOM_INTERNAL_SECRET: 'prod-internal-secret-0123456789abcdefghij',
  // Render Blueprint: fromService.property hostport
  DRAFTROOM_SYNC_INTERNAL_URL: 'draftroom-staging-sync:10000',
}
const prod = { ...base, ...prodSecrets }

describe('loadConfig', () => {
  it('reads the development environment with contract defaults', () => {
    const c = loadConfig({ ...base, PUBLIC_ORIGIN: '', PORT: '' })
    expect(c).toMatchObject({
      production: false,
      host: '127.0.0.1',
      port: 5859,
      devAuth: true,
      authProvider: 'dev',
      clerk: null,
      publicOrigin: 'http://127.0.0.1:5173',
      syncInternalUrl: 'http://127.0.0.1:5858',
      databaseUrl: null,
      trustProxy: false,
    })
    expect(c.pgliteDir.endsWith('pg')).toBe(true)
  })

  it('accepts a production config with real secrets and Clerk', () => {
    const c = loadConfig(prod)
    expect(c).toMatchObject({ production: true, devAuth: false, authProvider: 'clerk', trustProxy: false })
    expect(c.clerk).toEqual({ secretKey: 'sk_live_x', publishableKey: 'pk_live_x' })
    expect(c.syncInternalUrl).toBe('http://draftroom-staging-sync:10000')
  })

  it('refuses development secrets in production', () => {
    for (const name of ['DRAFTROOM_TICKET_SECRET', 'DRAFTROOM_INTERNAL_SECRET']) {
      expect(
        () => loadConfig({ ...prod, [name]: 'dev-only-ticket-secret-change-me-0123456789' }),
        name,
      ).toThrow(/development placeholder/)
    }
  })

  it('refuses dev sign-in in production', () => {
    expect(() => loadConfig({ ...prod, DRAFTROOM_DEV_AUTH: '1' })).toThrow(/refused when NODE_ENV=production/)
    expect(() => loadConfig({ ...prod, AUTH_PROVIDER: 'dev' })).toThrow(
      /AUTH_PROVIDER=dev is refused when NODE_ENV=production/,
    )
  })

  it('dev sign-in needs the explicit DRAFTROOM_DEV_AUTH=1 guard', () => {
    expect(() => loadConfig({ ...base, DRAFTROOM_DEV_AUTH: '' })).toThrow(/requires DRAFTROOM_DEV_AUTH=1/)
    expect(() => loadConfig({ ...base, DRAFTROOM_DEV_AUTH: 'true' })).toThrow(/must be 1/)
    // Without the guard and without AUTH_PROVIDER, the default is clerk, which then needs keys.
    expect(() => loadConfig({ ...base, DRAFTROOM_DEV_AUTH: '', AUTH_PROVIDER: '' })).toThrow(
      /CLERK_SECRET_KEY/,
    )
  })

  it('refuses short, missing or identical secrets', () => {
    expect(() => loadConfig({ ...base, DRAFTROOM_TICKET_SECRET: 'short' })).toThrow(/at least 32/)
    expect(() => loadConfig({ ...base, DRAFTROOM_INTERNAL_SECRET: '' })).toThrow(/at least 32/)
    expect(() =>
      loadConfig({ ...base, DRAFTROOM_INTERNAL_SECRET: base.DRAFTROOM_TICKET_SECRET ?? '' }),
    ).toThrow(/must differ/)
  })

  it('validates origin, URLs, port and data dir', () => {
    expect(() => loadConfig({ ...base, PUBLIC_ORIGIN: 'http://127.0.0.1:5173/app' })).toThrow(/origin only/)
    expect(() => loadConfig({ ...base, PUBLIC_ORIGIN: 'ftp://x' })).toThrow(/http/)
    expect(() => loadConfig({ ...prod, PUBLIC_ORIGIN: 'http://draftroom.example' })).toThrow(/https/)
    expect(() => loadConfig({ ...base, DRAFTROOM_SYNC_INTERNAL_URL: 'not a url' })).toThrow(/absolute/)
    expect(() => loadConfig({ ...base, PORT: '70000' })).toThrow(/PORT/)
    expect(() => loadConfig({ ...base, PORT: 'abc' })).toThrow(/PORT/)
    expect(() => loadConfig({ ...base, DRAFTROOM_DATA_DIR: '' })).toThrow(/DRAFTROOM_DATA_DIR/)
    expect(loadConfig({ ...base, PUBLIC_ORIGIN: 'https://Draftroom.Example/' }).publicOrigin).toBe(
      'https://draftroom.example',
    )
  })

  it('createApiServer refuses a dev provider without the guard (defense in depth)', async () => {
    await expect(
      createApiServer(loadConfig(prod), { authProvider: createDevAuthProvider() }),
    ).rejects.toThrow(/dev sign-in requires DRAFTROOM_DEV_AUTH=1/)
  })
})

describe('production requires explicit deployment addresses (docs/DEPLOY.md blockers 1-2)', () => {
  it('requires PUBLIC_ORIGIN: the local default would 403 every mutation and write loopback invite links', () => {
    for (const v of [undefined, '', '  '])
      expect(() => loadConfig({ ...prod, PUBLIC_ORIGIN: v }), String(v)).toThrow(
        /PUBLIC_ORIGIN is required when NODE_ENV=production/,
      )
    // Outside production the contract default stays.
    expect(loadConfig({ ...base, PUBLIC_ORIGIN: '' }).publicOrigin).toBe('http://127.0.0.1:5173')
  })

  it('requires DRAFTROOM_SYNC_INTERNAL_URL instead of defaulting to 127.0.0.1', () => {
    for (const v of [undefined, ''])
      expect(() => loadConfig({ ...prod, DRAFTROOM_SYNC_INTERNAL_URL: v }), String(v)).toThrow(
        /DRAFTROOM_SYNC_INTERNAL_URL is required when NODE_ENV=production/,
      )
  })

  it('refuses every spelling of a loopback sync address in production, in URL or host:port form', () => {
    for (const v of [
      'http://127.0.0.1:5858',
      '127.0.0.1:5858',
      'http://127.1:5858',
      'http://2130706433:5858',
      'http://127.8.9.10:5858',
      'http://localhost:5858',
      'localhost:5858',
      'http://LOCALHOST.:5858',
      'http://sync.localhost:5858',
      'http://[::1]:5858',
      '[::1]:5858',
      'http://[0:0:0:0:0:0:0:1]:5858',
      'http://[::ffff:127.0.0.1]:5858',
      'http://0.0.0.0:5858',
      'http://[::]:5858',
    ])
      expect(() => loadConfig({ ...prod, DRAFTROOM_SYNC_INTERNAL_URL: v }), v).toThrow(
        /DRAFTROOM_SYNC_INTERNAL_URL must not be a loopback address/,
      )
    // ...but a loopback address is fine (and the default) in development.
    expect(loadConfig({ ...base, DRAFTROOM_SYNC_INTERNAL_URL: '127.0.0.1:5999' }).syncInternalUrl).toBe(
      'http://127.0.0.1:5999',
    )
  })

  it('accepts host:port (Render hostport) and full URLs, and builds the base URL', () => {
    const url = (v: string) => loadConfig({ ...prod, DRAFTROOM_SYNC_INTERNAL_URL: v }).syncInternalUrl
    expect(url('draftroom-staging-sync:10000')).toBe('http://draftroom-staging-sync:10000')
    expect(url('draftroom-staging-sync-a1b2:10000')).toBe('http://draftroom-staging-sync-a1b2:10000')
    expect(url('10.0.4.7:10000')).toBe('http://10.0.4.7:10000')
    expect(url('[fd00::7]:10000')).toBe('http://[fd00::7]:10000')
    expect(url('http://sync:10000/')).toBe('http://sync:10000')
    expect(url('https://sync.internal:8443/base/')).toBe('https://sync.internal:8443/base')
    expect(url('Sync.Internal:80')).toBe('http://sync.internal')
  })

  it('rejects internal URLs with credentials, query, fragment, another scheme or a bad port', () => {
    for (const v of [
      'http://u:p@sync:10000',
      'http://sync:10000/?x=1',
      'http://sync:10000/#x',
      'ftp://sync:21',
      'sync:99999',
      'sync',
      'sync:',
      ':10000',
    ])
      expect(() => loadConfig({ ...prod, DRAFTROOM_SYNC_INTERNAL_URL: v }), v).toThrow(
        /DRAFTROOM_SYNC_INTERNAL_URL/,
      )
  })

  it('isLoopbackHost only matches this-machine hosts', () => {
    for (const h of ['localhost', '127.0.0.1', '[::1]', '0.0.0.0', 'a.localhost', '[::ffff:7f00:1]'])
      expect(isLoopbackHost(h), h).toBe(true)
    for (const h of [
      'sync',
      'draftroom-staging-sync',
      '10.0.0.1',
      '[fd00::1]',
      'localhost.example',
      '128.0.0.1',
    ])
      expect(isLoopbackHost(h), h).toBe(false)
  })
})

describe('TRUST_PROXY', () => {
  it('parses false / true / a hop count / an address list, and refuses anything else', () => {
    for (const v of [undefined, '', ' ', 'false', 'FALSE', '0'])
      expect(parseTrustProxy(v), String(v)).toBe(false)
    expect(parseTrustProxy('true')).toBe(true)
    expect(parseTrustProxy(' True ')).toBe(true)
    expect(parseTrustProxy('uniquelocal, 172.64.0.0/13,2606:4700::/32 , 203.0.113.9')).toEqual([
      'uniquelocal',
      '172.64.0.0/13',
      '2606:4700::/32',
      '203.0.113.9',
    ])
    const hops = parseTrustProxy('3')
    expect(typeof hops).toBe('function')
    if (typeof hops !== 'function') return
    // Trusts the socket peer (hop 0) and the next two X-Forwarded-For entries; the 4th address is the client.
    expect([0, 1, 2, 3, 4].map((i) => hops('10.0.0.1', i))).toEqual([true, true, true, false, false])
    for (const bad of [
      'yes',
      '11',
      '-1',
      '1.5',
      '10.0.0.0/33',
      '::1/129',
      'example.com',
      'a,b',
      ',',
      '10.0.0.1/8/1',
    ])
      expect(() => parseTrustProxy(bad), bad).toThrow(/TRUST_PROXY/)
  })

  it('loadConfig passes the parsed value through (default false)', () => {
    expect(loadConfig(base).trustProxy).toBe(false)
    expect(loadConfig({ ...prod, TRUST_PROXY: 'loopback,uniquelocal' }).trustProxy).toEqual([
      'loopback',
      'uniquelocal',
    ])
    expect(() => loadConfig({ ...prod, TRUST_PROXY: 'maybe' })).toThrow(/TRUST_PROXY/)
  })
})

// Behavior, not parsing: the sign-in rate limit (per IP) must key on the real client behind the proxies.
describe('TRUST_PROXY decides which client a per-IP rate limit sees', () => {
  let api: TestApi | null = null
  afterEach(async () => {
    await api?.close()
    api = null
  })

  const LB = '10.26.0.9' // the socket peer: the platform's last proxy hop
  const login = (xff: string | null, handle: string) => {
    if (!api) throw new Error('start() first')
    return api.app.inject({
      method: 'POST',
      url: '/api/auth/dev/login',
      payload: { handle },
      remoteAddress: LB,
      headers: { origin: ORIGIN, ...(xff === null ? {} : { 'x-forwarded-for': xff }) },
    })
  }
  const status = async (xff: string | null, handle: string) => (await login(xff, handle)).statusCode
  const start = async (env: Record<string, string>) => {
    api = await createTestApi({ env, deps: { authRateLimit: { max: 2, timeWindow: 60_000 } } })
  }

  it('unset: X-Forwarded-For is ignored, so everyone behind the proxy shares one bucket', async () => {
    await start({})
    expect(await status('203.0.113.1, 172.71.0.1', 'a1')).toBe(200)
    expect(await status('203.0.113.1, 172.71.0.1', 'a2')).toBe(200)
    // A different client (and a client inventing a new address) still lands in the proxy's bucket.
    expect(await status('198.51.100.7, 172.71.0.2', 'b1')).toBe(429)
    expect(await status('192.0.2.1', 'c1')).toBe(429)
  })

  it('a hop count keys on the real client, and client-written entries cannot escape the bucket', async () => {
    await start({ TRUST_PROXY: '2' }) // socket peer = LB, then the edge's entry, then the client's
    expect(await status('203.0.113.1, 172.71.0.1', 'a1')).toBe(200)
    expect(await status('203.0.113.1, 172.71.0.1', 'a2')).toBe(200)
    expect(await status('203.0.113.1, 172.71.0.1', 'a3')).toBe(429)
    // Another client has its own bucket.
    expect(await status('198.51.100.7, 172.68.0.2', 'b1')).toBe(200)
    // Client A prepends fake addresses: the proxies append (they keep them), so A is still A.
    expect(await status('192.0.2.55, 203.0.113.1, 172.71.0.1', 'a4')).toBe(429)
    expect(await status('192.0.2.55,192.0.2.56, 203.0.113.1, 172.71.0.1', 'a5')).toBe(429)
  })

  it('an address list trusts only those proxies: the first untrusted address is the client', async () => {
    await start({ TRUST_PROXY: 'uniquelocal,172.64.0.0/13' })
    expect(await status('203.0.113.1, 172.71.0.1', 'a1')).toBe(200)
    expect(await status('192.0.2.55, 203.0.113.1, 172.71.0.1', 'a2')).toBe(200)
    expect(await status('203.0.113.1, 172.68.9.9', 'a3')).toBe(429)
    expect(await status('198.51.100.7, 172.71.0.2', 'b1')).toBe(200)
  })

  it('true trusts every entry (documented as spoofable behind appending proxies such as Render)', async () => {
    await start({ TRUST_PROXY: 'true' })
    expect(await status('192.0.2.1, 172.71.0.1', 'x1')).toBe(200)
    expect(await status('192.0.2.1, 172.71.0.1', 'x2')).toBe(200)
    expect(await status('192.0.2.1, 172.71.0.1', 'x3')).toBe(429)
    // The leftmost (client-written) entry decides: a newly invented address gets a fresh bucket.
    expect(await status('192.0.2.2, 172.71.0.1', 'x4')).toBe(200)
  })
})
