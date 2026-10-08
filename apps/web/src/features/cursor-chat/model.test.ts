// K6-4: cursor chat's pure part (./model.ts).
import {
  CURSOR_CHAT_FADE_MS,
  CURSOR_CHAT_MAX_CHARS,
  CURSOR_CHAT_RATE,
  CURSOR_CHAT_SHOW_MS,
} from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import {
  addBubble,
  type Bubble,
  ChatThrottle,
  clampText,
  cursorFor,
  failureText,
  incoming,
  MAX_BUBBLES,
  mayChat,
  messageOf,
  nextChangeAt,
  phaseOf,
} from './model.ts'

const ME = 'usr_me000000000000000'
const ALICE = 'usr_alice00000000000'
const bubble = (userId: string, since: number, text = 'hi'): Bubble => ({
  userId,
  name: userId,
  text,
  mine: false,
  sid: null,
  at: { x: 0, y: 0 },
  since,
  color: '#1d4ed8',
})

describe('who may chat', () => {
  it('people who may comment on an active board', () => {
    expect(mayChat('owner', 'active')).toBe(true)
    expect(mayChat('editor', 'active')).toBe(true)
    expect(mayChat('commenter', 'active')).toBe(true)
    expect(mayChat('viewer', 'active')).toBe(false)
    expect(mayChat('owner', 'archived')).toBe(false)
  })
})

describe('the text', () => {
  it(`keeps at most ${CURSOR_CHAT_MAX_CHARS} characters (code points), and sends nothing blank`, () => {
    expect(clampText('a'.repeat(100))).toHaveLength(CURSOR_CHAT_MAX_CHARS)
    expect([...clampText('🎉'.repeat(100))]).toHaveLength(CURSOR_CHAT_MAX_CHARS)
    expect(messageOf('  hello  ')).toBe('hello')
    expect(messageOf('   ')).toBeNull()
  })
})

describe('incoming messages', () => {
  it('parses someone else’s; skips this person’s own (shown by the tab that sent it) and anything malformed', () => {
    const data = { userId: ALICE, name: 'Alice', text: 'over here', at: { x: 1, y: 2 } }
    expect(incoming(data, ME)).toEqual(data)
    expect(incoming({ ...data, userId: ME }, ME)).toBeNull()
    for (const bad of [null, 'hi', { userId: ALICE }, { ...data, text: '' }, { ...data, userId: 'x' }])
      expect(incoming(bad, ME)).toBeNull()
  })
})

describe('which cursor a message floats at', () => {
  const peers = [
    { sid: `${ALICE}:t1`, uid: ALICE, point: { x: 0, y: 0 }, idle: true },
    { sid: `${ALICE}:t2`, uid: ALICE, point: { x: 500, y: 500 }, idle: false },
    { sid: `${ALICE}:t3`, uid: ALICE, point: null, idle: false },
    { sid: 'usr_bob00000000000000:t1', uid: 'usr_bob00000000000000', point: { x: 1, y: 1 }, idle: false },
  ]
  const all = () => true
  it('the sender’s tab nearest to where they sent it (a person with two tabs open)', () => {
    expect(cursorFor(peers, ALICE, { x: 10, y: 10 }, all)).toBe(`${ALICE}:t1`)
    expect(cursorFor(peers, ALICE, { x: 480, y: 470 }, all)).toBe(`${ALICE}:t2`)
  })
  it('without a point, one that is not idle; never someone else’s; none when no cursor of theirs is shown', () => {
    expect(cursorFor(peers, ALICE, undefined, all)).toBe(`${ALICE}:t2`)
    expect(cursorFor(peers, 'usr_carol000000000000', undefined, all)).toBeNull()
    // a facilitator hid everyone's cursors (or this page presents): the message gives no cursor away
    expect(cursorFor(peers, ALICE, { x: 0, y: 0 }, () => false)).toBeNull()
    expect(cursorFor(peers, ALICE, { x: 0, y: 0 }, (sid) => sid.endsWith('t2'))).toBe(`${ALICE}:t2`)
  })
})

describe('the bubbles', () => {
  it(`show for ${CURSOR_CHAT_SHOW_MS / 1000} s, fade for ${CURSOR_CHAT_FADE_MS} ms, then are gone`, () => {
    const b = bubble(ALICE, 1_000)
    expect(phaseOf(b, 1_000)).toBe('shown')
    expect(phaseOf(b, 1_000 + CURSOR_CHAT_SHOW_MS - 1)).toBe('shown')
    expect(phaseOf(b, 1_000 + CURSOR_CHAT_SHOW_MS)).toBe('fading')
    expect(phaseOf(b, 1_000 + CURSOR_CHAT_SHOW_MS + CURSOR_CHAT_FADE_MS)).toBe('gone')
    expect(nextChangeAt([b], 1_000)).toBe(1_000 + CURSOR_CHAT_SHOW_MS)
    expect(nextChangeAt([b], 1_000 + CURSOR_CHAT_SHOW_MS)).toBe(
      1_000 + CURSOR_CHAT_SHOW_MS + CURSOR_CHAT_FADE_MS,
    )
    expect(nextChangeAt([b], 1_000 + CURSOR_CHAT_SHOW_MS + CURSOR_CHAT_FADE_MS)).toBeNull()
    expect(nextChangeAt([], 0)).toBeNull()
  })

  it('one per person (a new message replaces the last), the gone ones dropped, at most MAX_BUBBLES', () => {
    let list = addBubble([], bubble(ALICE, 0, 'first'), 0)
    list = addBubble(list, bubble('usr_bob00000000000000', 10), 10)
    list = addBubble(list, bubble(ALICE, 20, 'second'), 20)
    expect(list.map((b) => [b.userId, b.text])).toEqual([
      ['usr_bob00000000000000', 'hi'],
      [ALICE, 'second'],
    ])
    const later = CURSOR_CHAT_SHOW_MS + CURSOR_CHAT_FADE_MS + 15
    expect(addBubble(list, bubble('usr_carol000000000000', later), later).map((b) => b.userId)).toEqual([
      ALICE,
      'usr_carol000000000000',
    ])
    let many: Bubble[] = []
    for (let i = 0; i < MAX_BUBBLES + 5; i++)
      many = addBubble(many, bubble(`usr_p${String(i).padStart(16, '0')}`, i), i)
    expect(many).toHaveLength(MAX_BUBBLES)
    expect(many[0]?.since).toBe(5)
  })
})

describe('sending', () => {
  it(`keeps to the server’s limit (${CURSOR_CHAT_RATE.max} per ${CURSOR_CHAT_RATE.windowMs / 1000} s) before sending`, () => {
    const t = new ChatThrottle()
    const taken = Array.from({ length: CURSOR_CHAT_RATE.max + 1 }, (_, i) => t.tryTake(i))
    expect(taken).toEqual([...Array(CURSOR_CHAT_RATE.max).fill(true), false])
    expect(t.tryTake(CURSOR_CHAT_RATE.windowMs + 1)).toBe(true)
  })

  it('says why a message was not sent, in words', () => {
    expect(failureText({ status: 429 })).toMatch(/a lot of messages/)
    expect(failureText({ status: 403 })).toMatch(/can’t chat/)
    expect(failureText({ status: 404 })).toMatch(/isn’t available/)
    expect(failureText(null)).toMatch(/not sent/)
  })
})
