// Google ID token verification (auth/google-id-token.ts) with locally generated RS256 keys standing in for
// Google's: signature, audience, issuer, expiry, email_verified, key rotation and malformed input.

import { generateKeyPairSync, type KeyObject, sign } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createGoogleVerifier, type GoogleKeys, GoogleTokenError } from '../src/auth/google-id-token.ts'

const CLIENT_ID = '1234567890-abcdef.apps.googleusercontent.com'
const NOW = new Date('2026-10-06T20:00:00Z')
const nowS = NOW.getTime() / 1000

const pair = () => generateKeyPairSync('rsa', { modulusLength: 2048 })
const google = pair()
const other = pair()
const jwkOf = (key: KeyObject, kid: string) => ({
  ...key.export({ format: 'jwk' }),
  kid,
  alg: 'RS256',
  use: 'sig',
})
const keysWith = (...keys: ReturnType<typeof jwkOf>[]): GoogleKeys => ({
  keys,
  expiresAt: Date.now() + 3_600_000,
})

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
function token(claims: Record<string, unknown>, opts: { kid?: string; key?: KeyObject; alg?: string } = {}) {
  const head = b64({ alg: opts.alg ?? 'RS256', kid: opts.kid ?? 'k1', typ: 'JWT' })
  const body = b64({
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    sub: '110000000000000000001',
    email: 'Dana.Rivera@gmail.com',
    email_verified: true,
    name: 'Dana Rivera',
    iat: nowS - 10,
    exp: nowS + 3600,
    ...claims,
  })
  const sig = sign('RSA-SHA256', Buffer.from(`${head}.${body}`), opts.key ?? google.privateKey).toString(
    'base64url',
  )
  return `${head}.${body}.${sig}`
}

const verifier = (fetchKeys = vi.fn(async () => keysWith(jwkOf(google.publicKey, 'k1')))) => ({
  fetchKeys,
  verify: createGoogleVerifier({ clientId: CLIENT_ID, fetchKeys, now: () => NOW }),
})

describe('Google ID token verification', () => {
  it('accepts a token Google signed for our client, with a verified address from any domain', async () => {
    const { verify, fetchKeys } = verifier()
    await expect(verify(token({}))).resolves.toEqual({
      sub: '110000000000000000001',
      email: 'Dana.Rivera@gmail.com',
      name: 'Dana Rivera',
    })
    await expect(
      verify(token({ email: 'x@any-school.example', iss: 'accounts.google.com' })),
    ).resolves.toMatchObject({
      email: 'x@any-school.example',
    })
    // email_verified as the string Google sometimes sends.
    await expect(verify(token({ email_verified: 'true', name: undefined }))).resolves.toMatchObject({
      name: null,
    })
    expect(fetchKeys).toHaveBeenCalledTimes(1) // cached
  })

  it.each([
    ['another client', { aud: '999-zzz.apps.googleusercontent.com' }, 'wrong audience'],
    ['another issuer', { iss: 'https://evil.example' }, 'wrong issuer'],
    ['an expired token', { exp: nowS - 120 }, 'expired'],
    ['an address Google did not verify', { email_verified: false }, 'not verified'],
    ['no address', { email: undefined }, 'no account'],
  ])('refuses %s', async (_what, claims, reason) => {
    const { verify } = verifier()
    await expect(verify(token(claims))).rejects.toThrow(reason)
  })

  it('allows 60 s of clock skew on exp', async () => {
    const { verify } = verifier()
    await expect(verify(token({ exp: nowS - 30 }))).resolves.toBeTruthy()
  })

  it('refuses a token signed by any other key, and other algorithms', async () => {
    const { verify } = verifier()
    await expect(verify(token({}, { key: other.privateKey }))).rejects.toThrow('bad signature')
    await expect(verify(token({}, { alg: 'HS256' }))).rejects.toThrow(GoogleTokenError)
  })

  it('refetches Google keys once for an unknown key id (rotation), then refuses', async () => {
    const fetchKeys = vi
      .fn<() => Promise<GoogleKeys>>()
      .mockResolvedValueOnce(keysWith(jwkOf(google.publicKey, 'k1')))
      // After the rotation, every later fetch answers the new set.
      .mockResolvedValue(keysWith(jwkOf(google.publicKey, 'k1'), jwkOf(other.publicKey, 'k2')))
    const { verify } = verifier(fetchKeys)
    await expect(verify(token({}, { kid: 'k2', key: other.privateKey }))).resolves.toBeTruthy()
    expect(fetchKeys).toHaveBeenCalledTimes(2)
    await expect(verify(token({}, { kid: 'k9' }))).rejects.toThrow('unknown signing key')
  })

  it('refuses malformed input without asking Google', async () => {
    const { verify, fetchKeys } = verifier()
    for (const bad of ['', 'a.b', 'a.b.c.d', 'x'.repeat(5000), '!!!.@@@.###'])
      await expect(verify(bad)).rejects.toThrow(GoogleTokenError)
    expect(fetchKeys).not.toHaveBeenCalled()
  })
})
