// The outbox and the delivery loop (wave R, WS2; docs/WAVE-R-CONTRACTS.md §4.4): who a message is queued for, what it says,
// the checks made at send time, what each answer of the receiver does (retry with backoff, Retry-After, dead letter, the
// hook switched off), the caps and their roll-up, leases, the purge. Every message goes to the fake receiver
// (e2e/tests/support/chat-hooks.ts): never the real Slack or Teams.

import { CHAT_DELIVERY, type ChatHook } from '@draftroom/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { enqueueChatDeliveries } from '../../../src/features/chat-hooks/outbox.ts'
import { DEV_STUDIO } from '../../helpers.ts'
import { createThread, mention, reply } from '../comments/fixture.ts'
import { type ChatWorld, chatWorld, deliveries, optIn, slackText, statuses, teamsHookUrl } from './support.ts'

const HOOKS = `/api/workspaces/${DEV_STUDIO}/chat-hooks`

let w: ChatWorld
beforeEach(async () => {
  w = await chatWorld()
})
afterEach(() => w.close())

/** Olive mentions Ben in a new thread on the board. */
const mentionBen = (text = 'Please look at the second column') =>
  createThread(w.owner, w.boardId, `${text} ${mention(w.ben)}`)

const setBoard = (visibility: 'private' | 'workspace_view' | 'workspace_edit') =>
  w.api.db.query('UPDATE boards SET visibility = $2 WHERE id = $1', [w.boardId, visibility])

const hookRow = async (id = w.hookId) =>
  w.api.db.one<{
    disabled_at: Date | null
    disabled_reason: string | null
    last_error_code: string | null
    last_ok_at: Date | null
  }>('SELECT disabled_at, disabled_reason, last_error_code, last_ok_at FROM chat_hooks WHERE id = $1', [id])

describe('who a message is queued for', () => {
  it('nobody who did not opt in: no row is written, nothing is sent', async () => {
    await mentionBen()
    expect(await deliveries(w.api)).toEqual([])
    expect((await w.tick()).claimed).toBe(0)
    expect(w.receiver.posts).toEqual([])
  })

  it('only the kinds a person chose', async () => {
    await optIn(w.ben, w.hookId, ['reply'])
    await mentionBen()
    expect(await deliveries(w.api)).toEqual([])
    const thread = await createThread(w.ben, w.boardId, 'Ben asks something')
    await reply(w.owner, thread.id, 'Olive answers')
    // Ben follows his own thread: a reply, which he chose
    expect(await statuses(w.api)).toEqual(['queued'])
  })

  it('one row per hook and notification, however often the writer is asked', async () => {
    await optIn(w.ben, w.hookId, ['mention'])
    await mentionBen()
    const ids = (await w.api.db.query<{ id: string }>('SELECT id FROM notifications')).rows.map((r) => r.id)
    expect(ids).toHaveLength(1)
    expect(await enqueueChatDeliveries(w.api.db, ids)).toBe(0)
    expect(await deliveries(w.api)).toHaveLength(1)
  })

  it('a second hook gets its own row; a hook switched off gets none', async () => {
    const other = await w.owner.req('POST', HOOKS, {
      name: '#two',
      provider: 'slack',
      url: `${w.receiver.origin}/services/T0000000A/B0000000B/secondHOOK12`,
    })
    const otherId = (other.json() as ChatHook).id
    await optIn(w.ben, w.hookId, ['mention'])
    await w.ben.req('PUT', '/api/me/chat-prefs', {
      workspaceId: DEV_STUDIO,
      prefs: [
        { hookId: w.hookId, kinds: ['mention'] },
        { hookId: otherId, kinds: ['mention'] },
      ],
    })
    await w.api.db.query(
      "UPDATE chat_hooks SET disabled_at = now(), disabled_reason = 'gone' WHERE id = $1",
      [otherId],
    )
    await mentionBen()
    expect((await deliveries(w.api)).map((d) => d.hook_id)).toEqual([w.hookId])
  })

  it('is atomic with the notification: a rolled-back transaction leaves no row, and a broken outbox never fails the notification', async () => {
    await optIn(w.ben, w.hookId, ['mention', 'access_request'])
    await expect(
      w.api.db.transaction(async (tx) => {
        const inserted = await tx.one<{ id: string }>(
          `INSERT INTO notifications (workspace_id, user_id, kind, board_id, actor_id)
           VALUES ($1, $2, 'access_request', $3, $4) RETURNING id`,
          [DEV_STUDIO, w.ben.userId, w.boardId, w.owner.userId],
        )
        expect(await enqueueChatDeliveries(tx, [inserted.id])).toBe(1)
        throw new Error('roll back')
      }),
    ).rejects.toThrow('roll back')
    expect(await deliveries(w.api)).toEqual([])
    // a broken outbox is swallowed: the comment and its notification stand
    await w.api.db.query('ALTER TABLE chat_deliveries RENAME TO chat_deliveries_away')
    await mentionBen('Still works')
    await w.api.db.query('ALTER TABLE chat_deliveries_away RENAME TO chat_deliveries')
    const notes = await w.api.db.one<{ n: number }>(
      "SELECT count(*)::int AS n FROM notifications WHERE kind = 'mention'",
    )
    expect(notes.n).toBe(1)
    expect(await deliveries(w.api)).toEqual([])
  })
})

describe('what the message says', () => {
  beforeEach(async () => {
    await optIn(w.ben, w.hookId, ['mention', 'reply', 'new_comment', 'access_request', 'outsider_joined'])
    await setBoard('workspace_edit')
  })

  it('a mention: the event, both names, the board, the link back; no comment text unless the admin allowed it', async () => {
    const thread = await mentionBen('The secret launch date is Friday')
    const result = await w.tick()
    expect(result).toMatchObject({ claimed: 1, sent: 1 })
    expect(w.receiver.posts).toHaveLength(1)
    const post = w.receiver.posts[0]
    expect(post?.headers['user-agent']).toBe('LobbyNotify/1.0')
    expect(post?.headers.authorization).toBeUndefined()
    expect(post?.body).toMatchObject({
      text: 'Olive Owner mentioned Ben Editor on Pitch wall',
      unfurl_links: false,
      unfurl_media: false,
    })
    const text = slackText(post?.body ?? null)
    expect(text).toContain(`<http://127.0.0.1:5173/b/${w.boardId}?thread=${thread.id}|Open in Lobby>`)
    expect(text).not.toContain('launch date')
    expect(post?.raw).not.toContain('launch date')
    const row = (await deliveries(w.api))[0]
    expect(row).toMatchObject({ status: 'sent', attempts: 1, last_code: '200' })
    expect((await hookRow()).last_ok_at).not.toBeNull()
  })

  it('with the snippet switch on: the first 140 characters, quoted, never a team-only thread’s', async () => {
    await w.owner.req('PATCH', `${HOOKS}/${w.hookId}`, { includeSnippets: true })
    await mentionBen(`${'Words '.repeat(60)}end`)
    await w.tick()
    const text = slackText(w.receiver.posts[0]?.body ?? null)
    const quote = text.split('\n>')[1] ?? ''
    expect(quote.startsWith('Words Words')).toBe(true)
    expect([...quote].length).toBeLessThanOrEqual(140)
    expect(quote.endsWith('…')).toBe(true)
    // a team-only thread (Ben is on the team) carries no words, switch or not
    w.receiver.reset()
    const res = await w.owner.req('POST', `/api/boards/${w.boardId}/threads`, {
      anchor: { kind: 'point', x: 1, y: 2 },
      body: `Team only: budget ${mention(w.ben)}`,
      visibility: 'team',
    })
    expect(res.statusCode, res.body).toBe(201)
    await w.tick()
    expect(w.receiver.posts).toHaveLength(1)
    expect(w.receiver.posts[0]?.raw).not.toContain('budget')
  })

  it('a private board’s title stays out of the channel unless the admin opted in (a title shown otherwise)', async () => {
    await w.api.db.query("UPDATE boards SET title = 'Secret rebrand' WHERE id = $1", [w.boardId])
    await setBoard('private')
    await mentionBen()
    await w.tick()
    expect(w.receiver.posts[0]?.body?.text).toBe('Olive Owner mentioned Ben Editor on a private board')
    expect(w.receiver.posts[0]?.raw).not.toContain('Secret rebrand')
    w.receiver.reset()
    await w.owner.req('PATCH', `${HOOKS}/${w.hookId}`, { includeSnippets: true })
    await mentionBen('again')
    await w.tick()
    expect(w.receiver.posts[0]?.body?.text).toBe('Olive Owner mentioned Ben Editor on Secret rebrand')
    // a board the whole workspace can open shows its title by default
    w.receiver.reset()
    await w.owner.req('PATCH', `${HOOKS}/${w.hookId}`, { includeSnippets: false })
    await setBoard('workspace_view')
    await mentionBen('third')
    await w.tick()
    expect(w.receiver.posts[0]?.body?.text).toBe('Olive Owner mentioned Ben Editor on Secret rebrand')
  })

  it('a name or title cannot ping a channel or break out of the link (escaped in the blocks and the fallback text)', async () => {
    await w.api.db.query('UPDATE users SET name = $2 WHERE id = $1', [
      w.owner.userId,
      '<!channel> *Olive* <@U123|x>',
    ])
    await w.api.db.query('UPDATE boards SET title = $2 WHERE id = $1', [
      w.boardId,
      '<!here> & <https://evil.example|Free money>',
    ])
    await mentionBen()
    await w.tick()
    const post = w.receiver.posts[0]
    expect(post?.body?.text).toBe(
      '&lt;!channel&gt; *Olive* &lt;@U123|x&gt; mentioned Ben Editor on &lt;!here&gt; &amp; &lt;https://evil.example|Free money&gt;',
    )
    const text = slackText(post?.body ?? null)
    expect(text).not.toContain('<!channel>')
    expect(text).not.toContain('<!here>')
    expect(text).not.toContain('<@U123')
    expect(text).not.toContain('<https://evil.example')
  })

  it('a reply, a new comment on a board you own, an access request and an outsider each have their sentence', async () => {
    await optIn(w.owner, w.hookId, ['reply', 'new_comment', 'access_request', 'outsider_joined'])
    const thread = await createThread(w.owner, w.boardId, 'Olive asks')
    await reply(w.ben, thread.id, 'Ben answers')
    await createThread(w.ben, w.boardId, 'Ben starts a thread')
    // Sam has no access while the board is private; the board opens to the workspace again before the message goes
    await setBoard('private')
    const asked = await w.sam.req('POST', `/api/boards/${w.boardId}/access-requests`, { role: 'commenter' })
    expect(asked.statusCode, asked.body).toBe(202)
    await setBoard('workspace_edit')
    const note = await w.api.db.one<{ id: string }>(
      `INSERT INTO notifications (workspace_id, user_id, kind, board_id, actor_id)
       VALUES ($1, $2, 'outsider_joined', $3, $4) RETURNING id`,
      [DEV_STUDIO, w.owner.userId, w.boardId, w.pat.userId],
    )
    await enqueueChatDeliveries(w.api.db, [note.id])
    // one pass sends what is due (the receiver paces itself: 1 a second per hook)
    await w.tick()
    const said = w.receiver.posts.map((p) => p.body?.text)
    expect(said).toEqual(
      expect.arrayContaining([
        'Ben Editor replied to Olive Owner on Pitch wall',
        'Ben Editor commented on Pitch wall',
        'Sam Member asked for commenter access to Pitch wall',
        'Someone from @client.example.test opened Pitch wall',
      ]),
    )
  }, 30_000)
})

describe('checked again at send time', () => {
  beforeEach(async () => {
    await optIn(w.ben, w.hookId, ['mention'])
    await setBoard('private')
  })

  it('access lost after the message was queued: dropped, nothing posted', async () => {
    await mentionBen()
    expect(await statuses(w.api)).toEqual(['queued'])
    await w.owner.req('DELETE', `/api/boards/${w.boardId}/members/${w.ben.userId}`)
    await w.tick()
    expect(await deliveries(w.api)).toMatchObject([{ status: 'dropped', last_code: 'no-access' }])
    expect(w.receiver.posts).toEqual([])
  })

  it('the comment deleted, the person opted out, or the notification gone: dropped', async () => {
    const thread = await mentionBen()
    await w.owner.req('DELETE', `/api/comments/${thread.comments[0]?.id}`)
    await w.tick()
    expect((await deliveries(w.api))[0]).toMatchObject({ status: 'dropped' })
    await mentionBen('second')
    await w.ben.req('PUT', '/api/me/chat-prefs', { workspaceId: DEV_STUDIO, prefs: [] })
    await w.tick()
    expect((await deliveries(w.api)).map((d) => `${d.status}:${d.last_code}`)).toEqual([
      expect.stringMatching(/^dropped:/),
      'dropped:opted-out',
    ])
    expect(w.receiver.posts).toEqual([])
  })

  it('a hook switched off meanwhile: dropped', async () => {
    await mentionBen()
    await w.api.db.query(
      "UPDATE chat_hooks SET disabled_at = now(), disabled_reason = 'gone' WHERE id = $1",
      [w.hookId],
    )
    await w.tick()
    expect((await deliveries(w.api))[0]).toMatchObject({ status: 'dropped', last_code: 'hook-disabled' })
    expect(w.receiver.posts).toEqual([])
  })
})

describe('what each answer does', () => {
  beforeEach(async () => {
    await optIn(w.ben, w.hookId, ['mention'])
    await setBoard('workspace_edit')
  })

  it('a 5xx backs off 30 s, and the same message goes out when the time comes (one try each, never twice at once)', async () => {
    await mentionBen()
    w.receiver.next({ status: 500, body: 'oops' })
    expect(await w.tick()).toMatchObject({ claimed: 1, retried: 1 })
    const [row] = await deliveries(w.api)
    expect(row).toMatchObject({ status: 'queued', attempts: 1, last_code: '500' })
    expect(row?.next_at.getTime()).toBeGreaterThanOrEqual(w.api.clock.now().getTime() + 29_000)
    expect((await hookRow()).last_error_code).toBe('500')
    // not due yet
    expect((await w.tick()).claimed).toBe(0)
    w.api.clock.advance(31_000)
    expect(await w.tick()).toMatchObject({ claimed: 1, sent: 1 })
    expect(await deliveries(w.api)).toMatchObject([{ status: 'sent', attempts: 2, last_code: '200' }])
    expect((await hookRow()).last_error_code).toBeNull()
    expect(w.receiver.posts).toHaveLength(2)
  }, 30_000)

  it('backs off 30 s, 2 min, 10 min, 30 min, 2 h and then fails (the 6th try is the last)', async () => {
    await mentionBen()
    for (let i = 0; i < CHAT_DELIVERY.backoffMs.length; i++) {
      w.receiver.next({ status: 503 })
      await w.tick()
      const [row] = await deliveries(w.api)
      expect(row).toMatchObject({ status: 'queued', attempts: i + 1 })
      const wait = row ? row.next_at.getTime() - w.api.clock.now().getTime() : 0
      expect(Math.abs(wait - (CHAT_DELIVERY.backoffMs[i] ?? 0))).toBeLessThan(5_000)
      w.api.clock.advance((CHAT_DELIVERY.backoffMs[i] ?? 0) + 1_000)
    }
    w.receiver.next({ status: 503 })
    await w.tick()
    expect(await deliveries(w.api)).toMatchObject([{ status: 'failed', attempts: 6, last_code: '503' }])
    w.api.clock.advance(3 * 3_600_000)
    expect((await w.tick()).claimed).toBe(0)
    expect(w.receiver.posts).toHaveLength(6)
  }, 60_000)

  it('a 429 waits for Retry-After and does not use up a try', async () => {
    await mentionBen()
    w.receiver.next({ status: 429, retryAfter: 90 })
    await w.tick()
    const [row] = await deliveries(w.api)
    expect(row).toMatchObject({ status: 'queued', attempts: 0, last_code: '429' })
    const wait = (row?.next_at.getTime() ?? 0) - w.api.clock.now().getTime()
    expect(wait).toBeGreaterThan(85_000)
    expect(wait).toBeLessThan(95_000)
    w.api.clock.advance(60_000)
    expect((await w.tick()).claimed).toBe(0)
    w.api.clock.advance(31_000)
    expect(await w.tick()).toMatchObject({ sent: 1 })
  }, 30_000)

  it('a 429 never makes it wait past ten minutes', async () => {
    await mentionBen()
    w.receiver.next({ status: 429, retryAfter: 86_400 })
    await w.tick()
    const [row] = await deliveries(w.api)
    expect((row?.next_at.getTime() ?? 0) - w.api.clock.now().getTime()).toBeLessThanOrEqual(600_000)
  })

  it.each([
    [404, 'not-found'],
    [403, 'forbidden'],
    [410, 'gone'],
  ] as const)(
    'a %i switches the hook off (%s), drops what waited for it, and an admin can turn it back on',
    async (status, reason) => {
      await mentionBen()
      await mentionBen('second one')
      // the first pass takes both; the answer to the first switches the hook off, the second goes out regardless of
      // the batch already claimed — so make the second wait: it is not due yet
      await w.api.db.query(
        "UPDATE chat_deliveries SET next_at = now() + interval '1 hour' WHERE id = (SELECT max(id) FROM chat_deliveries)",
      )
      w.receiver.next({ status })
      await w.tick()
      expect(await hookRow()).toMatchObject({ disabled_reason: reason, last_error_code: String(status) })
      expect((await deliveries(w.api)).map((d) => `${d.status}:${d.last_code}`)).toEqual([
        `failed:${status}`,
        'dropped:hook-disabled',
      ])
      // nothing more is queued for it, and the list shows why
      await mentionBen('third')
      expect(await deliveries(w.api)).toHaveLength(2)
      const listed = (await w.owner.req('GET', HOOKS)).json().hooks[0]
      expect(listed).toMatchObject({ disabledReason: reason, lastErrorCode: String(status) })
      const on = await w.owner.req('PATCH', `${HOOKS}/${w.hookId}`, { enabled: true })
      expect(on.json()).toMatchObject({ disabledAt: null })
      await mentionBen('fourth')
      expect(await deliveries(w.api)).toHaveLength(3)
    },
    30_000,
  )

  it('a 400 fails at once (no retry); a redirect is refused and switches the hook off', async () => {
    await mentionBen()
    w.receiver.next({ status: 400 })
    await w.tick()
    expect(await deliveries(w.api)).toMatchObject([{ status: 'failed', attempts: 1, last_code: '400' }])
    expect((await hookRow()).disabled_at).toBeNull()
    await mentionBen('again')
    w.receiver.next({ status: 302 })
    await w.tick()
    expect((await deliveries(w.api)).at(-1)).toMatchObject({ status: 'failed', last_code: 'redirect' })
    expect((await hookRow()).disabled_reason).toBe('gone')
  }, 30_000)

  it('a receiver that never answers times out after 5 s and is tried again later', async () => {
    await mentionBen()
    w.receiver.next({ status: 200, stall: true })
    const started = Date.now()
    await w.tick()
    expect(Date.now() - started).toBeGreaterThanOrEqual(4_500)
    expect(await deliveries(w.api)).toMatchObject([{ status: 'queued', attempts: 1, last_code: 'timeout' }])
  }, 30_000)

  it('a Teams hook gets an Adaptive Card (Action.OpenUrl only) and a 202 is "sent"', async () => {
    await w.close()
    w = await chatWorld({ teams: true })
    await setBoard('workspace_edit')
    const made = await w.owner.req('POST', HOOKS, {
      name: 'Teams channel',
      provider: 'teams',
      url: teamsHookUrl(w.teams?.origin ?? ''),
    })
    expect(made.statusCode, made.body).toBe(201)
    expect(made.json().hint).toBe('….environment.api.powerplatform.com/…/•••1234')
    await optIn(w.ben, made.json().id, ['mention'])
    await mentionBen()
    await w.tick()
    const post = w.teams?.posts[0]
    expect(post?.path).toContain('/powerautomate/automations/direct/workflows/')
    const card = (
      (post?.body?.attachments ?? []) as { content: { actions: { type: string }[]; version: string } }[]
    )[0]?.content
    expect(card?.version).toBe('1.4')
    expect(card?.actions.map((a) => a.type)).toEqual(['Action.OpenUrl'])
    expect(JSON.stringify(post?.body)).not.toContain('Action.Submit')
    expect((await deliveries(w.api)).map((d) => d.status)).toContain('sent')
  }, 30_000)
})

describe('caps and the roll-up', () => {
  beforeEach(async () => {
    await optIn(w.ben, w.hookId, ['mention'])
    await setBoard('workspace_edit')
  })

  const sentRows = (n: number, recipient: string) =>
    w.api.db.query(
      `INSERT INTO chat_deliveries (hook_id, recipient_id, status, attempts, last_code, sent_at)
       SELECT $1, $2, 'sent', 1, '200', now() FROM generate_series(1, $3)`,
      [w.hookId, recipient, n],
    )

  it('past 30 an hour to one person, the message is held and one "and N more" goes out a minute later', async () => {
    await sentRows(CHAT_DELIVERY.perRecipientPerHour, w.ben.userId)
    await mentionBen('one')
    await mentionBen('two')
    await mentionBen('three')
    expect(await w.tick()).toMatchObject({ claimed: 3, coalesced: 3, sent: 0 })
    expect(w.receiver.posts).toEqual([])
    // not before the minute is up
    w.api.clock.advance(30_000)
    expect((await w.tick()).rollups).toBe(0)
    w.api.clock.advance(31_000)
    expect(await w.tick()).toMatchObject({ rollups: 1 })
    expect(w.receiver.posts).toHaveLength(1)
    expect(w.receiver.posts[0]?.body?.text).toBe('and 3 more on Pitch wall')
    const held = (await deliveries(w.api)).filter((d) => d.status === 'sent' && d.last_code === 'coalesced')
    expect(held).toHaveLength(3)
    // the roll-up is not a message that counts against the person’s hour
    await mentionBen('four')
    expect(await w.tick()).toMatchObject({ coalesced: 1 })
  }, 30_000)

  it('past 600 an hour to a workspace, everyone’s messages are held', async () => {
    await sentRows(CHAT_DELIVERY.perWorkspacePerHour, w.owner.userId)
    await mentionBen()
    expect(await w.tick()).toMatchObject({ coalesced: 1, sent: 0 })
  })

  it('a roll-up that fails is tried again; one about several boards names none', async () => {
    await sentRows(CHAT_DELIVERY.perRecipientPerHour, w.ben.userId)
    const second = await w.owner.req('POST', `/api/workspaces/${DEV_STUDIO}/boards`, { title: 'Other board' })
    const secondId = second.json().id as string
    await w.owner.req('PUT', `/api/boards/${secondId}/members/${w.ben.userId}`, { role: 'editor' })
    await mentionBen()
    await createThread(w.owner, secondId, `Hello ${mention(w.ben)}`)
    await w.tick()
    w.api.clock.advance(61_000)
    w.receiver.next({ status: 502 })
    await w.tick()
    expect((await deliveries(w.api)).filter((d) => d.status === 'coalesced')).toHaveLength(2)
    w.api.clock.advance(31_000)
    await w.tick()
    expect(w.receiver.posts.at(-1)?.body?.text).toBe('and 2 more notifications')
  }, 30_000)
})

describe('pacing, leases and the purge', () => {
  beforeEach(async () => {
    await optIn(w.ben, w.hookId, ['mention'])
    await setBoard('workspace_edit')
  })

  it('posts to one hook at most once a second', async () => {
    await mentionBen('one')
    await mentionBen('two')
    await mentionBen('three')
    await w.tick()
    expect(w.receiver.posts).toHaveLength(3)
    const gaps = w.receiver.posts.slice(1).map((p, i) => p.at - (w.receiver.posts[i]?.at ?? 0))
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(900)
  }, 30_000)

  it('takes back a row whose process died mid-send (its lease ran out) and sends it', async () => {
    await mentionBen()
    await w.api.db.query(
      "UPDATE chat_deliveries SET status = 'sending', attempts = 1, lease_until = now() - interval '1 minute'",
    )
    expect(await w.tick()).toMatchObject({ claimed: 1, sent: 1 })
  })

  it('leaves a row alone while its lease holds', async () => {
    await mentionBen()
    await w.api.db.query(
      "UPDATE chat_deliveries SET status = 'sending', attempts = 1, lease_until = now() + interval '1 minute'",
    )
    expect((await w.tick()).claimed).toBe(0)
    expect(w.receiver.posts).toEqual([])
  })

  it('purges rows older than 14 days, keeps newer ones', async () => {
    await w.api.db.query(
      `INSERT INTO chat_deliveries (hook_id, recipient_id, status, created_at)
       VALUES ($1, $2, 'failed', now() - interval '15 days'), ($1, $2, 'failed', now() - interval '13 days')`,
      [w.hookId, w.ben.userId],
    )
    await w.tick()
    expect(await deliveries(w.api)).toHaveLength(1)
  })

  it('never keeps the receiver’s words: a row holds a status code and nothing else', async () => {
    await mentionBen()
    w.receiver.next({ status: 500, body: 'channel_is_archived: #secret-project' })
    await w.tick()
    const dump = JSON.stringify(await w.api.db.query('SELECT * FROM chat_deliveries'))
    expect(dump).not.toContain('secret-project')
    expect(JSON.stringify(await w.api.db.query('SELECT * FROM chat_hooks'))).not.toContain('secret-project')
  }, 30_000)
})
