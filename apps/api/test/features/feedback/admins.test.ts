// DRAFTROOM_FEEDBACK_ADMINS (apps/api/src/features/feedback/admins.ts): parsed like the creator exceptions,
// failing closed, never echoing an address.
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../../src/config.ts'
import { MAX_FEEDBACK_ADMINS, parseFeedbackAdmins } from '../../../src/features/feedback/admins.ts'
import { testEnv } from '../../helpers.ts'

const parse = (value: string | undefined) => parseFeedbackAdmins({ DRAFTROOM_FEEDBACK_ADMINS: value })

describe('DRAFTROOM_FEEDBACK_ADMINS', () => {
  it('unset or blank: nobody', () => {
    expect(parseFeedbackAdmins({})).toEqual([])
    expect(parse('')).toEqual([])
    expect(parse('   ')).toEqual([])
    expect(parse(' , ,')).toEqual([])
  })

  it('a comma list of exact addresses, trimmed, ASCII-lowercased and de-duplicated', () => {
    expect(parse('Chase@Darkburn.com, lead@trailerparkgroup.com ,chase@darkburn.com')).toEqual([
      'chase@darkburn.com',
      'lead@trailerparkgroup.com',
    ])
    // not normalised further: dots and tags are part of the address
    expect(parse('a.b+tag@gmail.com')).toEqual(['a.b+tag@gmail.com'])
  })

  it('refuses what is not an address, naming the entry and never the value', () => {
    for (const [value, entry] of [
      ['not-an-address', 1],
      ['ok@darkburn.com, nobody', 2],
      ['ok@darkburn.com,@darkburn.com', 2],
      ['ok@darkburn.com,two words@darkburn.com', 2],
      [`ok@darkburn.com,caf${String.fromCodePoint(0xe9)}@darkburn.com`, 2],
      ['ok@darkburn.com,pat+clerk_test@darkburn.com', 2],
      ['ok@darkburn.com,pat@', 2],
    ] as const) {
      let message = ''
      try {
        parse(value)
      } catch (e) {
        message = (e as Error).message
      }
      expect(message, value).toBe(`DRAFTROOM_FEEDBACK_ADMINS entry ${entry} is not a valid email address`)
    }
  })

  it(`at most ${MAX_FEEDBACK_ADMINS} addresses`, () => {
    const list = (n: number) => Array.from({ length: n }, (_, i) => `p${i}@darkburn.com`).join(',')
    expect(parse(list(MAX_FEEDBACK_ADMINS))).toHaveLength(MAX_FEEDBACK_ADMINS)
    expect(() => parse(list(MAX_FEEDBACK_ADMINS + 1))).toThrow(/lists more than 25 addresses/)
  })

  it('is part of the api config (a bad value stops the api from starting)', () => {
    expect(loadConfig(testEnv('/tmp/x')).feedbackAdmins).toEqual([])
    expect(
      loadConfig(testEnv('/tmp/x', { DRAFTROOM_FEEDBACK_ADMINS: 'A@b.example' })).feedbackAdmins,
    ).toEqual(['a@b.example'])
    expect(() => loadConfig(testEnv('/tmp/x', { DRAFTROOM_FEEDBACK_ADMINS: 'nope' }))).toThrow(
      'DRAFTROOM_FEEDBACK_ADMINS entry 1 is not a valid email address',
    )
  })
})
