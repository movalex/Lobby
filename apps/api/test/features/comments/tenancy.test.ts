// Tenant and access boundary for comments: people who cannot view a board (another workspace, or a
// private board in their own workspace) get 404 for every comments route, exactly like missing ids,
// and nothing is written or published.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Client } from '../../helpers.ts'
import { countRows, createThread, type Fixture, point, setup } from './fixture.ts'

let f: Fixture
let threadId: string
let commentId: string
let foreignThreadId: string
let foreignCommentId: string

beforeAll(async () => {
  f = await setup()
  const t = await createThread(f.commenter, f.boardId, 'secret feedback')
  threadId = t.id
  commentId = t.comments[0]?.id ?? ''
  const ft = await createThread(f.owner, f.foreignBoardId, 'another workspace')
  foreignThreadId = ft.id
  foreignCommentId = ft.comments[0]?.id ?? ''
})
afterAll(() => f.close())

const probes = (board: string, thread: string, comment: string) =>
  [
    ['list', 'GET', `/api/boards/${board}/threads`, undefined],
    ['create', 'POST', `/api/boards/${board}/threads`, { anchor: point(), body: 'x' }],
    ['reply', 'POST', `/api/threads/${thread}/comments`, { body: 'x' }],
    ['edit', 'PATCH', `/api/comments/${comment}`, { body: 'x' }],
    ['delete', 'DELETE', `/api/comments/${comment}`, undefined],
    ['resolve', 'POST', `/api/threads/${thread}/resolve`, undefined],
    ['reopen', 'POST', `/api/threads/${thread}/reopen`, undefined],
    ['read', 'POST', `/api/threads/${thread}/read`, undefined],
  ] as const

async function expectAll404(c: Client, board: string, thread: string, comment: string) {
  for (const [name, method, url, body] of probes(board, thread, comment)) {
    const res = await c.req(method, url, body)
    expect(res.statusCode, `${name}: ${res.body}`).toBe(404)
    expect(res.json().error.code, name).toBe('NOT_FOUND')
  }
}

describe('comments tenancy', () => {
  it('a user of another workspace gets 404 for everything on a foreign board', async () => {
    const before = [await countRows(f.api, 'comments'), await countRows(f.api, 'notifications')]
    await expectAll404(f.commenter, f.foreignBoardId, foreignThreadId, foreignCommentId)
    expect([await countRows(f.api, 'comments'), await countRows(f.api, 'notifications')]).toEqual(before)
  })

  it('a workspace member without access to a private board gets 404, not 403', async () => {
    await expectAll404(f.stranger, f.boardId, threadId, commentId)
  })

  it('answers exactly like ids that do not exist (no existence leak)', async () => {
    await expectAll404(f.commenter, 'b-0000000000', 'thr_00000000000000000000', 'cmt_00000000000000000000')
    await expectAll404(f.commenter, 'B-NOT-VALID', 'thr_bad', 'not-an-id')
  })

  it('signed-out requests are 401', async () => {
    for (const [name, method, url, body] of probes(f.boardId, threadId, commentId)) {
      const res = await f.api.anon(method, url, body)
      expect(res.statusCode, name).toBe(401)
    }
    expect((await f.api.anon('GET', '/api/me/notifications')).statusCode).toBe(401)
    expect((await f.api.anon('POST', '/api/me/notifications/read', { all: true })).statusCode).toBe(401)
  })

  it('cross-origin mutations are refused before any work is done', async () => {
    const res = await f.commenter.req(
      'POST',
      `/api/boards/${f.boardId}/threads`,
      { anchor: point(), body: 'csrf' },
      { origin: 'https://evil.example' },
    )
    expect(res.statusCode).toBe(403)
    expect(await countRows(f.api, 'comment_threads')).toBe(2)
  })

  it('an archived board is read-only for comments; a trashed board is invisible', async () => {
    const res = await f.owner.req('POST', `/api/boards/${f.boardId}/archive`)
    expect(res.statusCode, res.body).toBe(200)
    expect((await f.viewer.req('GET', `/api/boards/${f.boardId}/threads`)).statusCode).toBe(200)
    const post = await f.owner.req('POST', `/api/boards/${f.boardId}/threads`, { anchor: point(), body: 'x' })
    expect(post.statusCode).toBe(403)
    expect(
      (await f.commenter.req('POST', `/api/threads/${threadId}/comments`, { body: 'x' })).statusCode,
    ).toBe(403)
    await f.owner.req('POST', `/api/boards/${f.boardId}/restore`)
    await f.owner.req('POST', `/api/boards/${f.boardId}/trash`)
    expect((await f.owner.req('GET', `/api/boards/${f.boardId}/threads`)).statusCode).toBe(404)
    expect((await f.commenter.req('POST', `/api/threads/${threadId}/read`)).statusCode).toBe(404)
    await f.owner.req('POST', `/api/boards/${f.boardId}/restore`)
  })

  it('events for a board only go to that board', async () => {
    const own = f.events.filter((e) => e.boardId === f.boardId)
    const foreign = f.events.filter((e) => e.boardId === f.foreignBoardId)
    expect(
      own.every((e) => (e.data as { thread?: { boardId: string } }).thread?.boardId !== f.foreignBoardId),
    ).toBe(true)
    expect(foreign).toHaveLength(1)
  })
})
