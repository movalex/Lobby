// A11Y-17 (shell-2): GET /api/auth/me, the web app's session check on page load. Signed out is 204
// (no error in the browser console on the sign-in page); signed in it is /api/me's body.
import { Me } from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestApi, type TestApi } from './helpers.ts'

let api: TestApi
beforeEach(async () => {
  api = await createTestApi()
})
afterEach(() => api.close())

describe('GET /api/auth/me', () => {
  it('answers 204 with no body when signed out, and /api/me stays 401', async () => {
    const res = await api.anon('GET', '/api/auth/me')
    expect(res.statusCode).toBe(204)
    expect(res.body).toBe('')
    expect((await api.anon('GET', '/api/me')).statusCode).toBe(401)
  })

  it('answers what /api/me answers when signed in', async () => {
    const alice = await api.login('alice')
    const probe = await alice.req('GET', '/api/auth/me')
    expect(probe.statusCode).toBe(200)
    const me = await alice.req('GET', '/api/me')
    expect(Me.parse(probe.json())).toEqual(Me.parse(me.json()))
    expect(probe.json()).toMatchObject({ kind: 'account' })
  })

  it('is 204 again after logout (a revoked session reads as signed out)', async () => {
    const alice = await api.login('alice')
    expect((await alice.req('POST', '/api/auth/logout')).statusCode).toBe(204)
    expect((await alice.req('GET', '/api/auth/me')).statusCode).toBe(204)
  })
})
