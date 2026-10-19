// Shared setup for the breakouts API tests (wave V, WS4): one Dev Studio board with a person per role, the breakouts
// switch on (DRAFTROOM_BREAKOUTS), a recorder for every event published to the board, and streams opened straight on
// the hub (a person's open tab, as `auto` mode and the targeted delivery see it).

import {
  BREAKOUT_EVENTS,
  BreakoutState,
  breakoutActionPath,
  breakoutsPath,
  type StartBreakoutsInput,
} from '@draftroom/contracts'
import type { Db } from '@draftroom/db'
import type { LightMyRequestResponse } from 'fastify'
import { type DeliveredEvent, EventHub } from '../../../src/events/hub.ts'
import { type Client, createBoard, createTestApi, DEV_STUDIO, type TestApi } from '../../helpers.ts'
import { FakeSync } from '../workshops/support.ts'

export interface BreakoutWorld {
  api: TestApi
  clock: { advance(ms: number): void; now(): Date }
  sync: FakeSync
  hub: EventHub
  boardId: string
  /** Everything published for the board, in order (an in-process listener: it hears targeted events too). */
  events: DeliveredEvent[]
  owner: Client // Dev Studio owner (board owner through the workspace), the usual facilitator
  editor: Client
  editor2: Client
  commenter: Client
  viewer: Client
  outsider: Client // Dev Studio member without access to the board
  /** Opens one stream (a tab) for `c` on the board; returns what it receives. */
  tab(c: { userId: string }, boardId?: string): TabStream
}

export interface TabStream {
  userId: string
  received: DeliveredEvent[]
  close(): void
}

export const BREAKOUTS_ON = { DRAFTROOM_BREAKOUTS: 'on' }

export async function breakoutWorld(
  opts: { db?: Db; env?: Record<string, string> } = {},
): Promise<BreakoutWorld> {
  const sync = new FakeSync()
  const hub = new EventHub()
  let t = Date.now()
  const clock = {
    advance: (ms: number) => {
      t += ms
    },
    now: () => new Date(t),
  }
  const api = await createTestApi({
    deps: { events: hub, syncInternal: sync, now: clock.now },
    env: { ...BREAKOUTS_ON, ...opts.env },
    ...(opts.db ? { db: opts.db } : {}),
  })
  const owner = await api.login('ada', 'Ada Owner')
  const editor = await api.login('ed', 'Ed Editor')
  const editor2 = await api.login('eve', 'Eve Editor')
  const commenter = await api.login('cora', 'Cora Commenter')
  const viewer = await api.login('vic', 'Vic Viewer')
  const outsider = await api.login('otto', 'Otto Outsider')
  const boardId = await createBoard(owner, DEV_STUDIO, 'Workshop')
  for (const [c, role] of [
    [editor, 'editor'],
    [editor2, 'editor'],
    [commenter, 'commenter'],
    [viewer, 'viewer'],
  ] as const)
    await grant(owner, boardId, c.userId, role)
  const events: DeliveredEvent[] = []
  hub.subscribe(boardId, (e) => events.push(e))
  let n = 0
  const tab = (c: { userId: string }, bid = boardId): TabStream => {
    const received: DeliveredEvent[] = []
    const r = hub.openStream(bid, {
      userId: c.userId,
      sessionId: `test-session-${++n}`,
      deliver: (e) => received.push(e),
      end: () => {},
    })
    if (!r.ok) throw new Error('stream refused')
    return { userId: c.userId, received, close: r.close }
  }
  return { api, clock, sync, hub, boardId, events, owner, editor, editor2, commenter, viewer, outsider, tab }
}

export async function grant(owner: Client, boardId: string, userId: string, role: string) {
  const res = await owner.req('PUT', `/api/boards/${boardId}/members/${userId}`, { role })
  if (res.statusCode !== 200) throw new Error(`grant ${role} failed: ${res.statusCode} ${res.body}`)
}

export function expectStatus(res: LightMyRequestResponse, status: number) {
  if (res.statusCode !== status) throw new Error(`expected ${status}, got ${res.statusCode}: ${res.body}`)
}

export const codeOf = (res: LightMyRequestResponse) =>
  (res.json() as { error?: { code?: string } }).error?.code

export const frames = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ name: `Group ${i + 1}`, frameId: `shape:frame${i + 1}` }))

/** Starts breakouts as `c` (201) and returns the state. */
export async function start(
  w: BreakoutWorld,
  c: Client,
  body: Partial<StartBreakoutsInput> = {},
): Promise<BreakoutState> {
  const res = await c.req('POST', breakoutsPath(w.boardId), { groups: frames(2), mode: 'manual', ...body })
  expectStatus(res, 201)
  return BreakoutState.parse(res.json())
}

export async function state(w: BreakoutWorld, c: { req: Client['req'] }): Promise<BreakoutState> {
  const res = await c.req('GET', breakoutsPath(w.boardId))
  expectStatus(res, 200)
  return BreakoutState.parse(res.json())
}

export const act = (
  c: { req: Client['req'] },
  brk: string,
  action: Parameters<typeof breakoutActionPath>[1],
  body: unknown = {},
) => c.req('POST', breakoutActionPath(brk, action), body)

export const stateEvents = (w: BreakoutWorld) => w.events.filter((e) => e.type === BREAKOUT_EVENTS.state)

/** Who is in which group: group id → sorted user ids. */
export function groupsOf(s: Pick<BreakoutState, 'members'>): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const m of s.members) {
    const list = out[m.groupId] ?? []
    list.push(m.userId)
    out[m.groupId] = list
  }
  for (const k of Object.keys(out)) out[k]?.sort()
  return out
}
