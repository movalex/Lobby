// Wave J (AUTHZ-TEAM-OUTSIDER, security audit 2026-10-05): F10's "team" is a workspace owner, admin or
// member who is a CONFIRMED creator. An outside account invited as a workspace member (D5 allows it)
// used to count as the team: it read "Team only" threads, got their text in search, the bell and the
// per-audience board events, and could start team-only threads. An account Lobby cannot confirm fails
// closed. hasOutsideAccess now also counts outside accounts with a workspace role or a grant, so the
// composer's "Team only" default turns on for such boards. Comment authors carry `external`.

import {
  COMMENTS_THREAD_EVENT,
  ListNotificationsResponse,
  ListThreadsResponse,
  LOBBY_CLIENT_HEADER,
  LOBBY_CLIENT_REV,
  ThreadResponse,
} from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type DeliveredEvent, EventHub } from '../../../src/events/hub.ts'
import { searchIndexerOf } from '../../../src/features/search/index.ts'
import { type Client, createBoard, createTestApi, DEV_STUDIO, type TestApi } from '../../helpers.ts'
import { mention, point } from '../comments/fixture.ts'

const REV = { [LOBBY_CLIENT_HEADER]: String(LOBBY_CLIENT_REV) }

let api: TestApi
let hub: EventHub
let owner: Client // Dev Studio owner, a creator (dev.invalid)
let member: Client // a creator member
let pat: Client // an OUTSIDE account (pat@client.example.test), a Dev Studio member
let boardId: string

beforeEach(async () => {
  hub = new EventHub()
  api = await createTestApi({ deps: { events: hub } })
  owner = await api.login('owner', 'Olive Owner')
  member = await api.login('mia', 'Mia Member')
  pat = await api.login('pat', 'Pat Client', { email: 'pat@client.example.test' })
  // D5 allows an outside account as a workspace member (an invitation would do the same).
  await api.db.query(
    "INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ($1, $2, 'member', now())",
    [DEV_STUDIO, pat.userId],
  )
  boardId = await createBoard(owner, DEV_STUDIO, 'Pricing')
  for (const c of [member, pat]) {
    const res = await owner.req('PUT', `/api/boards/${boardId}/members/${c.userId}`, { role: 'commenter' })
    expect(res.statusCode, res.body).toBe(200)
  }
})
afterEach(() => api.close())

const list = async (c: Client) => {
  const res = await c.req('GET', `/api/boards/${boardId}/threads?status=all`)
  expect(res.statusCode, res.body).toBe(200)
  return ListThreadsResponse.parse(res.json())
}

async function create(c: Client, body: string, visibility?: 'everyone' | 'team') {
  const res = await c.req('POST', `/api/boards/${boardId}/threads`, {
    anchor: point(),
    body,
    ...(visibility ? { visibility } : {}),
  })
  return res
}

const created = async (c: Client, body: string, visibility?: 'everyone' | 'team') => {
  const res = await create(c, body, visibility)
  expect(res.statusCode, res.body).toBe(201)
  return ThreadResponse.parse(res.json()).thread
}

function streamOf(userId: string): DeliveredEvent[] {
  const got: DeliveredEvent[] = []
  const opened = hub.openStream(boardId, {
    userId,
    sessionId: `s-${userId}`,
    deliver: (e) => void got.push(e),
    end: () => {},
  })
  expect(opened.ok).toBe(true)
  return got
}

const bell = async (c: Client) => {
  const res = await c.req('GET', '/api/me/notifications', undefined, REV)
  expect(res.statusCode, res.body).toBe(200)
  return ListNotificationsResponse.parse(res.json())
}

describe('the team is creators with a workspace role (an outside workspace member is not on it)', () => {
  it('an outside member never gets a team-only thread: not listed, 404 on every route, no new ones', async () => {
    const team = await created(member, 'internal only: margin is 40%', 'team')
    await created(member, 'For everyone')
    const theirs = await list(pat)
    expect(theirs.threads.map((t) => t.comments[0]?.body)).toEqual(['For everyone'])
    expect(theirs.privacy).toEqual({ teamOnly: false, teamOnlyDefault: false })
    expect(JSON.stringify(theirs)).not.toContain('margin is 40%')
    for (const [method, url, body] of [
      ['POST', `/api/threads/${team.id}/comments`, { body: 'hi' }],
      ['POST', `/api/threads/${team.id}/resolve`, undefined],
      ['POST', `/api/threads/${team.id}/read`, undefined],
      ['POST', `/api/threads/${team.id}/visibility`, { visibility: 'everyone' }],
    ] as const) {
      const res = await pat.req(method, url, body)
      expect(res.statusCode, `${method} ${url}`).toBe(404)
    }
    const refused = await create(pat, 'mine, team only', 'team')
    expect(refused.statusCode).toBe(403)
    // The creator member is on the team, and sees both.
    expect((await list(member)).threads).toHaveLength(2)
    expect((await list(member)).privacy?.teamOnly).toBe(true)
  })

  it('mentions, the bell, board events and search leave the outsider out of team-only threads', async () => {
    const ownerGot = streamOf(owner.userId)
    const patGot = streamOf(pat.userId)
    await created(member, `zebrapalette ${mention(pat)} ${mention(owner)}`, 'team')
    const open = await created(member, `giraffepalette ${mention(pat)}`)
    const kinds = (got: DeliveredEvent[]) => got.filter((e) => e.type === COMMENTS_THREAD_EVENT).length
    expect(kinds(ownerGot)).toBe(2)
    expect(kinds(patGot)).toBe(1)
    expect(JSON.stringify(patGot)).not.toContain('zebrapalette')
    // The bell: the outsider was only notified of the open thread (the team-only mention became text).
    const theirs = await bell(pat)
    expect(theirs.notifications.map((n) => n.threadId)).toEqual([open.id])
    expect((await bell(owner)).notifications.map((n) => n.kind)).toContain('mention')

    const indexer = searchIndexerOf(api.app)
    await indexer?.refreshComments(boardId)
    const search = async (c: Client, q: string) => {
      const res = await c.req('GET', `/api/workspaces/${DEV_STUDIO}/search?q=${q}`)
      expect(res.statusCode, res.body).toBe(200)
      return (res.json() as { totalHits: number }).totalHits
    }
    expect(await search(member, 'zebrapalette')).toBe(1)
    expect(await search(pat, 'zebrapalette')).toBe(0)
    expect(await search(pat, 'giraffepalette')).toBe(1)
  })

  it('a thread made team-only later disappears from the outsider’s bell (a stale notification)', async () => {
    const t = await created(member, `look ${mention(pat)}`)
    expect((await bell(pat)).unreadCount).toBe(1)
    expect(
      (await member.req('POST', `/api/threads/${t.id}/visibility`, { visibility: 'team' })).statusCode,
    ).toBe(200)
    const after = await bell(pat)
    expect(after.unreadCount).toBe(0)
    expect(after.notifications).toEqual([])
  })

  it('an account Lobby cannot confirm fails closed (not on the team until a refresh confirms it)', async () => {
    const team = await created(member, 'stale but internal', 'team')
    // mia's addresses were last confirmed more than a day ago: no longer a confirmed creator.
    await api.db.query("UPDATE users SET identity_checked_at = now() - interval '25 hours' WHERE id = $1", [
      member.userId,
    ])
    // Routes that decide without refreshing: starting a team-only thread, replying to one.
    expect((await create(member, 'again', 'team')).statusCode).toBe(403)
    expect((await member.req('POST', `/api/threads/${team.id}/comments`, { body: 'x' })).statusCode).toBe(404)
    // GET threads confirms the caller first (like /api/me; the dev provider always confirms), so mia is
    // back on the team there, and so on every route after it.
    expect((await list(member)).threads.map((t) => t.id)).toContain(team.id)
    expect((await member.req('POST', `/api/threads/${team.id}/comments`, { body: 'x' })).statusCode).toBe(201)
  })

  it('"Team only" starts on for a board an outside account can open (a grant or a workspace role)', async () => {
    expect((await list(owner)).privacy).toEqual({ teamOnly: true, teamOnlyDefault: true })
    // Without the outsider's grant (still a member, the board private): nobody outside can open it.
    expect((await owner.req('DELETE', `/api/boards/${boardId}/members/${pat.userId}`)).statusCode).toBe(200)
    expect((await list(owner)).privacy).toEqual({ teamOnly: true, teamOnlyDefault: false })
    // Visible to the workspace: the outside member reaches it again through the workspace role.
    expect(
      (await owner.req('PATCH', `/api/boards/${boardId}`, { visibility: 'workspace_view' })).statusCode,
    ).toBe(200)
    expect((await list(owner)).privacy).toEqual({ teamOnly: true, teamOnlyDefault: true })
  })

  it('comment authors carry `external` (true for the outside account, false for creators)', async () => {
    await created(pat, 'From the client')
    await created(member, 'From the studio')
    const threads = (await list(owner)).threads
    const authors = Object.fromEntries(
      threads.flatMap((t) => t.comments).map((c) => [c.body, c.author.external]),
    )
    expect(authors).toEqual({ 'From the client': true, 'From the studio': false })
    // The thread event carries the same (it is published to everyone, without any domain).
    const got = streamOf(owner.userId)
    await created(pat, 'Another')
    const data = got.find((e) => e.type === COMMENTS_THREAD_EVENT)?.data as {
      thread: { createdBy: { external?: boolean } }
    }
    expect(data.thread.createdBy.external).toBe(true)
    expect(JSON.stringify(got)).not.toContain('client.example.test')
  })
})
