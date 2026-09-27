// The API core's `authorize` for the file routes (apps/api/src/files/deps.ts): 401 without a session,
// 404 when the caller cannot view the board, 403 when they can view but not edit.

import type { FastifyRequest } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSessionStore } from '../src/auth/session.ts'
import type { FilesDeps } from '../src/files/deps.ts'
import { createFileAuthorizer } from '../src/files-auth.ts'
import { type Client, createBoard, createTestApi, DEV_STUDIO, type TestApi } from './helpers.ts'

let api: TestApi
let bob: Client
let carol: Client
let boardId: string
let authorize: FilesDeps['authorize']

const reqWith = (c: Client | null) =>
  ({ cookies: c ? { dr_session: c.cookie.split('=')[1] } : {} }) as unknown as FastifyRequest

beforeEach(async () => {
  api = await createTestApi()
  await api.login('alice')
  bob = await api.login('bob')
  carol = await api.login('carol')
  boardId = await createBoard(bob, DEV_STUDIO)
  authorize = createFileAuthorizer(
    api.db,
    createSessionStore({ db: api.db, secureCookies: false, now: () => new Date() }),
  )
})
afterEach(() => api.close())

describe('file route authorization', () => {
  it('401 without a session', async () => {
    expect(await authorize(reqWith(null), boardId, 'view')).toEqual({ ok: false, status: 401 })
  })

  it('404 without view access, for unknown and malformed board ids', async () => {
    expect(await authorize(reqWith(carol), boardId, 'view')).toEqual({ ok: false, status: 404 })
    expect(await authorize(reqWith(carol), boardId, 'edit')).toEqual({ ok: false, status: 404 })
    expect(await authorize(reqWith(bob), 'b-0000000000', 'view')).toEqual({ ok: false, status: 404 })
    expect(await authorize(reqWith(bob), '../etc', 'view')).toEqual({ ok: false, status: 404 })
  })

  it('403 for view-only roles asking to edit; ok with the session user id otherwise', async () => {
    for (const role of ['viewer', 'commenter'] as const) {
      await bob.req('PUT', `/api/boards/${boardId}/members/${carol.userId}`, { role })
      expect(await authorize(reqWith(carol), boardId, 'view'), role).toEqual({
        ok: true,
        userId: carol.userId,
      })
      expect(await authorize(reqWith(carol), boardId, 'edit'), role).toEqual({ ok: false, status: 403 })
    }
    await bob.req('PUT', `/api/boards/${boardId}/members/${carol.userId}`, { role: 'editor' })
    expect(await authorize(reqWith(carol), boardId, 'edit')).toEqual({ ok: true, userId: carol.userId })
  })

  it('archived boards are view-only; trashed boards serve nothing, even to owners', async () => {
    await bob.req('POST', `/api/boards/${boardId}/archive`)
    expect(await authorize(reqWith(bob), boardId, 'view')).toEqual({ ok: true, userId: bob.userId })
    expect(await authorize(reqWith(bob), boardId, 'edit')).toEqual({ ok: false, status: 403 })
    await bob.req('POST', `/api/boards/${boardId}/trash`)
    expect(await authorize(reqWith(bob), boardId, 'view')).toEqual({ ok: false, status: 404 })
  })

  it('is what the mounted file routes use (upload: 401 / 404 / 403 through the real plugin)', async () => {
    const upload = (c: Client | null) =>
      api.app.inject({
        method: 'POST',
        url: `/api/boards/${boardId}/assets`,
        payload: Buffer.from('hello'),
        headers: {
          origin: 'http://127.0.0.1:5173',
          'content-type': 'text/plain',
          'x-file-name': 'a.txt',
          ...(c ? { cookie: c.cookie } : {}),
        },
      })
    expect((await upload(null)).statusCode).toBe(401)
    expect((await upload(carol)).statusCode).toBe(404)
    await bob.req('PUT', `/api/boards/${boardId}/members/${carol.userId}`, { role: 'viewer' })
    expect((await upload(carol)).statusCode).toBe(403)
    // The Origin check covers the upload too.
    const noOrigin = await api.app.inject({
      method: 'POST',
      url: `/api/boards/${boardId}/assets`,
      payload: Buffer.from('hello'),
      headers: { 'content-type': 'text/plain', cookie: bob.cookie },
    })
    expect(noOrigin.statusCode).toBe(403)
  })
})
