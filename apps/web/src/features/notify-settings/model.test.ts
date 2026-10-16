// The words and the pure steps of the chat notification settings (wave R, WS2).
import { CHAT_HOOK_KINDS, type ChatHook } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import { ChatHookRequestError } from './client.ts'
import {
  ADMIN_WARNING,
  CHANNEL_NOTE,
  chosenFrom,
  errorCodeText,
  HOW_TO,
  hookStatusLine,
  KIND_LABEL,
  OFF_TEXT,
  PROVIDER_LABEL,
  prefsInput,
  requestErrorText,
  sameChoice,
  testResultText,
  toggled,
} from './model.ts'

const W = 'wsp_0123456789abcdefghij'
const A = 'chk_aaaaaaaaaaaaaaaaaaaa'
const B = 'chk_bbbbbbbbbbbbbbbbbbbb'

const hook = (over: Partial<ChatHook> = {}): ChatHook => ({
  id: A,
  name: '#a',
  provider: 'slack',
  hint: 'hooks.slack.com/…/•••1234',
  includeSnippets: false,
  createdBy: null,
  createdAt: '2026-10-16T10:00:00.000Z',
  disabledAt: null,
  disabledReason: null,
  lastOkAt: null,
  lastErrorCode: null,
  ...over,
})

describe('the words', () => {
  it('every kind has its label, every provider its name and its steps', () => {
    for (const k of CHAT_HOOK_KINDS) expect(KIND_LABEL[k].length).toBeGreaterThan(10)
    expect(PROVIDER_LABEL).toEqual({ slack: 'Slack', teams: 'Microsoft Teams' })
    expect(HOW_TO.slack.join(' ')).toContain('hooks.slack.com/services')
    expect(HOW_TO.teams.join(' ')).toContain('Workflows')
  })

  it('warns that a channel’s audience is wider than the board’s, in the settings and next to each person’s choice', () => {
    expect(ADMIN_WARNING).toMatch(/guests of that channel/)
    expect(ADMIN_WARNING).toMatch(/private boards/)
    expect(CHANNEL_NOTE).toMatch(/Everyone in the channel/)
  })

  it('a hook’s line says when it last sent, why it is off, or that it failed', () => {
    const now = new Date('2026-10-16T10:05:00.000Z')
    expect(hookStatusLine(hook(), now)).toBe('Not used yet.')
    expect(hookStatusLine(hook({ lastOkAt: '2026-10-16T10:00:00.000Z' }), now)).toBe('Last sent 5 min ago.')
    expect(hookStatusLine(hook({ lastOkAt: '2026-10-16T10:00:00.000Z', lastErrorCode: '503' }), now)).toBe(
      'Last sent 5 min ago. Last try failed: it had a problem (503).',
    )
    expect(
      hookStatusLine(hook({ disabledAt: '2026-10-16T10:01:00.000Z', disabledReason: 'not-found' }), now),
    ).toBe('Switched off: Slack could not find the channel or webhook (was it deleted?).')
    expect(
      hookStatusLine(
        hook({ provider: 'teams', disabledAt: '2026-10-16T10:01:00.000Z', disabledReason: 'forbidden' }),
        now,
      ),
    ).toContain('Microsoft Teams refused')
  })

  it('codes are put in words, never shown raw as the receiver’s own', () => {
    expect(errorCodeText('timeout')).toBe('it did not answer in time')
    expect(errorCodeText('unsealed')).toMatch(/paste it again/)
    expect(errorCodeText('429')).toMatch(/slow down/)
    expect(errorCodeText('418')).toBe('it answered 418')
  })

  it('"sent" is never "delivered" (a Teams 202 only means queued there)', () => {
    expect(testResultText({ status: 'sent', code: null }, 'slack')).toBe(
      'Test message sent. Look for it in the channel.',
    )
    expect(testResultText({ status: 'sent', code: null }, 'teams')).toMatch(/can take a minute/)
    expect(testResultText({ status: 'sent', code: null }, 'slack')).not.toMatch(/delivered/i)
    expect(testResultText({ status: 'failed', code: '404' }, 'slack')).toBe(
      'The test message was not accepted: it answered 404.',
    )
  })

  it('an error says the api’s own words, or the off text, or a fallback', () => {
    expect(requestErrorText(new ChatHookRequestError('unavailable'), 'x')).toBe(OFF_TEXT)
    expect(requestErrorText(new ChatHookRequestError('CHAT_HOOKS_OFF', 404, 'whatever'), 'x')).toBe(OFF_TEXT)
    expect(
      requestErrorText(new ChatHookRequestError('CHAT_HOOK_URL_INVALID', 400, 'Not a Slack URL.'), 'x'),
    ).toBe('Not a Slack URL.')
    expect(requestErrorText(new ChatHookRequestError('NETWORK', 0), 'Try again.')).toBe('Try again.')
    expect(requestErrorText(new ChatHookRequestError('CREATOR_REQUIRED', 403), 'x')).toMatch(/creators/)
  })
})

describe('the choice', () => {
  it('toggling keeps the contract’s order and one entry per kind', () => {
    let c = chosenFrom({ hooks: [], prefs: [{ hookId: A, kinds: ['reply'] }] })
    c = toggled(c, A, 'mention', true)
    c = toggled(c, A, 'mention', true)
    expect(c[A]).toEqual(['mention', 'reply'])
    c = toggled(c, A, 'reply', false)
    expect(c[A]).toEqual(['mention'])
    expect(toggled({}, B, 'new_comment', true)[B]).toEqual(['new_comment'])
  })

  it('what is sent is the whole choice for the hooks shown, a hook with nothing chosen left out', () => {
    const c = { [A]: ['mention' as const], [B]: [] as never[] }
    expect(prefsInput(W, [A, B], c)).toEqual({ workspaceId: W, prefs: [{ hookId: A, kinds: ['mention'] }] })
    expect(prefsInput(W, [], c)).toEqual({ workspaceId: W, prefs: [] })
  })

  it('sameChoice compares per hook', () => {
    expect(sameChoice({ [A]: ['mention'] }, { [A]: ['mention'] }, [A])).toBe(true)
    expect(sameChoice({ [A]: ['mention'] }, {}, [A])).toBe(false)
    expect(sameChoice({ [B]: ['mention'] }, {}, [A])).toBe(true)
  })
})
