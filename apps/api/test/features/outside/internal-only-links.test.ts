// Wave J refix round 1, IO-5: "+1 h" (extend) and "allow guests" (PATCH) on a review, workshop or guest link
// were refused only by the root hook, which reads the switch before the route's transaction. A switch turned
// on, or a board moved into an internal-only project, between the hook's read and the route then gave the
// link more time, or opened it to name-only guests, while the switch was on. Both routes now decide the
// switch again in their transactions, under the workspace row lock the switch and a move take
// (lockBoardWorkspace, before the board row), and so does creating a link (whose window, inside its own
// transaction, needs a real Postgres to show: internal-only-locks.pg.test.ts). The tests commit the change
// right after the hook's read, as another connection would.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type Client, createBoard, createTestApi, DEV_STUDIO, type TestApi } from '../../helpers.ts'
import { guestLink } from '../guests/support.ts'
import {
  BOARD_SWITCH_READ,
  commitAfter,
  move,
  newProject,
  refused,
  setProject,
} from './internal-only-support.ts'

describe('IO-5: a link that exists, against a switch-on or a move-in after the hook’s read', () => {
  let api: TestApi
  let alice: Client // Dev Studio owner (creator)
  let bob: Client // creator member, owns `board`
  let secret: string // the project whose switch is under test
  let open: string // a project whose switch stays off
  let board: string
  let link: string

  beforeEach(async () => {
    api = await createTestApi()
    alice = await api.login('alice')
    bob = await api.login('bob')
    secret = await newProject(bob, DEV_STUDIO, 'Secret')
    open = await newProject(bob, DEV_STUDIO, 'Open')
    board = await createBoard(bob, DEV_STUDIO, 'Plan')
    expect((await move(bob, board, secret)).statusCode).toBe(200)
    link = (await guestLink(bob, board, { role: 'commenter', allowGuests: false })).id
  })
  afterEach(() => api.close())

  const linkRow = (id: string) =>
    api.db.one<{ expires_at: Date; allow_guests: boolean }>(
      'SELECT expires_at, allow_guests FROM invitations WHERE id = $1',
      [id],
    )
  const extend = () => bob.req('POST', `/api/boards/${board}/review-links/${link}/extend`, { hours: 1 })
  const allowGuests = (on: boolean) =>
    bob.req('PATCH', `/api/boards/${board}/review-links/${link}`, { allowGuests: on })
  const switchOn = () =>
    commitAfter(api, BOARD_SWITCH_READ, (q) =>
      q('UPDATE projects SET internal_only = true WHERE id = $1', [secret]),
    )
  const moveIn = async () => {
    // The board sits in a project whose switch is off; the secret project's switch is on.
    expect((await move(bob, board, open)).statusCode).toBe(200)
    expect((await setProject(alice, secret, true)).statusCode).toBe(200)
    return commitAfter(api, BOARD_SWITCH_READ, (q) =>
      q('UPDATE boards SET project_id = $2 WHERE id = $1', [board, secret]),
    )
  }

  it('"+1 h": a switch turned on after the hook read it is still refused', async () => {
    const before = await linkRow(link)
    const undo = switchOn()
    try {
      refused(await extend(), 'project')
    } finally {
      undo()
    }
    expect((await linkRow(link)).expires_at.getTime()).toBe(before.expires_at.getTime())
  })

  it('"+1 h": a move into an internal-only project after the hook read is still refused', async () => {
    const before = await linkRow(link)
    const undo = await moveIn()
    try {
      refused(await extend(), 'project')
    } finally {
      undo()
    }
    expect((await linkRow(link)).expires_at.getTime()).toBe(before.expires_at.getTime())
  })

  it('"allow guests": a switch turned on after the hook read is still refused', async () => {
    const undo = switchOn()
    try {
      refused(await allowGuests(true), 'project')
    } finally {
      undo()
    }
    expect((await linkRow(link)).allow_guests).toBe(false)
  })

  it('"allow guests": a move into an internal-only project after the hook read is still refused', async () => {
    const undo = await moveIn()
    try {
      refused(await allowGuests(true), 'project')
    } finally {
      undo()
    }
    expect((await linkRow(link)).allow_guests).toBe(false)
  })

  it('without the race, both work as before; turning guests off is never refused', async () => {
    expect((await extend()).statusCode).toBe(200)
    expect((await allowGuests(true)).statusCode).toBe(200)
    expect((await linkRow(link)).allow_guests).toBe(true)
    expect((await setProject(alice, secret, true)).statusCode).toBe(200)
    expect((await allowGuests(false)).statusCode).toBe(200)
    expect((await linkRow(link)).allow_guests).toBe(false)
  })
})
