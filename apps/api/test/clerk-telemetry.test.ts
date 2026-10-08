// K6-2: every Clerk Backend API client this api builds has Clerk's SDK telemetry off, in code (not only a
// deploy setting): no telemetry notice in the api's log, nothing for clerk-telemetry.com. The real
// createClerkClient builds the clients here (it makes no request by itself); only the calls the clients would
// send to Clerk (users.getUser, users.getUserList) are faked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const built = vi.hoisted(() => ({ options: [] as unknown[], clients: [] as { telemetry: unknown }[] }))

vi.mock('@clerk/backend', async (importOriginal) => {
  const real = await importOriginal<typeof import('@clerk/backend')>()
  return {
    ...real,
    createClerkClient: (options: Parameters<typeof real.createClerkClient>[0]) => {
      built.options.push(options)
      const client = real.createClerkClient(options)
      built.clients.push(client)
      // what the api calls on a client, answered without Clerk
      return {
        ...client,
        telemetry: client.telemetry,
        users: {
          getUser: async () => ({
            fullName: 'Pat Example',
            username: null,
            imageUrl: '',
            primaryEmailAddress: null,
            primaryEmailAddressId: null,
            emailAddresses: [],
            banned: false,
            locked: false,
          }),
          getUserList: async () => ({ data: [], totalCount: 0 }),
        },
      }
    },
  }
})

import { defaultDeps } from '../src/auth/clerk.ts'
import { clerkClientOptions } from '../src/auth/clerk-options.ts'
import { createClerkDirectory } from '../src/features/dashboard/clerk-directory.ts'

/** A publishable key of a DEVELOPMENT instance (pk_test_): the kind whose telemetry Clerk turns on. */
const DEV_PUBLISHABLE_KEY = `pk_test_${Buffer.from('example-dev.clerk.accounts.dev$').toString('base64')}`
const KEYS = { secretKey: 'sk_test_0123456789abcdefghij', publishableKey: DEV_PUBLISHABLE_KEY }
const NOTICE = /collects telemetry/i

const isEnabled = (client: { telemetry: unknown } | undefined) =>
  (client?.telemetry as { isEnabled?: boolean } | undefined)?.isEnabled

beforeEach(() => {
  built.options = []
  built.clients = []
  vi.stubEnv('CLERK_TELEMETRY_DISABLED', '')
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('K6-2: the api builds its Clerk clients with telemetry off', () => {
  it('clerkClientOptions carries telemetry: { disabled: true } and the keys', () => {
    expect(clerkClientOptions(KEYS)).toEqual({ ...KEYS, telemetry: { disabled: true } })
  })

  it('the sign-in profile client: built with those options; its collector is off; no notice is printed', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const deps = defaultDeps({ ...KEYS, publicOrigin: 'http://127.0.0.1:5173' })
    const profile = await deps.profile('user_123')
    expect(profile.name).toBe('Pat Example')
    expect(built.options).toEqual([{ ...KEYS, telemetry: { disabled: true } }])
    expect(isEnabled(built.clients[0])).toBe(false)
    expect(log.mock.calls.flat().join('\n')).not.toMatch(NOTICE)
  })

  it('the invite-by-email directory client: the same', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(await createClerkDirectory(KEYS).verifiedUserIds('pat@example.com')).toEqual([])
    expect(built.options).toEqual([{ ...KEYS, telemetry: { disabled: true } }])
    expect(isEnabled(built.clients[0])).toBe(false)
    expect(log.mock.calls.flat().join('\n')).not.toMatch(NOTICE)
  })

  it('control: the same SDK, without the option, would collect telemetry for this development instance', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { createClerkClient } = await import('@clerk/backend')
    createClerkClient(KEYS)
    expect(isEnabled(built.clients[0])).toBe(true)
  })
})
