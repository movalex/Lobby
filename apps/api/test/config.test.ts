import { describe, expect, it } from 'vitest'
import { createApiServer } from '../src/app.ts'
import { createDevAuthProvider } from '../src/auth/dev.ts'
import { loadConfig } from '../src/config.ts'
import { testEnv } from './helpers.ts'

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
}

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
    })
    expect(c.pgliteDir.endsWith('pg')).toBe(true)
  })

  it('accepts a production config with real secrets and Clerk', () => {
    const c = loadConfig({ ...base, ...prodSecrets })
    expect(c).toMatchObject({ production: true, devAuth: false, authProvider: 'clerk' })
    expect(c.clerk).toEqual({ secretKey: 'sk_live_x', publishableKey: 'pk_live_x' })
  })

  it('refuses development secrets in production', () => {
    for (const name of ['DRAFTROOM_TICKET_SECRET', 'DRAFTROOM_INTERNAL_SECRET']) {
      expect(
        () => loadConfig({ ...base, ...prodSecrets, [name]: 'dev-only-ticket-secret-change-me-0123456789' }),
        name,
      ).toThrow(/development placeholder/)
    }
  })

  it('refuses dev sign-in in production', () => {
    expect(() => loadConfig({ ...base, ...prodSecrets, DRAFTROOM_DEV_AUTH: '1' })).toThrow(
      /refused when NODE_ENV=production/,
    )
    expect(() => loadConfig({ ...base, ...prodSecrets, AUTH_PROVIDER: 'dev' })).toThrow(
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
    expect(() => loadConfig({ ...base, ...prodSecrets, PUBLIC_ORIGIN: 'http://draftroom.example' })).toThrow(
      /https/,
    )
    expect(() => loadConfig({ ...base, DRAFTROOM_SYNC_INTERNAL_URL: 'not a url' })).toThrow(/absolute/)
    expect(() => loadConfig({ ...base, PORT: '70000' })).toThrow(/PORT/)
    expect(() => loadConfig({ ...base, PORT: 'abc' })).toThrow(/PORT/)
    expect(() => loadConfig({ ...base, DRAFTROOM_DATA_DIR: '' })).toThrow(/DRAFTROOM_DATA_DIR/)
    expect(loadConfig({ ...base, PUBLIC_ORIGIN: 'https://Draftroom.Example/' }).publicOrigin).toBe(
      'https://draftroom.example',
    )
  })

  it('createApiServer refuses a dev provider without the guard (defense in depth)', async () => {
    const prod = loadConfig({ ...base, ...prodSecrets })
    await expect(createApiServer(prod, { authProvider: createDevAuthProvider() })).rejects.toThrow(
      /dev sign-in requires DRAFTROOM_DEV_AUTH=1/,
    )
  })
})
