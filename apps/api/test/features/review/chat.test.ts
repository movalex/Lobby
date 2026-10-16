// Wave S, WS1 (docs/WAVE-S-CONTRACTS.md §2.5): a review step reaches the opted-in people's Slack/Teams hooks through the
// wave R outbox, written in the status write's own transaction. One message per hook per event however many recipients
// opted in (a many-recipient kind); the sentence names the actor as the bell does ("Ana (guest)"); the item's label (a
// round's title) only under the hook's snippet switch, never the note's text. The receiver is the fake one (never the
// real services).

import { CHAT_HIDDEN_BOARD_TITLE, LOBBY_CLIENT_HEADER } from '@draftroom/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { type ChatWorld, chatWorld, slackText } from '../chat-hooks/support.ts'
import { guestLink, joinAsGuest } from '../guests/support.ts'
import { mark, setStatus } from './support.ts'

let w: ChatWorld | undefined
afterEach(async () => {
  await w?.close()
  w = undefined
})

const REV3 = { [LOBBY_CLIENT_HEADER]: '3' }

describe('review_status in chat', () => {
  it('one message per hook per event; the label and a private title only with includeSnippets; never the note', async () => {
    w = await chatWorld()
    const world = w
    const HOOKS = '/api/workspaces/wsp_DevStudio00000000000/chat-hooks'
    // the owner (the board's owner) and ben (who marks the item) both opt in to review_status on the one hook
    for (const c of [world.owner, world.ben]) {
      const res = await c.req(
        'PUT',
        '/api/me/chat-prefs',
        {
          workspaceId: 'wsp_DevStudio00000000000',
          prefs: [{ hookId: world.hookId, kinds: ['review_status'] }],
        },
        REV3,
      )
      expect(res.statusCode, res.body).toBe(200)
    }
    const link = await guestLink(world.owner, world.boardId, { role: 'commenter' })
    const ana = await joinAsGuest(world.api, link.url, 'Ana')
    const item = await mark(world.ben, world.boardId, {
      elementId: 'frame-1',
      kind: 'frame',
      label: 'Key art B',
    })
    const res = await setStatus(ana, world.boardId, item.id, {
      status: 'approved',
      note: 'Secret note words',
    })
    expect(res.statusCode, res.body).toBe(200)
    const rows = await world.api.db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM notifications WHERE kind = 'review_status'",
    )
    expect(rows.rows[0]?.n).toBe(2)
    const queued = await world.api.db.query<{ status: string }>('SELECT status FROM chat_deliveries')
    expect(queued.rows).toHaveLength(1)
    await world.tick()
    expect(world.receiver.posts).toHaveLength(1)
    const text = slackText(world.receiver.posts[0]?.body ?? null)
    expect(text).toContain(`Ana (guest) approved an item on ${CHAT_HIDDEN_BOARD_TITLE}`)
    expect(world.receiver.posts[0]?.raw).not.toContain('Key art B')
    expect(world.receiver.posts[0]?.raw).not.toContain('Secret note words')
    // with the switch on: the label and the private board's title, still never the note
    expect(
      (await world.owner.req('PATCH', `${HOOKS}/${world.hookId}`, { includeSnippets: true })).statusCode,
    ).toBe(200)
    world.receiver.reset()
    await setStatus(ana, world.boardId, item.id, { status: 'changes_requested', note: 'Another secret' })
    await world.tick()
    expect(world.receiver.posts).toHaveLength(1)
    const labelled = slackText(world.receiver.posts[0]?.body ?? null)
    expect(labelled).toContain('Ana (guest) requested changes on Key art B on Pitch wall')
    expect(world.receiver.posts[0]?.raw).not.toContain('Another secret')
  })

  it('a round start is one message for the hook: "started Round 1 … (2 items)" with the switch on', async () => {
    w = await chatWorld()
    const world = w
    await world.owner.req('PATCH', `/api/workspaces/wsp_DevStudio00000000000/chat-hooks/${world.hookId}`, {
      includeSnippets: true,
    })
    const res = await world.owner.req(
      'PUT',
      '/api/me/chat-prefs',
      {
        workspaceId: 'wsp_DevStudio00000000000',
        prefs: [{ hookId: world.hookId, kinds: ['review_status'] }],
      },
      REV3,
    )
    expect(res.statusCode).toBe(200)
    await mark(world.ben, world.boardId, { elementId: 'frame-1', kind: 'frame', label: 'A' })
    await mark(world.ben, world.boardId, { elementId: 'frame-2', kind: 'frame', label: 'B' })
    const started = await world.ben.req('POST', `/api/boards/${world.boardId}/review/rounds`, {})
    expect(started.statusCode, started.body).toBe(201)
    await world.tick()
    expect(world.receiver.posts).toHaveLength(1)
    expect(slackText(world.receiver.posts[0]?.body ?? null)).toContain(
      'Ben Editor started Round 1 on Pitch wall (2 items)',
    )
  })
})
