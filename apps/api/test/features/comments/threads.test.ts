// Comment threads: create/list/reply/edit/delete/resolve/reopen/read, with the role rules enforced
// server-side ('comment' to write, 'view' to read, author-only edits, author-or-owner deletes).

import { ListThreadsResponse, ThreadResponse } from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { countRows, createThread, type Fixture, onShape, point, reply, setup } from './fixture.ts'

let f: Fixture
beforeEach(async () => {
  f = await setup()
})
afterEach(() => f.close())

const list = async (c: Fixture['owner'], query = '') => {
  const res = await c.req('GET', `/api/boards/${f.boardId}/threads${query}`)
  expect(res.statusCode, res.body).toBe(200)
  return ListThreadsResponse.parse(res.json())
}

describe('creating threads', () => {
  it('a commenter creates a point thread; authorship comes from the session', async () => {
    const res = await f.commenter.req('POST', `/api/boards/${f.boardId}/threads`, {
      anchor: point(120.5, -40),
      body: '  Can we try a warmer palette?\r\nMaybe amber.  ',
    })
    expect(res.statusCode, res.body).toBe(201)
    const { thread } = ThreadResponse.parse(res.json())
    expect(thread).toMatchObject({
      boardId: f.boardId,
      anchor: { kind: 'point', x: 120.5, y: -40 },
      status: 'open',
      createdBy: { id: f.commenter.userId, name: 'Carol Commenter' },
      resolvedBy: null,
    })
    expect(thread.comments).toHaveLength(1)
    expect(thread.comments[0]).toMatchObject({
      author: { id: f.commenter.userId },
      body: 'Can we try a warmer palette?\nMaybe amber.',
      editedAt: null,
      mentions: [],
    })
    expect(thread.id).toMatch(/^thr_/)
    expect(thread.comments[0]?.id).toMatch(/^cmt_/)
  })

  it('refuses a body that tries to set its own author (strict input) and writes nothing', async () => {
    const res = await f.commenter.req('POST', `/api/boards/${f.boardId}/threads`, {
      anchor: point(),
      body: 'hi',
      authorId: f.owner.userId,
    })
    expect(res.statusCode).toBe(400)
    expect(await countRows(f.api, 'comment_threads')).toBe(0)
  })

  it('a viewer cannot post (403) and nothing is written or published', async () => {
    const res = await f.viewer.req('POST', `/api/boards/${f.boardId}/threads`, {
      anchor: point(),
      body: 'hi',
    })
    expect(res.statusCode).toBe(403)
    expect(res.json().error.code).toBe('FORBIDDEN')
    expect(await countRows(f.api, 'comment_threads')).toBe(0)
    expect(await countRows(f.api, 'comments')).toBe(0)
    expect(f.events).toHaveLength(0)
    // …but can read threads others post.
    await createThread(f.commenter, f.boardId)
    expect((await list(f.viewer)).threads).toHaveLength(1)
  })

  it('a commenter comments while their canvas connection is read-only', async () => {
    const ticket = await f.commenter.req('POST', `/api/boards/${f.boardId}/ticket`)
    expect(ticket.statusCode).toBe(200)
    expect(ticket.json().role).toBe('commenter') // sync marks this session read-only (canEditCanvas false)
    const thread = await createThread(f.commenter, f.boardId, 'Read-only canvas, comments still work')
    const replied = await reply(f.commenter2, thread.id, 'Agreed')
    expect(replied.comments.map((c) => c.body)).toEqual(['Read-only canvas, comments still work', 'Agreed'])
  })

  it('editors and owners can comment too', async () => {
    await createThread(f.editor, f.boardId, 'from editor')
    await createThread(f.owner, f.boardId, 'from owner')
    expect((await list(f.commenter)).threads.map((t) => t.comments[0]?.body)).toEqual([
      'from editor',
      'from owner',
    ])
  })

  it('validates anchors and bodies', async () => {
    const bad: unknown[] = [
      { anchor: { kind: 'shape', shapeId: 'shape:a', u: 1.5, v: 0 }, body: 'x' },
      { anchor: { kind: 'shape', shapeId: 'not-a-shape', u: 0, v: 0 }, body: 'x' },
      { anchor: { kind: 'lasso', x: 0, y: 0 }, body: 'x' },
      { anchor: { kind: 'point', x: 1e9, y: 0 }, body: 'x' },
      { anchor: { kind: 'point', x: 0, y: 0, extra: true }, body: 'x' },
      {
        anchor: { kind: 'asset', shapeId: 'shape:a', assetId: 'https://evil', versionId: 'ver_0123456789' },
        body: 'x',
      },
      { anchor: point(), body: '   ' },
      { anchor: point(), body: 'x'.repeat(5001) },
      { anchor: point() },
    ]
    for (const body of bad) {
      const res = await f.commenter.req('POST', `/api/boards/${f.boardId}/threads`, body)
      expect(res.statusCode, JSON.stringify(body)).toBe(400)
    }
    expect(await countRows(f.api, 'comment_threads')).toBe(0)
    const ok = await createThread(f.commenter, f.boardId, 'x'.repeat(5000), {
      kind: 'asset',
      shapeId: 'shape:card1',
      assetId: 'ast_0123456789abcdefghij',
      versionId: 'ver_0123456789abcdefghij',
      page: 3,
    })
    expect(ok.anchor).toEqual({
      kind: 'asset',
      shapeId: 'shape:card1',
      assetId: 'ast_0123456789abcdefghij',
      versionId: 'ver_0123456789abcdefghij',
      page: 3,
    })
  })

  it('orphan anchors stay listable: the server never drops a thread because its shape is gone', async () => {
    // The API cannot know whether the shape still exists on the canvas; orphans are the client's view.
    const t = await createThread(
      f.commenter,
      f.boardId,
      'On a shape that will be deleted',
      onShape('shape:gone', 0, 1),
    )
    const { threads } = await list(f.viewer)
    expect(threads.map((x) => x.id)).toEqual([t.id])
    expect(threads[0]?.anchor).toEqual({ kind: 'shape', shapeId: 'shape:gone', u: 0, v: 1 })
  })
})

describe('replies, edits and deletes', () => {
  it('replies keep order and bump updatedAt', async () => {
    const t = await createThread(f.commenter, f.boardId, 'first')
    f.api.clock.advance(1000)
    const r = await reply(f.editor, t.id, 'second')
    expect(r.comments.map((c) => [c.body, c.author.id])).toEqual([
      ['first', f.commenter.userId],
      ['second', f.editor.userId],
    ])
    expect(Date.parse(r.updatedAt)).toBeGreaterThan(Date.parse(t.updatedAt))
  })

  it('viewers cannot reply, edit, delete, resolve or reopen', async () => {
    const t = await createThread(f.commenter, f.boardId, 'first')
    const cid = t.comments[0]?.id
    const calls: Array<['POST' | 'PATCH' | 'DELETE', string, unknown]> = [
      ['POST', `/api/threads/${t.id}/comments`, { body: 'x' }],
      ['PATCH', `/api/comments/${cid}`, { body: 'x' }],
      ['DELETE', `/api/comments/${cid}`, undefined],
      ['POST', `/api/threads/${t.id}/resolve`, undefined],
      ['POST', `/api/threads/${t.id}/reopen`, undefined],
    ]
    for (const [method, url, body] of calls) {
      const res = await f.viewer.req(method, url, body)
      expect(res.statusCode, `${method} ${url}`).toBe(403)
    }
    const { threads } = await list(f.owner)
    expect(threads[0]?.comments.map((c) => c.body)).toEqual(['first'])
    expect(threads[0]?.status).toBe('open')
  })

  it('only the author edits a comment (not even the board owner)', async () => {
    const t = await createThread(f.commenter, f.boardId, 'typo heer')
    const cid = t.comments[0]?.id
    for (const c of [f.owner, f.editor, f.commenter2]) {
      const res = await c.req('PATCH', `/api/comments/${cid}`, { body: 'hijacked' })
      expect(res.statusCode).toBe(403)
    }
    f.api.clock.advance(5000)
    const res = await f.commenter.req('PATCH', `/api/comments/${cid}`, { body: 'typo here' })
    expect(res.statusCode, res.body).toBe(200)
    const edited = ThreadResponse.parse(res.json()).thread.comments[0]
    expect(edited?.body).toBe('typo here')
    expect(edited?.editedAt).not.toBeNull()
  })

  it('an author who was downgraded to viewer can no longer edit or delete', async () => {
    const t = await createThread(f.commenter, f.boardId, 'mine')
    await f.owner.req('PUT', `/api/boards/${f.boardId}/members/${f.commenter.userId}`, { role: 'viewer' })
    const cid = t.comments[0]?.id
    expect((await f.commenter.req('PATCH', `/api/comments/${cid}`, { body: 'x' })).statusCode).toBe(403)
    expect((await f.commenter.req('DELETE', `/api/comments/${cid}`)).statusCode).toBe(403)
  })

  it('the author deletes their own comment softly; another commenter cannot', async () => {
    const t = await createThread(f.commenter, f.boardId, 'first')
    const r = await reply(f.commenter2, t.id, 'second')
    const second = r.comments[1]?.id
    expect((await f.commenter.req('DELETE', `/api/comments/${second}`)).statusCode).toBe(403)
    const del = await f.commenter2.req('DELETE', `/api/comments/${second}`)
    expect(del.statusCode).toBe(204)
    // Soft: the row stays, with deleted_at, and is never served again.
    const row = await f.api.db.one<{ deleted_at: Date | null }>(
      'SELECT deleted_at FROM comments WHERE id = $1',
      [second],
    )
    expect(row.deleted_at).toBeInstanceOf(Date)
    const { threads } = await list(f.owner)
    expect(threads[0]?.comments.map((c) => c.body)).toEqual(['first'])
    // Deleting again, editing or replying to a deleted comment's id is a 404.
    expect((await f.commenter2.req('DELETE', `/api/comments/${second}`)).statusCode).toBe(404)
    expect((await f.commenter2.req('PATCH', `/api/comments/${second}`, { body: 'x' })).statusCode).toBe(404)
    const deleted = f.events.find((e) => e.type === 'comments.deleted')
    expect(deleted?.data).toEqual({ threadId: t.id, commentId: second })
  })

  it('a board owner may delete anyone’s comment, and that moderation is audited', async () => {
    const t = await createThread(f.commenter, f.boardId, 'spam')
    const cid = t.comments[0]?.id
    expect((await f.editor.req('DELETE', `/api/comments/${cid}`)).statusCode).toBe(403)
    expect((await f.owner.req('DELETE', `/api/comments/${cid}`)).statusCode).toBe(204)
    const audit = await f.api.db.query<{ action: string; detail: { commentId: string } }>(
      "SELECT action, detail FROM audit_events WHERE action = 'comment.moderate_delete'",
    )
    expect(audit.rows).toHaveLength(1)
    expect(audit.rows[0]?.detail.commentId).toBe(cid)
    expect(JSON.stringify(audit.rows[0]?.detail)).not.toContain('spam')
    // A thread whose every comment is deleted is gone for everyone.
    expect((await list(f.owner)).threads).toHaveLength(0)
    expect((await f.commenter.req('POST', `/api/threads/${t.id}/comments`, { body: 'x' })).statusCode).toBe(
      404,
    )
  })
})

describe('resolve, reopen and read state', () => {
  it('resolve hides a thread from the open list; reopen brings it back', async () => {
    const t = await createThread(f.commenter, f.boardId, 'fix the logo')
    const res = await f.editor.req('POST', `/api/threads/${t.id}/resolve`)
    expect(res.statusCode, res.body).toBe(200)
    const resolved = ThreadResponse.parse(res.json()).thread
    expect(resolved).toMatchObject({ status: 'resolved', resolvedBy: { id: f.editor.userId } })
    expect(resolved.resolvedAt).not.toBeNull()
    expect((await list(f.viewer, '?status=open')).threads).toHaveLength(0)
    expect((await list(f.viewer, '?status=resolved')).threads.map((x) => x.id)).toEqual([t.id])
    expect((await list(f.viewer, '?status=all')).threads).toHaveLength(1)
    expect((await list(f.viewer)).threads).toHaveLength(1) // default: all

    const again = await f.commenter.req('POST', `/api/threads/${t.id}/resolve`)
    expect(again.statusCode).toBe(200) // idempotent
    const reopened = await f.commenter2.req('POST', `/api/threads/${t.id}/reopen`)
    expect(ThreadResponse.parse(reopened.json()).thread).toMatchObject({
      status: 'open',
      resolvedBy: null,
      resolvedAt: null,
    })
    expect((await list(f.viewer, '?status=open')).threads).toHaveLength(1)
    // Two changes, two thread events (the idempotent resolve published nothing).
    const statuses = f.events
      .filter((e) => e.type === 'comments.thread')
      .map((e) => (e.data as { thread: { status: string } }).thread.status)
    expect(statuses).toEqual(['open', 'resolved', 'open'])
  })

  it('replying to a resolved thread reopens it', async () => {
    const t = await createThread(f.commenter, f.boardId, 'done?')
    await f.editor.req('POST', `/api/threads/${t.id}/resolve`)
    const r = await reply(f.commenter, t.id, 'not quite')
    expect(r.status).toBe('open')
    expect(r.resolvedBy).toBeNull()
  })

  it('rejects an invalid status filter', async () => {
    expect((await f.viewer.req('GET', `/api/boards/${f.boardId}/threads?status=deleted`)).statusCode).toBe(
      400,
    )
  })

  it('tracks read state per person; a viewer can mark threads read', async () => {
    const t = await createThread(f.commenter, f.boardId, 'hello')
    // The author has read their own thread; nobody else has.
    expect((await list(f.commenter)).reads[t.id]).toBeDefined()
    expect((await list(f.viewer)).reads[t.id]).toBeUndefined()
    f.api.clock.advance(1000)
    const res = await f.viewer.req('POST', `/api/threads/${t.id}/read`)
    expect(res.statusCode, res.body).toBe(200)
    const readAt = res.json().readAt as string
    expect((await list(f.viewer)).reads[t.id]).toBe(readAt)
    expect((await list(f.editor)).reads[t.id]).toBeUndefined()
    // Marks only move forward; a later reply by someone else is after the viewer's mark.
    f.api.clock.advance(1000)
    const r = await reply(f.editor, t.id, 'new reply')
    expect(Date.parse(r.comments[1]?.createdAt ?? '')).toBeGreaterThan(Date.parse(readAt))
  })

  it('never puts per-person read state in published thread events', async () => {
    await createThread(f.commenter, f.boardId, 'hello')
    const e = f.events.find((x) => x.type === 'comments.thread')
    expect(e).toBeDefined()
    expect(Object.keys(e?.data as object)).toEqual(['thread'])
    expect(JSON.stringify(e?.data)).not.toContain('readAt')
  })

  it('publishes the full committed thread (as every viewer would fetch it) for each change', async () => {
    const t = await createThread(f.commenter, f.boardId, 'hello')
    const r = await reply(f.editor, t.id, 'reply')
    const published = f.events
      .filter((x) => x.type === 'comments.thread')
      .map((x) => (x.data as { thread: unknown }).thread)
    expect(published).toEqual([t, r])
    // What the event said is what a fresh read returns: it was published after the commit.
    expect((await list(f.viewer)).threads).toEqual([r])
    // A refused write publishes nothing.
    await f.viewer.req('POST', `/api/threads/${t.id}/comments`, { body: 'nope' })
    expect(f.events.filter((x) => x.type === 'comments.thread')).toHaveLength(2)
  })
})
