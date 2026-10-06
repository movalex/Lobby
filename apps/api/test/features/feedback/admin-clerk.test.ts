// The inbox under the real sign-in provider's rules (wave J5): the address that opens it is a VERIFIED
// address from the Clerk profile, as stored by sign-in; an unverified one never is; and after 24 hours
// without a confirmation the person is confirmed with Clerk first (503 when it cannot be reached, and a
// removed address stops working). A fake Clerk Backend API stands in for the SDK, as in the domain-access
// tests.
import { FeedbackList, FeedbackSent } from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type ClerkWorld, clerkError, clerkUser, clerkWorld, fakeClerk } from '../domain-access/clerk-fake.ts'

vi.mock('@clerk/backend', async () => (await import('../domain-access/clerk-fake.ts')).clerkBackendModule)

const HOUR = 60 * 60 * 1000
const LEAD = 'lead@darkburn.com'

let w: ClerkWorld
beforeEach(async () => {
  fakeClerk.reset()
  w = await clerkWorld({ env: { DRAFTROOM_FEEDBACK_ADMINS: LEAD } })
})
afterEach(() => w.api.close())

const access = async (c: { req: (m: 'GET', u: string) => Promise<{ json(): unknown }> }) =>
  ((await c.req('GET', '/api/feedback/access')).json() as { admin: boolean }).admin

describe('feedback inbox readers with Clerk sign-in', () => {
  it('a verified address in the list opens the inbox; anybody else, a creator included, does not', async () => {
    clerkUser('user_lead', [LEAD])
    clerkUser('user_other', ['someone@darkburn.com'])
    const lead = await w.signIn('user_lead')
    const other = await w.signIn('user_other')
    const sent = await other.req('POST', '/api/feedback', { text: 'from a creator' })
    expect(sent.statusCode, sent.body).toBe(201)
    FeedbackSent.parse(sent.json())

    expect(await access(lead)).toBe(true)
    expect(await access(other)).toBe(false)
    expect(
      FeedbackList.parse((await lead.req('GET', '/api/feedback')).json()).items.map((i) => i.text),
    ).toEqual(['from a creator'])
    expect((await other.req('GET', '/api/feedback')).statusCode).toBe(404)
  })

  it('an address that is on the profile but not verified never counts', async () => {
    clerkUser('user_lead', [{ email: LEAD, status: 'unverified' }, 'real@client.example.test'])
    const lead = await w.signIn('user_lead')
    expect(await access(lead)).toBe(false)
    expect((await lead.req('GET', '/api/feedback')).statusCode).toBe(404)
  })

  it('after 24 hours the person is confirmed with Clerk first: unreachable is a 503 (closed), reachable opens it again', async () => {
    clerkUser('user_lead', [LEAD])
    const lead = await w.signIn('user_lead')
    expect(await access(lead)).toBe(true)

    w.api.clock.advance(25 * HOUR)
    fakeClerk.failures.set('user_lead', () => clerkError(500, 'internal_error'))
    fakeClerk.calls = []
    const closed = await lead.req('GET', '/api/feedback')
    expect(closed.statusCode).toBe(503)
    expect(closed.body).not.toContain('items')
    expect(fakeClerk.calls).toEqual(['user_lead'])

    fakeClerk.failures.clear()
    // a failed refresh backs off for a minute; after it the confirmation succeeds and the inbox opens
    w.api.clock.advance(2 * 60 * 1000)
    expect((await lead.req('GET', '/api/feedback')).statusCode).toBe(200)
  })

  it('an address removed from the Clerk profile stops opening the inbox at the next confirmation', async () => {
    clerkUser('user_lead', [LEAD])
    const lead = await w.signIn('user_lead')
    expect(await access(lead)).toBe(true)
    clerkUser('user_lead', ['someone-else@client.example.test'])
    w.api.clock.advance(25 * HOUR)
    expect((await lead.req('GET', '/api/feedback')).statusCode).toBe(404)
    expect(await access(lead)).toBe(false)
  })

  it('a person who is not listed never makes the api call Clerk', async () => {
    clerkUser('user_other', ['someone@darkburn.com'])
    const other = await w.signIn('user_other')
    w.api.clock.advance(25 * HOUR)
    fakeClerk.calls = []
    expect(await access(other)).toBe(false)
    expect((await other.req('GET', '/api/feedback')).statusCode).toBe(404)
    await w.api.identity.settled()
    expect(fakeClerk.calls).toEqual([])
  })
})
