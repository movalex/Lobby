// CSD-4 (docs/SECURITY-REVIEW-2026-09-27.md, A6): Fastify's router-level errors (a malformed URL, a path
// parameter over its length limit) never reach the app's error handler, and their own body repeated the
// requester's URL. They now get the same generic `{ error: { code, message } }` body as every other
// refusal, with the same no-store and nosniff headers, and nothing the request sent comes back.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestApi, type TestApi } from './helpers.ts'

let api: TestApi
beforeEach(async () => {
  api = await createTestApi()
})
afterEach(() => api.close())

const MARKER = 'zzMARKERzz'

describe('router-level errors', () => {
  it('a malformed URL answers 400 with the generic body, and the URL is not echoed', async () => {
    for (const url of [
      `/api/%${MARKER}`,
      '/%',
      `/api/boards/b-x/%E0%A4%A-${MARKER}`,
      `/internal/%${MARKER}`,
    ]) {
      const res = await api.app.inject({ method: 'GET', url })
      expect({ url, status: res.statusCode }).toEqual({ url, status: 400 })
      expect(res.json()).toEqual({ error: { code: 'BAD_REQUEST', message: 'The request is not valid.' } })
      expect(res.body).not.toContain(MARKER)
      expect(res.body).not.toContain('FST_ERR')
      expect(res.headers['content-type']).toMatch(/^application\/json/)
      expect(res.headers['cache-control']).toBe('no-store')
      expect(res.headers['x-content-type-options']).toBe('nosniff')
    }
  })

  it('a path parameter over the length limit gets the same generic body (a 4xx, not the URL)', async () => {
    const res = await api.app.inject({ method: 'GET', url: `/api/boards/${MARKER}${'a'.repeat(400)}` })
    expect(res.statusCode).toBeGreaterThanOrEqual(400)
    expect(res.statusCode).toBeLessThan(500)
    expect(res.json()).toEqual({ error: { code: 'BAD_REQUEST', message: 'The request is not valid.' } })
    expect(res.body).not.toContain(MARKER)
    expect(res.body).not.toContain('FST_ERR')
  })

  it('does not change the other refusals: unknown routes are still the plain 404', async () => {
    const res = await api.app.inject({ method: 'GET', url: `/nope/${MARKER}` })
    expect(res.statusCode).toBe(404)
    expect(res.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Not found.' } })
  })
})
