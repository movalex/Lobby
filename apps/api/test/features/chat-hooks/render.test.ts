// A message built from current rows (wave R, WS2; src/features/chat-hooks/render.ts): who and what it names, what it
// leaves out, and that no string in it can ping a channel or break a link.

import { CHAT_HIDDEN_BOARD_TITLE, CHAT_HOOK_LIMITS } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import {
  boardLink,
  isChatKind,
  messageFor,
  noticePayloadFor,
  payloadFor,
  titleFor,
  workspaceLink,
} from '../../../src/features/chat-hooks/render.ts'
import type { NotificationRow } from '../../../src/features/comments/notifications.ts'

const row = (over: Partial<NotificationRow> = {}): NotificationRow => ({
  id: 'ntf_0123456789abcdef',
  kind: 'mention',
  board_id: 'b-abc1234567',
  thread_id: 'thr_0123456789abcdef',
  comment_id: 'cmt_0123456789abcdef',
  created_at: new Date(0),
  read_at: null,
  board_title: 'Pitch wall',
  visibility: 'workspace_edit',
  status: 'active',
  workspace_role: 'member',
  board_grant: null,
  actor_id: 'usr_0123456789abcdef',
  actor_name: 'Ana',
  actor_color: '#123456',
  comment_body: 'Looks good to me',
  comment_deleted_at: null,
  request_role: null,
  request_message: null,
  request_status: null,
  granted_role: null,
  thread_visibility: 'everyone',
  recipient_kind: 'account',
  actor_domain: null,
  review_kind: null,
  review_status: null,
  review_reason: null,
  review_item_id: null,
  review_item_count: null,
  review_label: null,
  review_round_title: null,
  ...over,
})

const input = (r: NotificationRow, over: Partial<Parameters<typeof messageFor>[0]> = {}) => ({
  row: r,
  recipientName: 'Ben',
  workspaceName: 'DBC Pitches',
  includeText: false,
  origin: 'https://lobby.example',
  ...over,
})

describe('the title', () => {
  it('a private board’s title is hidden unless the hook allows it; other boards show theirs', () => {
    expect(titleFor(row({ visibility: 'private' }), false)).toBe(CHAT_HIDDEN_BOARD_TITLE)
    expect(titleFor(row({ visibility: 'private' }), true)).toBe('Pitch wall')
    expect(titleFor(row({ visibility: 'workspace_view' }), false)).toBe('Pitch wall')
    expect(titleFor(row({ visibility: 'workspace_edit', board_title: '  ' }), false)).toBe('Untitled')
  })
})

describe('the message', () => {
  it('names the event, both people, the board, and links back with the thread', () => {
    const m = messageFor(input(row()))
    expect(m).toMatchObject({
      kind: 'mention',
      actor: 'Ana',
      target: 'Ben',
      boardTitle: 'Pitch wall',
      link: 'https://lobby.example/b/b-abc1234567?thread=thr_0123456789abcdef',
      workspaceName: 'DBC Pitches',
    })
    expect(m).not.toHaveProperty('snippet')
    expect(boardLink('https://lobby.example', 'b-x', null)).toBe('https://lobby.example/b/b-x')
    expect(workspaceLink('https://lobby.example', 'wsp_abc')).toBe('https://lobby.example/w/wsp_abc')
  })

  it('has a snippet only with the switch on, for comment kinds, and never from a team-only thread', () => {
    expect(messageFor(input(row(), { includeText: true }))?.snippet).toBe('Looks good to me')
    const team = messageFor(input(row({ thread_visibility: 'team' }), { includeText: true }))
    expect(team).not.toHaveProperty('snippet')
    const none = messageFor(input(row({ thread_visibility: null }), { includeText: true }))
    expect(none).not.toHaveProperty('snippet')
    const long = messageFor(input(row({ comment_body: 'word '.repeat(100) }), { includeText: true }))
    expect([...(long?.snippet ?? '')].length).toBeLessThanOrEqual(CHAT_HOOK_LIMITS.snippetChars)
    // an access request's own message is never in a channel
    const request = messageFor(
      input(
        row({
          kind: 'access_request',
          thread_id: null,
          comment_id: null,
          comment_body: null,
          request_role: 'editor',
          request_message: 'a private reason',
        }),
        { includeText: true },
      ),
    )
    expect(request).toMatchObject({ kind: 'access_request', role: 'editor' })
    expect(JSON.stringify(request)).not.toContain('private reason')
  })

  it('an outsider is named by the domain only; kinds that stay in the bell make no message', () => {
    const outsider = messageFor(
      input(row({ kind: 'outsider_joined', actor_domain: 'agency.com', thread_id: null })),
    )
    expect(outsider?.actor).toBe('agency.com')
    expect(isChatKind('resolved')).toBe(false)
    expect(isChatKind('access_granted')).toBe(false)
    expect(messageFor(input(row({ kind: 'resolved' })))).toBeNull()
  })

  it('cleans names and cannot ping a channel (Slack escapes the fallback text too, Teams escapes markdown)', () => {
    const m = messageFor(input(row({ actor_name: '<!channel>‮ *Ana*​', board_title: '<!here>' })))
    if (!m) throw new Error('no message')
    const slack = payloadFor('slack', m) as { text: string }
    expect(slack.text).toContain('&lt;!channel&gt;')
    expect(slack.text).not.toMatch(/[‮​]/)
    expect(JSON.stringify(slack)).not.toContain('<!channel>')
    expect(JSON.stringify(slack)).not.toContain('<!here>')
    const teams = JSON.stringify(payloadFor('teams', m))
    expect(teams).toContain('\\\\*Ana\\\\*')
    expect(teams).toContain('Action.OpenUrl')
  })

  it('a 1 MB title and a 1 MB name stay inside the limits', () => {
    const big = 'x'.repeat(1_000_000)
    const m = messageFor(input(row({ actor_name: big, board_title: big })))
    if (!m) throw new Error('no message')
    expect(JSON.stringify(payloadFor('slack', m)).length).toBeLessThan(3_600)
    expect(JSON.stringify(payloadFor('teams', m)).length).toBeLessThan(CHAT_HOOK_LIMITS.teamsCardBytes)
  })

  it('notices (a test, a roll-up) carry one sentence and the workspace link', () => {
    const slack = noticePayloadFor('slack', {
      text: 'and 3 more on <!channel>',
      link: 'https://l.example/w/x',
      workspaceName: 'W',
    })
    expect(JSON.stringify(slack)).toContain('and 3 more on &lt;!channel&gt;')
    expect(slack).toMatchObject({ unfurl_links: false, unfurl_media: false })
  })
})
