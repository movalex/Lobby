// K6-4: the cursor-chat request and event (./cursor-chat.ts).
import { describe, expect, it } from 'vitest'
import {
  CURSOR_CHAT_EVENT,
  CURSOR_CHAT_MAX_CHARS,
  CursorChatEvent,
  CursorChatInput,
  cursorChatPath,
} from './index.ts'

describe('CursorChatInput', () => {
  it('takes a short line and a scene point, and drops any other key (authorship is the session’s)', () => {
    const parsed = CursorChatInput.parse({
      text: 'Love this direction',
      at: { x: 120.5, y: -40 },
      userId: 'usr_someoneElse0000',
      name: 'Mallory',
    })
    expect(parsed).toEqual({ text: 'Love this direction', at: { x: 120.5, y: -40 } })
    expect(CursorChatInput.parse({ text: 'hi' })).toEqual({ text: 'hi' })
  })

  it('cleans the text like every display string: control, bidi and zero-width characters out, spaces folded, trimmed', () => {
    expect(CursorChatInput.parse({ text: '  look‮ here​\n\tnow  ' }).text).toBe('look here now')
    // ordinary non-ASCII text and emoji sequences stay
    expect(CursorChatInput.parse({ text: 'Très bien 👩‍💻 مرحبا' }).text).toBe('Très bien 👩‍💻 مرحبا')
  })

  it(`is 1..${CURSOR_CHAT_MAX_CHARS} characters after cleaning (code points, so emoji count once)`, () => {
    expect(CursorChatInput.safeParse({ text: '' }).success).toBe(false)
    expect(CursorChatInput.safeParse({ text: ' ​‮ ' }).success).toBe(false) // nothing left
    expect(CursorChatInput.safeParse({ text: 'a'.repeat(CURSOR_CHAT_MAX_CHARS) }).success).toBe(true)
    expect(CursorChatInput.safeParse({ text: 'a'.repeat(CURSOR_CHAT_MAX_CHARS + 1) }).success).toBe(false)
    expect(CursorChatInput.safeParse({ text: '🎉'.repeat(CURSOR_CHAT_MAX_CHARS) }).success).toBe(true)
    expect(CursorChatInput.safeParse({ text: `${'a'.repeat(79)}  ` }).success).toBe(true) // trimmed first
    expect(CursorChatInput.safeParse({ text: 'x'.repeat(5_000) }).success).toBe(false)
  })

  it('refuses what is not a message: no text, a non-string, a bad point', () => {
    for (const body of [
      {},
      { text: 42 },
      { text: ['hi'] },
      { text: 'hi', at: { x: Number.NaN, y: 0 } },
      { text: 'hi', at: { x: 1e9, y: 0 } },
      { text: 'hi', at: { x: '1', y: 0 } },
      null,
    ])
      expect(CursorChatInput.safeParse(body).success, JSON.stringify(body)).toBe(false)
  })
})

describe('CursorChatEvent', () => {
  it('parses what the api publishes, and refuses what it never would', () => {
    const event = {
      userId: 'usr_alice000000000000',
      name: 'Alice Moreno',
      text: 'over here',
      at: { x: 1, y: 2 },
    }
    expect(CursorChatEvent.parse(event)).toEqual(event)
    expect(CursorChatEvent.safeParse({ ...event, at: undefined }).success).toBe(true)
    expect(CursorChatEvent.safeParse({ ...event, userId: 'alice' }).success).toBe(false)
    expect(CursorChatEvent.safeParse({ ...event, text: '' }).success).toBe(false)
    expect(CursorChatEvent.safeParse({ ...event, text: 'a'.repeat(CURSOR_CHAT_MAX_CHARS + 1) }).success).toBe(
      false,
    )
  })

  it('has its own event type and route', () => {
    expect(CURSOR_CHAT_EVENT).toBe('cursor.chat')
    expect(cursorChatPath('brd_abc')).toBe('/api/boards/brd_abc/cursor-chat')
  })
})
