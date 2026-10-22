// The secret box (wave R foundation; src/crypto/sealed.ts) and its configuration (DRAFTROOM_WEBHOOK_SECRET): AES-256-GCM
// with a fresh nonce, the row as additional data, rotation through the previous key, and chat hooks off (fail closed)
// when no secret is set. Also the wave R test seams of config.ts (local dev only).
import { inspect } from 'node:util'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config.ts'
import { chatHookAad, createSecretBox, KEY_ID_PATTERN, SealedOpenError } from '../../src/crypto/sealed.ts'
import { testEnv } from '../helpers.ts'

const A = 'webhook-secret-A-0123456789abcdefghijklmnop'
const B = 'webhook-secret-B-0123456789abcdefghijklmnop'
// Deliberately unlike a real webhook (short ids, short token) so secret scanning does not flag the literal.
const URL_ = 'https://hooks.slack.com/services/T0/B0/fakeTOKENfakeWXYZ'
const AAD = chatHookAad('wsp_0123456789abcdefghij', 'chk_0123456789abcdefghij')

describe('the secret box', () => {
  it('seals and opens; the sealed bytes hold no part of the value; a fresh nonce every time', () => {
    const box = createSecretBox({ current: A, previous: null })
    if (!box) throw new Error('no box')
    const one = box.seal(URL_, AAD)
    const two = box.seal(URL_, AAD)
    expect(one.keyId).toMatch(KEY_ID_PATTERN)
    expect(one.sealed.equals(two.sealed)).toBe(false)
    expect(one.sealed.subarray(0, 12).equals(two.sealed.subarray(0, 12))).toBe(false)
    expect(one.sealed.length).toBe(12 + Buffer.byteLength(URL_) + 16)
    expect(one.sealed.toString('latin1')).not.toContain('hooks.slack.com')
    expect(box.open(one.sealed, one.keyId, AAD)).toEqual({ value: URL_, stale: false })
    // the 0036 CHECK's bounds: 29..2076 bytes for 1..2048-byte values
    expect(box.seal('x', AAD).sealed.length).toBe(29)
    expect(box.seal('x'.repeat(2048), AAD).sealed.length).toBe(2076)
  })

  it('refuses another row, another key, and any change, saying nothing of the value', () => {
    const box = createSecretBox({ current: A, previous: null })
    const other = createSecretBox({ current: B, previous: null })
    if (!box || !other) throw new Error('no box')
    const s = box.seal(URL_, AAD)
    const fails = (f: () => unknown) => {
      try {
        f()
      } catch (e) {
        expect(e).toBeInstanceOf(SealedOpenError)
        expect(`${(e as Error).message} ${inspect(e)}`).not.toContain('slack')
        return true
      }
      return false
    }
    const otherRow = chatHookAad('wsp_0123456789abcdefghij', 'chk_other00000000001')
    expect(fails(() => box.open(s.sealed, s.keyId, otherRow))).toBe(true)
    expect(fails(() => other.open(s.sealed, s.keyId, AAD))).toBe(true)
    for (const i of [0, 12, s.sealed.length - 1]) {
      const bent = Buffer.from(s.sealed)
      bent[i] = (bent[i] ?? 0) ^ 1
      expect(
        fails(() => box.open(bent, s.keyId, AAD)),
        `byte ${i}`,
      ).toBe(true)
    }
    expect(fails(() => box.open(s.sealed.subarray(0, 20), s.keyId, AAD))).toBe(true)
  })

  it('rotation: the previous key still opens (stale); a re-seal moves the value to the current key', () => {
    const old = createSecretBox({ current: A, previous: null })
    const rotated = createSecretBox({ current: B, previous: A })
    if (!old || !rotated) throw new Error('no box')
    const s = old.seal(URL_, AAD)
    const opened = rotated.open(s.sealed, s.keyId, AAD)
    expect(opened).toEqual({ value: URL_, stale: true })
    const again = rotated.seal(opened.value, AAD)
    expect(again.keyId).toBe(rotated.keyId)
    expect(rotated.open(again.sealed, again.keyId, AAD)).toEqual({ value: URL_, stale: false })
    // without the previous key, the old value no longer opens (the admins paste the URLs again)
    const bOnly = createSecretBox({ current: B, previous: null })
    expect(() => bOnly?.open(s.sealed, s.keyId, AAD)).toThrow(SealedOpenError)
  })

  it('no secret: no box (chat hooks are off)', () => {
    expect(createSecretBox(null)).toBeNull()
  })
})

describe('config: DRAFTROOM_WEBHOOK_SECRET', () => {
  const base = testEnv('./.data-test-never-created')

  it('unset: null (hooks off); set: checked like every secret and different from the others', () => {
    expect(loadConfig(base).webhookSecret).toBeNull()
    const secret = (env: Record<string, string>) => loadConfig({ ...base, ...env }).webhookSecret
    expect(secret({ DRAFTROOM_WEBHOOK_SECRET: A })).toEqual({ current: A, previous: null })
    expect(secret({ DRAFTROOM_WEBHOOK_SECRET: B, DRAFTROOM_WEBHOOK_SECRET_PREVIOUS: A })).toEqual({
      current: B,
      previous: A,
    })
    expect(() => loadConfig({ ...base, DRAFTROOM_WEBHOOK_SECRET: 'short' })).toThrow(/at least 32/)
    expect(() => loadConfig({ ...base, DRAFTROOM_WEBHOOK_SECRET: base.DRAFTROOM_TICKET_SECRET })).toThrow(
      /must differ/,
    )
    expect(() => loadConfig({ ...base, DRAFTROOM_WEBHOOK_SECRET: base.DRAFTROOM_WORKER_TOKEN })).toThrow(
      /must differ/,
    )
    const same = { DRAFTROOM_WEBHOOK_SECRET: A, DRAFTROOM_WEBHOOK_SECRET_PREVIOUS: A }
    expect(() => secret(same)).toThrow(/must differ/)
    expect(() => loadConfig({ ...base, DRAFTROOM_WEBHOOK_SECRET_PREVIOUS: A })).toThrow(/is not/)
  })

  it('the wave R test seams: exact origins, at most two, local dev only', () => {
    expect(loadConfig(base)).toMatchObject({ miroTestOrigins: null, chatHookTestOrigins: null })
    const c = loadConfig({
      ...base,
      DRAFTROOM_MIRO_TEST_ORIGINS: 'http://127.0.0.1:7801,http://127.0.0.1:7802',
      DRAFTROOM_CHAT_HOOK_TEST_ORIGINS: 'http://127.0.0.1:7811',
    })
    expect(c.miroTestOrigins).toEqual({ api: 'http://127.0.0.1:7801', files: 'http://127.0.0.1:7802' })
    expect(c.chatHookTestOrigins).toEqual({ slack: 'http://127.0.0.1:7811', teams: null })
    const env = (more: Record<string, string>) => () => loadConfig({ ...base, ...more })
    const three = 'http://127.0.0.1:1,http://127.0.0.1:2,http://127.0.0.1:3'
    expect(env({ DRAFTROOM_MIRO_TEST_ORIGINS: three })).toThrow(/at most 2/)
    expect(env({ DRAFTROOM_MIRO_TEST_ORIGINS: 'http://127.0.0.1:7801/v2' })).toThrow(/origins/)
    const clerk = {
      DRAFTROOM_DEV_AUTH: '',
      AUTH_PROVIDER: 'clerk',
      CLERK_SECRET_KEY: 'sk_x',
      CLERK_PUBLISHABLE_KEY: 'pk_x',
    }
    expect(env({ ...clerk, DRAFTROOM_CHAT_HOOK_TEST_ORIGINS: 'http://127.0.0.1:1' })).toThrow(
      /DRAFTROOM_CHAT_HOOK_TEST_ORIGINS requires DRAFTROOM_DEV_AUTH=1/,
    )
    expect(env({ ...clerk, DRAFTROOM_MIRO_TEST_ORIGINS: 'http://127.0.0.1:1' })).toThrow(
      /DRAFTROOM_MIRO_TEST_ORIGINS requires DRAFTROOM_DEV_AUTH=1/,
    )
  })
})
