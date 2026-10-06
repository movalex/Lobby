// Domain access, the pure policy (docs/DOMAIN-ACCESS-CONTRACTS.md §2, §11.1 policy.test.ts): exact
// ASCII matching on the text after the last "@", no look-alikes, never a Clerk test-mode address,
// and config errors that name the variable and the entry, never the value.

import { describe, expect, it } from 'vitest'
import {
  type CreatorPolicy,
  creatorReason,
  DEFAULT_CREATOR_DOMAINS,
  DEV_CREATOR_DOMAIN,
  devDomainFor,
  emailDomain,
  isCreatorEmail,
  normalizeEmail,
  parseCreatorPolicy,
} from '../../../src/auth/creators.ts'

const policy: CreatorPolicy = {
  domains: [...DEFAULT_CREATOR_DOMAINS],
  emails: ['owner@personal.example.test'],
}

/** Normalise like every entry point does, then match (null never matches). */
const creator = (raw: string, devDomain: string | null = null) => {
  const e = normalizeEmail(raw)
  return e !== null && isCreatorEmail(e, policy, devDomain)
}

describe('creator matching (exact, ASCII, last "@")', () => {
  it.each(['lobby-test-a@darkburn.com', 'lobby-test-b@trailerparkgroup.com', 'lobby-test-c@trailerpark.com'])(
    '%s is a creator address',
    (email) => {
      expect(creator(email)).toBe(true)
    },
  )

  it('upper case and surrounding spaces normalise', () => {
    expect(normalizeEmail('  Lobby-Test-A@DarkBurn.COM ')).toBe('lobby-test-a@darkburn.com')
    expect(creator('  Lobby-Test-A@DarkBurn.COM ')).toBe(true)
    expect(creator('LOBBY-TEST@TRAILERPARKGROUP.COM')).toBe(true)
  })

  it.each([
    ['a subdomain', 'lobby-test@sub.darkburn.com'],
    ['a prefix', 'lobby-test@evil-darkburn.com'],
    ['a suffix', 'lobby-test@darkburn.com.evil.test'],
    ['a shorter TLD', 'lobby-test@darkburn.co'],
    ['a trailing dot', 'lobby-test@darkburn.com.'],
    ['a subdomain of trailerpark.com', 'lobby-test@sub.trailerpark.com'],
    ['a suffix of trailerpark.com', 'lobby-test@trailerpark.com.evil.test'],
    ['a quoted local part carrying the domain', '"x@darkburn.com"@evil.test'],
    ['two "@"', 'a@b@evil.test'],
  ])('%s is refused (%s)', (_what, email) => {
    expect(creator(email)).toBe(false)
  })

  it('the domain is the text after the LAST "@"', () => {
    expect(emailDomain('"a@darkburn.com"@evil.test')).toBe('evil.test')
    expect(emailDomain('a@b@evil.test')).toBe('evil.test')
  })

  it.each([
    ['the Kelvin sign (U+212A) for "k"', 'lobby-test@darKburn.com'.replace('K', 'K')],
    ['a Cyrillic "а" (U+0430)', 'lobby-test@dаrkburn.com'],
    ['a fullwidth "＠" (U+FF20)', 'lobby-test＠darkburn.com'],
    ['a dotted capital I (U+0130)', 'lobby-test@trailerparkgroup.com'.replace('i', 'İ')],
    ['a punycode look-alike', 'lobby-test@xn--drkburn-9ya.com'],
  ])('look-alikes never match: %s', (_what, email) => {
    expect(creator(email)).toBe(false)
  })

  it('non-ASCII addresses are dropped entirely (normalizeEmail answers null)', () => {
    expect(normalizeEmail('lobby-test@darKburn.com'.replace('K', 'K'))).toBeNull()
    expect(normalizeEmail('lobby-test＠darkburn.com')).toBeNull()
    expect(normalizeEmail('lobby test@darkburn.com')).toBeNull()
    expect(normalizeEmail('')).toBeNull()
    expect(normalizeEmail('@darkburn.com')).toBeNull()
    expect(normalizeEmail('lobby-test@')).toBeNull()
    expect(normalizeEmail('no-at-sign')).toBeNull()
    expect(normalizeEmail(`${'a'.repeat(250)}@b.co`)).toBeNull()
  })

  it.each([
    'anyone+clerk_test@darkburn.com',
    'Anyone+CLERK_TEST@darkburn.com',
    'x+Clerk_Test@trailerparkgroup.com',
  ])('Clerk test-mode addresses never count: %s', (email) => {
    expect(normalizeEmail(email)).toBeNull()
    expect(creator(email)).toBe(false)
  })

  it('exceptions compare the whole address: owner+x@… is not owner@…', () => {
    expect(creator('owner@personal.example.test')).toBe(true)
    expect(creator('Owner@Personal.Example.Test')).toBe(true)
    expect(creator('owner+x@personal.example.test')).toBe(false)
    expect(creator('other@personal.example.test')).toBe(false)
  })

  it('the dev domain only counts under the dev provider', () => {
    expect(devDomainFor('dev')).toBe(DEV_CREATOR_DOMAIN)
    expect(devDomainFor('clerk')).toBeNull()
    expect(creator('alice@dev.invalid', devDomainFor('dev'))).toBe(true)
    expect(creator('alice@dev.invalid', devDomainFor('clerk'))).toBe(false)
    expect(creator('alice@dev.invalid')).toBe(false)
  })

  it('creatorReason: domain before exception before dev, else null', () => {
    const dev = devDomainFor('dev')
    expect(creatorReason(['x@client.example.test'], policy, dev)).toBeNull()
    expect(creatorReason(['alice@dev.invalid'], policy, dev)).toBe('dev')
    expect(creatorReason(['owner@personal.example.test', 'alice@dev.invalid'], policy, dev)).toBe('exception')
    expect(
      creatorReason(
        ['alice@dev.invalid', 'owner@personal.example.test', 'lobby-test@darkburn.com'],
        policy,
        dev,
      ),
    ).toBe('domain')
  })
})

describe('parseCreatorPolicy', () => {
  it('defaults: the three built-in domains, no exceptions (unset or blank)', () => {
    const expected = { domains: ['darkburn.com', 'trailerparkgroup.com', 'trailerpark.com'], emails: [] }
    expect(parseCreatorPolicy({})).toEqual(expected)
    expect(parseCreatorPolicy({ DRAFTROOM_CREATOR_DOMAINS: '  ', DRAFTROOM_CREATOR_EMAILS: '' })).toEqual(
      expected,
    )
  })

  it('parses lists: trims, ignores empty entries, dedupes, ASCII-lowercases', () => {
    expect(
      parseCreatorPolicy({
        DRAFTROOM_CREATOR_DOMAINS: ' Example.TEST, other.example.test ,, example.test,',
        DRAFTROOM_CREATOR_EMAILS: 'Owner@Personal.Example.Test, owner@personal.example.test,',
      }),
    ).toEqual({ domains: ['example.test', 'other.example.test'], emails: ['owner@personal.example.test'] })
  })

  const secret = 'secret-value-never-echoed'
  it.each([
    [
      { DRAFTROOM_CREATOR_DOMAINS: `darkburn.com,${secret}` },
      'DRAFTROOM_CREATOR_DOMAINS entry 2 is not a valid domain',
    ],
    [
      { DRAFTROOM_CREATOR_DOMAINS: `*.${secret}.com` },
      'DRAFTROOM_CREATOR_DOMAINS entry 1 is not a valid domain',
    ],
    [
      { DRAFTROOM_CREATOR_DOMAINS: `${secret}.com:443` },
      'DRAFTROOM_CREATOR_DOMAINS entry 1 is not a valid domain',
    ],
    [
      { DRAFTROOM_CREATOR_DOMAINS: `.${secret}.com` },
      'DRAFTROOM_CREATOR_DOMAINS entry 1 is not a valid domain',
    ],
    [
      { DRAFTROOM_CREATOR_DOMAINS: `${secret}.com.` },
      'DRAFTROOM_CREATOR_DOMAINS entry 1 is not a valid domain',
    ],
    [
      { DRAFTROOM_CREATOR_DOMAINS: `a@${secret}.com` },
      'DRAFTROOM_CREATOR_DOMAINS entry 1 is not a valid domain',
    ],
    [
      { DRAFTROOM_CREATOR_DOMAINS: `${secret}.invalid` },
      'DRAFTROOM_CREATOR_DOMAINS entry 1 is not a valid domain',
    ],
    [{ DRAFTROOM_CREATOR_DOMAINS: 'dev.invalid' }, 'DRAFTROOM_CREATOR_DOMAINS entry 1 is not a valid domain'],
    [
      { DRAFTROOM_CREATOR_DOMAINS: `dаrkburn-${secret}.com` },
      'DRAFTROOM_CREATOR_DOMAINS entry 1 is not an ASCII domain (write internationalised domains in punycode, xn--…)',
    ],
    [{ DRAFTROOM_CREATOR_DOMAINS: ' , ,' }, 'DRAFTROOM_CREATOR_DOMAINS lists no domain'],
    [
      { DRAFTROOM_CREATOR_EMAILS: `ok@example.test,${secret}` },
      'DRAFTROOM_CREATOR_EMAILS entry 2 is not a valid email address',
    ],
    [
      { DRAFTROOM_CREATOR_EMAILS: `${secret}@example.invalid` },
      'DRAFTROOM_CREATOR_EMAILS entry 1 is not a valid email address',
    ],
    [
      { DRAFTROOM_CREATOR_EMAILS: `${secret}@localhost` },
      'DRAFTROOM_CREATOR_EMAILS entry 1 is not a valid email address',
    ],
    [
      { DRAFTROOM_CREATOR_EMAILS: `${secret}＠example.test` },
      'DRAFTROOM_CREATOR_EMAILS entry 1 is not a valid email address',
    ],
    [
      { DRAFTROOM_CREATOR_EMAILS: `${secret}+clerk_test@example.test` },
      'DRAFTROOM_CREATOR_EMAILS entry 1 is a Clerk test address (+clerk_test)',
    ],
  ])('refuses %j with a message naming the variable and entry, never the value', (env, message) => {
    let error: Error | null = null
    try {
      parseCreatorPolicy(env)
    } catch (e) {
      error = e as Error
    }
    expect(error?.message.startsWith(message), error?.message).toBe(true)
    expect(error?.message).not.toContain(secret)
  })

  it('refuses more than 50 exceptions', () => {
    const list = Array.from({ length: 51 }, (_, i) => `person${i}@example.test`).join(',')
    expect(() => parseCreatorPolicy({ DRAFTROOM_CREATOR_EMAILS: list })).toThrow(
      'DRAFTROOM_CREATOR_EMAILS lists more than 50 addresses',
    )
    const fifty = Array.from({ length: 50 }, (_, i) => `person${i}@example.test`).join(',')
    expect(parseCreatorPolicy({ DRAFTROOM_CREATOR_EMAILS: fifty }).emails).toHaveLength(50)
  })
})
