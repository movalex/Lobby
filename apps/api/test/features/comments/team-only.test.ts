// F10: team-only comment threads (0020_comment_visibility). People outside the team (workspace guests,
// i.e. review-link visitors with an account, and name-only guests) never get a team thread nor
// anything about it: list, routes (404), mentions, notifications, board events and search.

import {
  COMMENTS_DELETED_EVENT,
  COMMENTS_HIDDEN_EVENT,
  COMMENTS_THREAD_EVENT,
  ListThreadsResponse,
  ThreadResponse,
} from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type DeliveredEvent, EventHub } from '../../../src/events/hub.ts'
import { searchIndexerOf } from '../../../src/features/search/index.ts'
import { type Client, createBoard, createTestApi, DEV_STUDIO, type TestApi } from '../../helpers.ts'
import { type GuestClient, guestLink, joinAsGuest } from '../guests/support.ts'
import { mention, notificationsOf, point } from './fixture.ts'

type Req = Pick<Client, 'req'>

let api: TestApi
let hub: EventHub
let owner: Client
let member: Client // a Dev Studio member, commenter on the board: on the team
let reviewer: Client // an account user who is a workspace guest (came through a review link)
let dana: GuestClient // a name-only guest
let boardId: string

beforeEach(async () => {
  hub = new EventHub()
  api = await createTestApi({ deps: { events: hub } })
  owner = await api.login('owner', 'Olive Owner')
  member = await api.login('mia', 'Mia Member')
  reviewer = await api.login('rex', 'Rex Reviewer')
  boardId = await createBoard(owner, DEV_STUDIO, 'Client review')
  for (const c of [member, reviewer]) {
    const res = await owner.req('PUT', `/api/boards/${boardId}/members/${c.userId}`, { role: 'commenter' })
    expect(res.statusCode, res.body).toBe(200)
  }
  await api.db.query("UPDATE workspace_members SET role = 'guest' WHERE workspace_id = $1 AND user_id = $2", [
    DEV_STUDIO,
    reviewer.userId,
  ])
  const link = await guestLink(owner, boardId, { role: 'commenter' })
  dana = await joinAsGuest(api, link.url, 'Dana Whitfield')
})
afterEach(() => api.close())

const list = async (c: Req) => {
  const res = await c.req('GET', `/api/boards/${boardId}/threads?status=all`)
  expect(res.statusCode, res.body).toBe(200)
  return ListThreadsResponse.parse(res.json())
}

async function create(c: Req, body: string, visibility?: 'everyone' | 'team') {
  const res = await c.req('POST', `/api/boards/${boardId}/threads`, {
    anchor: point(),
    body,
    ...(visibility ? { visibility } : {}),
  })
  expect(res.statusCode, res.body).toBe(201)
  return ThreadResponse.parse(res.json()).thread
}

/** Opens an event stream on the board for `userId` directly on the hub and records what it gets. */
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

describe('team-only threads', () => {
  it('the team sees them; guests and review-link visitors never do, and existing threads stay "everyone"', async () => {
    const open = await create(member, 'Client can see this')
    expect(open.visibility).toBe('everyone')
    const team = await create(member, 'Hero for option B? Internal only', 'team')
    expect(team.visibility).toBe('team')

    for (const c of [owner, member]) {
      const r = await list(c)
      expect(r.threads.map((t) => t.id)).toEqual([open.id, team.id])
      expect(r.privacy).toEqual({ teamOnly: true, teamOnlyDefault: true }) // a live guest link exists
    }
    for (const c of [reviewer, dana]) {
      const r = await list(c)
      expect(r.threads.map((t) => t.id)).toEqual([open.id])
      expect(r.privacy).toEqual({ teamOnly: false, teamOnlyDefault: false })
      expect(JSON.stringify(r)).not.toContain('Internal only')
    }
  })

  it('every route answers 404 to people outside the team, and writes nothing', async () => {
    const team = await create(member, 'Internal only', 'team')
    const cid = team.comments[0]?.id
    for (const c of [reviewer, dana]) {
      for (const [method, url, body] of [
        ['POST', `/api/threads/${team.id}/comments`, { body: 'let me in' }],
        ['POST', `/api/threads/${team.id}/resolve`, undefined],
        ['POST', `/api/threads/${team.id}/reopen`, undefined],
        ['POST', `/api/threads/${team.id}/read`, undefined],
        ['POST', `/api/threads/${team.id}/visibility`, { visibility: 'everyone' }],
        ['PATCH', `/api/comments/${cid}`, { body: 'edited' }],
        ['DELETE', `/api/comments/${cid}`, undefined],
      ] as const) {
        const res = await c.req(method, url, body)
        expect(res.statusCode, `${method} ${url}`).toBe(404)
      }
    }
    const [after] = (await list(member)).threads
    expect(after?.comments.map((x) => x.body)).toEqual(['Internal only'])
    expect(after?.status).toBe('open')
    expect(after?.visibility).toBe('team')
  })

  it('people outside the team cannot start a team-only thread (403) nor change a thread’s visibility', async () => {
    for (const c of [reviewer, dana]) {
      const res = await c.req('POST', `/api/boards/${boardId}/threads`, {
        anchor: point(),
        body: 'sneaky',
        visibility: 'team',
      })
      expect(res.statusCode).toBe(403)
    }
    const open = await create(dana, 'Love the ember one')
    for (const c of [reviewer, dana]) {
      const res = await c.req('POST', `/api/threads/${open.id}/visibility`, { visibility: 'team' })
      expect(res.statusCode).toBe(403)
    }
  })

  it('outside the team, only the person who started a thread resolves or reopens it', async () => {
    const teamStarted = await create(member, 'For the client: which hero?')
    const res = await dana.req('POST', `/api/threads/${teamStarted.id}/resolve`)
    expect(res.statusCode).toBe(403)
    const own = await create(dana, 'My question')
    expect((await dana.req('POST', `/api/threads/${own.id}/resolve`)).statusCode).toBe(200)
    expect((await dana.req('POST', `/api/threads/${own.id}/reopen`)).statusCode).toBe(200)
    // The team resolves anything.
    expect((await member.req('POST', `/api/threads/${own.id}/resolve`)).statusCode).toBe(200)
  })

  it('mentions and notifications of a team-only thread reach the team only', async () => {
    // Dana starts a thread first so she follows nothing of the team's; then the team mentions her.
    const team = await create(
      member,
      `Ask ${mention(reviewer as Client, 'Rex Reviewer')} and ${mention(owner)} internally`,
      'team',
    )
    // The reviewer's mention became plain text; the owner's stayed a mention.
    expect(team.comments[0]?.mentions).toEqual([owner.userId])
    expect(team.comments[0]?.body).toContain('@Rex Reviewer and @[Olive Owner]')
    expect((await notificationsOf(owner)).notifications.map((n) => n.kind)).toEqual(['mention'])
    const rex = await notificationsOf(reviewer as Client)
    expect(rex.notifications).toEqual([])
    expect(rex.unreadCount).toBe(0)
  })

  it('a thread made team-only later disappears from guests’ bells and lists', async () => {
    const t = await create(dana, 'Can we see option C?')
    // Owner hears about Dana's thread; Dana hears about the owner's reply.
    const replied = await owner.req('POST', `/api/threads/${t.id}/comments`, { body: 'Checking internally' })
    expect(replied.statusCode).toBe(201)
    expect((await notificationsOf(dana as unknown as Client)).unreadCount).toBe(1)
    const res = await owner.req('POST', `/api/threads/${t.id}/visibility`, { visibility: 'team' })
    expect(res.statusCode, res.body).toBe(200)
    expect(ThreadResponse.parse(res.json()).thread.visibility).toBe('team')
    const bell = await notificationsOf(dana as unknown as Client)
    expect(bell.notifications).toEqual([])
    expect(bell.unreadCount).toBe(0)
    expect((await list(dana)).threads).toEqual([])
    // …and back.
    expect(
      (await owner.req('POST', `/api/threads/${t.id}/visibility`, { visibility: 'everyone' })).statusCode,
    ).toBe(200)
    expect((await list(dana)).threads.map((x) => x.id)).toEqual([t.id])
  })

  it('board events of a team-only thread go to the team’s streams only', async () => {
    const ownerGot = streamOf(owner.userId)
    const rexGot = streamOf(reviewer.userId)
    const danaGot = streamOf(dana.userId)
    const team = await create(member, 'Internal only', 'team')
    const open = await create(member, 'For everyone')
    const cid = team.comments[0]?.id
    expect((await member.req('POST', `/api/threads/${team.id}/resolve`)).statusCode).toBe(200)
    expect((await member.req('DELETE', `/api/comments/${cid}`)).statusCode).toBe(204)

    const summary = (got: DeliveredEvent[]) =>
      got.map((e) => {
        const d = e.data as { thread?: { id: string }; threadId?: string }
        return `${e.type}:${d.thread?.id ?? d.threadId}`
      })
    expect(summary(ownerGot)).toEqual([
      `${COMMENTS_THREAD_EVENT}:${team.id}`,
      `${COMMENTS_THREAD_EVENT}:${open.id}`,
      `${COMMENTS_THREAD_EVENT}:${team.id}`,
      `${COMMENTS_DELETED_EVENT}:${team.id}`,
    ])
    for (const got of [rexGot, danaGot]) {
      expect(summary(got)).toEqual([`${COMMENTS_THREAD_EVENT}:${open.id}`])
      expect(JSON.stringify(got)).not.toContain('Internal only')
    }

    // Making an everyone-thread team-only: the team gets the thread, everyone else a "drop it" hint.
    ownerGot.length = 0
    danaGot.length = 0
    expect(
      (await owner.req('POST', `/api/threads/${open.id}/visibility`, { visibility: 'team' })).statusCode,
    ).toBe(200)
    expect(summary(ownerGot)).toEqual([`${COMMENTS_THREAD_EVENT}:${open.id}`])
    expect(summary(danaGot)).toEqual([`${COMMENTS_HIDDEN_EVENT}:${open.id}`])
  })

  it('search leaves team-only comment text out for people outside the team', async () => {
    await create(member, 'zebrapalette internal thoughts', 'team')
    await create(member, 'giraffepalette for the client')
    const indexer = searchIndexerOf(api.app)
    await indexer?.refreshComments(boardId)
    const search = async (c: Req, q: string) => {
      const res = await c.req('GET', `/api/workspaces/${DEV_STUDIO}/search?q=${q}`)
      expect(res.statusCode, res.body).toBe(200)
      return (res.json() as { totalHits: number }).totalHits
    }
    expect(await search(member, 'zebrapalette')).toBe(1)
    expect(await search(owner, 'zebrapalette')).toBe(1)
    for (const c of [reviewer, dana]) {
      expect(await search(c, 'zebrapalette')).toBe(0)
      expect(await search(c, 'giraffepalette')).toBe(1)
    }
  })

  it('the default is "everyone" and off for boards nobody outside the team can open', async () => {
    const quiet = await createBoard(owner, DEV_STUDIO, 'Internal board')
    const res = await owner.req('GET', `/api/boards/${quiet}/threads`)
    expect(ListThreadsResponse.parse(res.json()).privacy).toEqual({ teamOnly: true, teamOnlyDefault: false })
  })
})
