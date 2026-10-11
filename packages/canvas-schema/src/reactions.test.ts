// Wave N (LM-10, N2-2): the reaction key class `react:<code>:<uid>` (custom-data.ts, reactions.ts, limits.ts).

import { REACTION_CODE_EMOJI, REACTION_CODES, REACTION_EMOJIS, reactionCodeOf } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import { checkLobbyData, lobbyKeySpec, lobbyValueProblem, PLUS_ONE_KEY_PREFIX } from './custom-data.ts'
import { checkElement, type WireElement } from './elements.ts'
import {
  jsonByteLength,
  MAX_UID_CHARS,
  PLUS_ONES_MAX,
  REACTIONS_BUDGET_BYTES,
  REACTIONS_MAX,
} from './limits.ts'
import {
  identityUidOf,
  isReactionKey,
  parseReactionKey,
  REACTION_KEY_PREFIX,
  reactionKey,
  reactionsOf,
} from './reactions.ts'
import { SAMPLE_ELEMENTS } from './test-samples.ts'

const U = 'usr_0123456789'

describe('the reaction codes (contracts workshops.ts)', () => {
  it('six codes, one per relayed emoji, in the reaction bar order', () => {
    expect(REACTION_CODES).toEqual(['up', 'heart', 'laugh', 'party', 'think', 'clap'])
    expect(REACTION_CODES.map((c) => REACTION_CODE_EMOJI[c])).toEqual([...REACTION_EMOJIS])
    for (const c of REACTION_CODES) expect(reactionCodeOf(REACTION_CODE_EMOJI[c])).toBe(c)
    expect(reactionCodeOf('👍🏽')).toBeNull()
  })
})

describe('react:<code>:<uid> keys', () => {
  it('reactionKey and parseReactionKey round-trip every code; identityUidOf reads +1s and reactions', () => {
    for (const code of REACTION_CODES) {
      const k = reactionKey(code, U)
      expect(k).toBe(`react:${code}:${U}`)
      expect(parseReactionKey(k)).toEqual({ code, uid: U })
      expect(identityUidOf(k)).toBe(U)
      expect(isReactionKey(k)).toBe(true)
    }
    expect(identityUidOf(`${PLUS_ONE_KEY_PREFIX}${U}`)).toBe(U)
    expect(identityUidOf('plusOne:')).toBeNull()
    for (const k of [
      'tag:x',
      'present',
      'react:',
      'react:up',
      'react:up:',
      'react:wow:usr_1',
      'react::usr_1',
    ])
      expect(identityUidOf(k), k).toBeNull()
    // a uid may itself hold a colon (everything after the code's colon)
    expect(parseReactionKey('react:up:a:b')).toEqual({ code: 'up', uid: 'a:b' })
    expect(REACTION_KEY_PREFIX).toBe('react:')
  })

  it('the spec: identity-bound, value true, strip on duplicate, lock-exempt own', () => {
    const spec = lobbyKeySpec(reactionKey('up', U))
    expect(spec).toMatchObject({
      match: 'prefix',
      name: 'react:',
      class: 'identity-bound',
      duplicate: 'strip',
      lockExempt: 'own',
      maxBytes: 32,
    })
    expect(lobbyKeySpec('react:')).toBeNull()
  })

  it('valid keys and values, and every malformed form INVALID', () => {
    expect(lobbyValueProblem(reactionKey('heart', U), true)).toBeNull()
    expect(lobbyValueProblem(reactionKey('clap', 'u'.repeat(MAX_UID_CHARS)), true)).toBeNull()
    const bad: [string, unknown][] = [
      ['react:wow:usr_1', true], // an unknown code
      ['react:UP:usr_1', true],
      ['react:up:', true], // an empty uid
      ['react:up', true], // no uid at all
      [`react:up:${'u'.repeat(MAX_UID_CHARS + 1)}`, true], // a 61-character uid
      [reactionKey('up', U), false], // a value that is not true
      [reactionKey('up', U), 1],
      [reactionKey('up', U), 'true'],
      [reactionKey('up', U), null],
    ]
    for (const [k, v] of bad) expect(lobbyValueProblem(k, v), `${k} = ${String(v)}`).not.toBeNull()
    expect(checkLobbyData({ 'react:wow:usr_1': true })).toMatchObject({ ok: false, code: 'INVALID' })
  })

  it('budgets: 120 per element (the 121st INVALID), within 6 KiB (TOO_LARGE past it)', () => {
    const lobby: Record<string, unknown> = {}
    for (let i = 0; i < REACTIONS_MAX; i++)
      lobby[
        reactionKey(
          REACTION_CODES[i % 6] as (typeof REACTION_CODES)[number],
          `u${String(i).padStart(4, '0')}`,
        )
      ] = true
    expect(checkLobbyData(lobby)).toEqual({ ok: true })
    expect(checkLobbyData({ ...lobby, [reactionKey('up', 'u9999')]: true })).toMatchObject({
      ok: false,
      code: 'INVALID',
    })
    const long: Record<string, unknown> = {}
    for (let i = 0; i < 100; i++) long[reactionKey('laugh', `u${i}`.padEnd(MAX_UID_CHARS, 'x'))] = true
    expect(jsonByteLength(long)).toBeGreaterThan(REACTIONS_BUDGET_BYTES)
    expect(checkLobbyData(long)).toMatchObject({ ok: false, code: 'TOO_LARGE' })
    expect(REACTIONS_MAX).toBe(120)
    expect(REACTIONS_BUDGET_BYTES).toBe(6 * 1024)
  })

  it('reactions have their own budget: a note with 200 +1s, its reactions at budget and 8 KiB of the rest fits', () => {
    const lobby: Record<string, unknown> = {}
    for (let i = 0; i < PLUS_ONES_MAX; i++) lobby[`plusOne:${`u${i}`.padEnd(MAX_UID_CHARS, 'x')}`] = true
    const react: Record<string, unknown> = {}
    for (let i = 0; jsonByteLength(react) < REACTIONS_BUDGET_BYTES - 120; i++)
      react[reactionKey('think', `u${i}`.padEnd(40, 'x'))] = true
    Object.assign(lobby, react, { alt: 'x'.repeat(500) })
    expect(checkLobbyData(lobby)).toEqual({ ok: true })
    const el = {
      ...(SAMPLE_ELEMENTS.stickynote as WireElement),
      customData: { lobby },
    } as WireElement
    expect(checkElement(el).ok).toBe(true)
  })

  it('reactionsOf: by code in REACTION_CODES order, uids sorted, malformed and non-true keys ignored', () => {
    expect(reactionsOf(undefined)).toEqual([])
    expect(
      reactionsOf({
        [reactionKey('clap', 'b')]: true,
        [reactionKey('up', 'z')]: true,
        [reactionKey('up', 'a')]: true,
        'react:wow:x': true,
        [reactionKey('heart', 'q')]: false,
        'plusOne:a': true,
      }),
    ).toEqual([
      { code: 'up', uids: ['a', 'z'] },
      { code: 'clap', uids: ['b'] },
    ])
  })
})
