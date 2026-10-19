// OWNER: WS1 (wave V). Shared setup for the live-activities api tests: one Dev Studio board with a person per role, a
// name-only guest on a workshop (editor) link and one on a review (commenter) link, a client account on a review
// link, a frozen app clock, the activities switch on, and every event published for the board.

import {
  type ActivityState,
  activitiesPath,
  activityActionPath,
  activityPath,
  type StartActivityInput,
} from '@draftroom/contracts'
import type { LightMyRequestResponse } from 'fastify'
import { type DeliveredEvent, EventHub } from '../../../src/events/hub.ts'
import { type Client, createBoard, createTestApi, DEV_STUDIO, type TestApi } from '../../helpers.ts'
import { type GuestClient, guestLink, joinAsGuest, tokenOf } from '../guests/support.ts'

export type Caller = Pick<Client, 'req'> & { userId: string }

export interface World {
  api: TestApi
  /** The app clock (frozen; only moves when advanced). */
  clock: { advance(ms: number): void; set(ms: number): void; now(): Date }
  hub: EventHub
  board: string
  /** Everything published for the board, in order. */
  events: DeliveredEvent[]
  owner: Client // Dev Studio owner, the board's owner
  editor: Client
  editor2: Client
  commenter: Client
  viewer: Client
  outsider: Client // a Dev Studio member without access to the board
  client: Client // an account in no shared workspace, on a review (commenter) link
  guest: GuestClient // a name-only guest on a workshop (editor) link
  reviewGuest: GuestClient // a name-only guest on a review (commenter) link
  close(): Promise<void>
}

/** The first window boundary at or after `ms` (plus a margin), for a clock that should start on a boundary. */
export const nextBoundary = (ms: number, windowMs: number, plus = 0) =>
  Math.ceil(ms / windowMs) * windowMs + windowMs + plus

export async function setupWorld(opts: { live?: boolean } = {}): Promise<World> {
  const hub = new EventHub()
  // A frozen clock on a window boundary (+100 ms), so tests can reason in windows.
  let t = nextBoundary(Date.now(), 5_000, 100)
  const clock = {
    advance: (ms: number) => {
      t += ms
    },
    set: (ms: number) => {
      t = ms
    },
    now: () => new Date(t),
  }
  const api = await createTestApi({
    deps: { events: hub, now: clock.now },
    env: opts.live === false ? {} : { DRAFTROOM_LIVE_ACTIVITIES: 'on' },
  })
  const owner = await api.login('ada', 'Ada Owner')
  const editor = await api.login('ed', 'Ed Editor')
  const editor2 = await api.login('eve', 'Eve Editor')
  const commenter = await api.login('cora', 'Cora Commenter')
  const viewer = await api.login('vic', 'Vic Viewer')
  const outsider = await api.login('otto', 'Otto Outsider')
  const client = await api.login('rita', 'Rita Client', { email: 'rita@client.example' })
  await api.db.query('DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [
    DEV_STUDIO,
    client.userId,
  ])
  const board = await createBoard(owner, DEV_STUDIO, 'Workshop')
  for (const [c, role] of [
    [editor, 'editor'],
    [editor2, 'editor'],
    [commenter, 'commenter'],
    [viewer, 'viewer'],
  ] as const) {
    const res = await owner.req('PUT', `/api/boards/${board}/members/${c.userId}`, { role })
    if (res.statusCode !== 200) throw new Error(`grant ${role} failed: ${res.statusCode} ${res.body}`)
  }
  const review = await guestLink(owner, board, { role: 'commenter', allowGuests: false })
  const accepted = await client.req('POST', `/api/invitations/${tokenOf(review.url)}/accept`)
  if (accepted.statusCode !== 200) throw new Error(`accept failed: ${accepted.statusCode} ${accepted.body}`)
  const guest = await joinAsGuest(api, (await guestLink(owner, board, { role: 'editor' })).url, 'Gus Guest')
  const reviewGuest = await joinAsGuest(
    api,
    (await guestLink(owner, board, { role: 'commenter' })).url,
    'Rae Reviewguest',
  )
  const events: DeliveredEvent[] = []
  hub.subscribe(board, (e) => events.push(e))
  return {
    api,
    clock,
    hub,
    board,
    events,
    owner,
    editor,
    editor2,
    commenter,
    viewer,
    outsider,
    client,
    guest,
    reviewGuest,
    close: () => api.close(),
  }
}

export const POLL: StartActivityInput = {
  kind: 'poll',
  prompt: 'Which one first?',
  config: { options: ['Alpha', 'Beta', 'Gamma'] },
}
export const SCALE: StartActivityInput = {
  kind: 'scale',
  prompt: 'How confident are you?',
  config: { min: 1, max: 5, minLabel: 'Not at all', maxLabel: 'Very' },
}
export const WORDS: StartActivityInput = {
  kind: 'words',
  prompt: 'One word for this quarter',
  config: { maxWords: 3 },
}

export function expectStatus(res: LightMyRequestResponse, status: number) {
  if (res.statusCode !== status) throw new Error(`expected ${status}, got ${res.statusCode}: ${res.body}`)
}

export const errorCode = (res: LightMyRequestResponse) =>
  (res.json() as { error?: { code?: string } }).error?.code

/** Starts an activity (201) and returns its state. */
export async function start(
  c: Caller,
  board: string,
  input: StartActivityInput = POLL,
): Promise<ActivityState> {
  const res = await c.req('POST', activitiesPath(board), input)
  expectStatus(res, 201)
  return res.json() as ActivityState
}

export const idOf = (s: ActivityState): string => {
  if (!s.activity) throw new Error('no activity')
  return s.activity.id
}

export const answer = (c: Caller, aid: string, a: unknown) =>
  c.req('POST', activityActionPath(aid, 'answer'), { answer: a })

export const act = (
  c: Caller,
  aid: string,
  action: 'close' | 'reveal' | 'extend' | 'cancel' | 'hide' | 'placed',
  body: unknown = {},
) => c.req('POST', activityActionPath(aid, action), body)

export const state = async (c: Caller, board: string): Promise<ActivityState> => {
  const res = await c.req('GET', activityPath(board))
  expectStatus(res, 200)
  return res.json() as ActivityState
}

/** The activity events published so far. */
export const activityEvents = (w: World) => w.events.filter((e) => e.type.startsWith('workshop.activity'))
