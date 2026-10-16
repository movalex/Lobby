// Pure pieces of the worker protocol: token parsing and comparison, fs-mode blob URL signing, probe
// sanitizing and the user-safe failure catalog.

import { describe, expect, it } from 'vitest'
import { bearerToken, carriesCookie, createTokenCheck } from '../../src/worker/auth.ts'
import { createBlobUrlSigner } from '../../src/worker/blob-urls.ts'
import { FAILURE_MESSAGES, sanitizeProbe, userFailure } from '../../src/worker/protocol.ts'

const TOKEN = 'unit-worker-token-0123456789abcdefghijklmnop'

describe('bearer token', () => {
  it('parses exactly one Bearer credential', () => {
    expect(bearerToken(`Bearer ${TOKEN}`)).toBe(TOKEN)
    expect(bearerToken(`bearer   ${TOKEN}`)).toBe(TOKEN)
    expect(bearerToken(`  Bearer ${TOKEN}  `)).toBe(TOKEN)
    for (const bad of [
      undefined,
      '',
      'Bearer',
      'Bearer ',
      `Basic ${TOKEN}`,
      TOKEN,
      `Bearer ${TOKEN} extra`,
      'Bearer aéb',
    ])
      expect(bearerToken(bad), String(bad)).toBeNull()
    expect(bearerToken([`Bearer ${TOKEN}`])).toBeNull() // a repeated header is not a token
    expect(bearerToken(`Bearer ${'x'.repeat(1025)}`)).toBeNull()
  })

  it('compares against the configured token only', () => {
    const ok = createTokenCheck(TOKEN)
    expect(ok(TOKEN)).toBe(true)
    for (const bad of [
      null,
      '',
      `${TOKEN}x`,
      TOKEN.slice(0, -1),
      TOKEN.toUpperCase(),
      'x'.repeat(TOKEN.length),
    ])
      expect(ok(bad), String(bad)).toBe(false)
  })

  it('any Cookie header counts as a browser request', () => {
    expect(carriesCookie(undefined)).toBe(false)
    expect(carriesCookie('')).toBe(false)
    expect(carriesCookie('dr_session=abc')).toBe(true)
    expect(carriesCookie('theme=dark')).toBe(true)
    expect(carriesCookie(['a=b'])).toBe(true)
  })
})

describe('fs-mode blob URLs', () => {
  let now = new Date('2026-09-27T12:00:00Z')
  const signer = createBlobUrlSigner(TOKEN, () => now)
  const VER = 'ver_AAAAAAAAAAAAAAAAAAAA'
  const DRV = 'drv_BBBBBBBBBBBBBBBBBBBB'

  it('round-trip one grant, expire, and stay under the router’s 100-character parameter limit', () => {
    now = new Date('2026-09-27T12:00:00Z')
    const o = signer.sign({ kind: 'o', id: VER }, 900)
    expect(signer.verify(o)).toEqual({ kind: 'o', id: VER })
    expect(signer.verify(signer.sign({ kind: 'd', id: DRV }, 900))).toEqual({ kind: 'd', id: DRV })
    const longest = signer.sign({ kind: 'd', id: `drv_${'Z'.repeat(40)}` }, 900)
    expect(longest.length).toBeLessThanOrEqual(100)
    now = new Date(now.getTime() + 900_000)
    expect(signer.verify(o)).not.toBeNull() // valid through its last second
    now = new Date(now.getTime() + 1_000)
    expect(signer.verify(o)).toBeNull()
  })

  it('refuses edits, other keys and malformed values', () => {
    now = new Date('2026-09-27T12:00:00Z')
    const o = signer.sign({ kind: 'o', id: VER }, 900)
    const [kind, id, exp, mac] = o.split('.') as [string, string, string, string]
    const other = createBlobUrlSigner(`${TOKEN}-rotated`, () => now)
    for (const bad of [
      `d.${id}.${exp}.${mac}`,
      `${kind}.ver_CCCCCCCCCCCCCCCCCCCC.${exp}.${mac}`,
      `${kind}.${id}.${Number(exp) + 1}.${mac}`,
      `${kind}.${id}.${exp}.${mac.slice(0, -1)}${mac.endsWith('A') ? 'B' : 'A'}`,
      `${kind}.${id}.${exp}`,
      `${o}.x`,
      '',
      '../../etc/passwd',
    ])
      expect(signer.verify(bad), bad).toBeNull()
    expect(other.verify(o)).toBeNull() // rotating the worker token revokes every URL
    expect(() => signer.sign({ kind: 'o', id: DRV }, 900)).toThrow() // a version grant names a version
    expect(() => signer.sign({ kind: 'd', id: 'drv_../x' }, 900)).toThrow()
  })
})

describe('probe and failures', () => {
  it('keeps exactly the six probe facts, rounding numbers and dropping anything malformed', () => {
    expect(
      sanitizeProbe({
        width: 1920.4,
        height: '1080',
        pageCount: -1,
        durationMs: Number.POSITIVE_INFINITY,
        videoCodec: 'h264',
        audioCodec: 'a a c',
        extra: 'dropped',
      }),
    ).toEqual({
      width: 1920,
      height: null,
      pageCount: null,
      durationMs: null,
      videoCodec: 'h264',
      audioCodec: null,
    })
    expect(sanitizeProbe(null)).toEqual({
      width: null,
      height: null,
      pageCount: null,
      durationMs: null,
      videoCodec: null,
      audioCodec: null,
    })
    // wave S (WS3): a video's frame rate is kept (3 decimals) only when it is a sane number; else no key at all
    expect(sanitizeProbe({ durationMs: 5000, frameRate: 29.97002997 })).toMatchObject({ frameRate: 29.97 })
    for (const bad of [0, 241, '30', Number.NaN, null])
      expect('frameRate' in sanitizeProbe({ frameRate: bad }), String(bad)).toBe(false)
  })

  it('maps codes to the fixed user messages; unknown codes are INTERNAL', () => {
    expect(userFailure('PDF_ENCRYPTED')).toEqual({
      code: 'PDF_ENCRYPTED',
      message: FAILURE_MESSAGES.PDF_ENCRYPTED,
    })
    for (const c of ['NOPE', 'toString', '__proto__', '', null, undefined])
      expect(userFailure(c).code, String(c)).toBe('INTERNAL')
    for (const m of Object.values(FAILURE_MESSAGES)) expect(m).not.toMatch(/[\\/]/) // no paths, ever
  })
})
