// The messages that are not one event (wave R, WS2; contracts chat-hooks.ts): the test message and the roll-up of what a
// cap held back. Same rules as every other message: escaped per provider, unfurling off, only Action.OpenUrl.
import { describe, expect, it } from 'vitest'
import {
  CHAT_HIDDEN_BOARD_TITLE,
  CHAT_HOOK_LIMITS,
  type ChatNotice,
  chatRollupSentence,
  slackNoticePayload,
  teamsNoticePayload,
} from './chat-hooks.ts'

const notice = (text: string): ChatNotice => ({
  text,
  link: 'https://lobby.example/w/wsp_abc',
  workspaceName: 'DBC Pitches',
})

describe('the roll-up sentence', () => {
  it('says "and N more" on one board, or "notifications" when no single board can be named', () => {
    expect(chatRollupSentence(12, 'Pitch wall')).toBe('and 12 more on Pitch wall')
    expect(chatRollupSentence(2, null)).toBe('and 2 more notifications')
    expect(chatRollupSentence(1, null)).toBe('and 1 more notification')
    expect(chatRollupSentence(0, null)).toBe('and 1 more notification')
    expect(chatRollupSentence(3, CHAT_HIDDEN_BOARD_TITLE)).toBe('and 3 more on a private board')
  })

  it('cuts a long title like every other message', () => {
    const sentence = chatRollupSentence(5, 'x'.repeat(1_000_000))
    expect([...sentence].length).toBeLessThan(CHAT_HOOK_LIMITS.titleChars + 30)
  })
})

describe('notice payloads', () => {
  it('Slack: escaped in the blocks and the fallback text, unfurling off, a link back', () => {
    const payload = slackNoticePayload(notice('and 3 more on <!channel> & <https://evil.example|x>'))
    expect(payload).toMatchObject({ unfurl_links: false, unfurl_media: false })
    const json = JSON.stringify(payload)
    expect(json).not.toContain('<!channel>')
    expect(json).not.toContain('<https://evil.example')
    expect(payload.text).toBe('and 3 more on &lt;!channel&gt; &amp; &lt;https://evil.example|x&gt;')
    expect(json).toContain('<https://lobby.example/w/wsp_abc|Open in Lobby>')
    expect(json).toContain('Lobby · DBC Pitches')
  })

  it('Teams: an Adaptive Card 1.4 with only Action.OpenUrl, markdown escaped, under 25 KB', () => {
    const payload = teamsNoticePayload(notice('and 3 more on *bold* [x](https://evil.example)'))
    const json = JSON.stringify(payload)
    expect(json).toContain('"version":"1.4"')
    expect(json).toContain('Action.OpenUrl')
    expect(json).not.toContain('Action.Submit')
    expect(json).not.toContain('[x](')
    expect(json).toContain('\\\\*bold\\\\*')
    expect(JSON.stringify(teamsNoticePayload(notice('y'.repeat(1_000_000)))).length).toBeLessThan(
      CHAT_HOOK_LIMITS.teamsCardBytes,
    )
  })
})
