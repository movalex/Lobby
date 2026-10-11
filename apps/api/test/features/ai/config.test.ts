// ai-assist configuration (docs/WAVE4-CONTRACTS.md §4): OPENAI_* and DRAFTROOM_AI_*, with the contract's
// defaults, the kill switch, and refusals that never echo a secret.

import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../../src/config.ts'
import { budgetPercent, InFlight, nextUtcMidnight, utcDay } from '../../../src/features/ai/budget.ts'
import {
  DEFAULT_AI_CONFIG,
  DEFAULT_CAPTURE_CONFIG,
  parseAiConfig,
  parseCaptureConfig,
} from '../../../src/features/ai/config.ts'
import { readUsage } from '../../../src/features/ai/openai.ts'
import { testEnv } from '../../helpers.ts'

describe('parseAiConfig', () => {
  it('defaults: on but not configured without a key; the contract limits', () => {
    const c = parseAiConfig({}, false)
    expect(c).toEqual({ ...DEFAULT_AI_CONFIG })
    expect(c).toMatchObject({
      enabled: true,
      apiKey: null,
      model: 'gpt-5.4-mini',
      baseUrl: 'https://api.openai.com/v1',
      maxInputTokens: 12_000,
      maxOutputTokens: 1_500,
      callsPerUserPerHour: 20,
      workspaceDailyTokens: 400_000,
      reasoningEffort: 'low',
    })
    expect(loadConfig(testEnv('./.data-test-never-created')).ai.apiKey).toBeNull()
  })

  it('reads every knob', () => {
    const c = parseAiConfig(
      {
        DRAFTROOM_AI: 'OFF',
        OPENAI_API_KEY: 'sk-proj-abcdefghijklmnopqrstuvwxyz',
        OPENAI_MODEL: 'gpt-5.4-mini-2026-03-01',
        OPENAI_BASE_URL: 'https://proxy.example.com/openai/v1/',
        DRAFTROOM_AI_TIMEOUT_MS: '20000',
        DRAFTROOM_AI_MAX_INPUT_TOKENS: '8000',
        DRAFTROOM_AI_MAX_OUTPUT_TOKENS: '1000',
        DRAFTROOM_AI_CALLS_PER_HOUR: '5',
        DRAFTROOM_AI_DAILY_TOKENS: '100000',
        DRAFTROOM_AI_USER_DAILY_TOKENS: '50000',
        DRAFTROOM_AI_GLOBAL_DAILY_TOKENS: '0',
        DRAFTROOM_AI_REASONING_EFFORT: 'off',
      },
      true,
    )
    expect(c).toEqual({
      enabled: false,
      apiKey: 'sk-proj-abcdefghijklmnopqrstuvwxyz',
      model: 'gpt-5.4-mini-2026-03-01',
      baseUrl: 'https://proxy.example.com/openai/v1',
      timeoutMs: 20_000,
      maxInputTokens: 8_000,
      maxOutputTokens: 1_000,
      callsPerUserPerHour: 5,
      workspaceDailyTokens: 100_000,
      userDailyTokens: 50_000,
      globalDailyTokens: 0,
      reasoningEffort: null,
      capture: { ...DEFAULT_CAPTURE_CONFIG },
    })
  })

  it('refuses bad values without echoing them', () => {
    const secret = 'sk-live key with spaces 0123456789'
    const cases: [Record<string, string>, RegExp][] = [
      [{ DRAFTROOM_AI: 'maybe' }, /DRAFTROOM_AI must be on or off/],
      [{ OPENAI_API_KEY: secret }, /OPENAI_API_KEY is malformed/],
      [{ OPENAI_MODEL: 'gpt 5' }, /OPENAI_MODEL/],
      [{ OPENAI_BASE_URL: 'ftp://x' }, /OPENAI_BASE_URL/],
      [{ OPENAI_BASE_URL: 'https://u:p@api.openai.com/v1' }, /credentials/],
      [{ OPENAI_BASE_URL: 'https://api.openai.com/v1?x=1' }, /query/],
      [{ DRAFTROOM_AI_TIMEOUT_MS: '10' }, /DRAFTROOM_AI_TIMEOUT_MS must be between/],
      [{ DRAFTROOM_AI_MAX_INPUT_TOKENS: '999999' }, /DRAFTROOM_AI_MAX_INPUT_TOKENS/],
      [{ DRAFTROOM_AI_DAILY_TOKENS: '-1' }, /whole number/],
      [{ DRAFTROOM_AI_REASONING_EFFORT: 'extreme' }, /DRAFTROOM_AI_REASONING_EFFORT/],
    ]
    for (const [env, message] of cases) {
      let err: Error | null = null
      try {
        parseAiConfig(env, false)
      } catch (e) {
        err = e as Error
      }
      expect(err?.message, JSON.stringify(env)).toMatch(message)
      expect(err?.message).not.toContain(secret)
    }
  })

  it('production: the key never travels over plain http', () => {
    expect(() => parseAiConfig({ OPENAI_BASE_URL: 'http://127.0.0.1:9/v1' }, true)).toThrow(
      /https in production/,
    )
    expect(parseAiConfig({ OPENAI_BASE_URL: 'http://127.0.0.1:9/v1' }, false).baseUrl).toBe(
      'http://127.0.0.1:9/v1',
    )
  })
})

describe('parseCaptureConfig (wave N, WS5)', () => {
  it('fail-closed: vision is off unless DRAFTROOM_AI_VISION=on; the caps and limits default to the contract’s', () => {
    expect(parseCaptureConfig({})).toEqual({
      vision: false,
      visionModel: null,
      visionUserDaily: 10,
      visionGlobalDaily: 150,
      transcriptUserDaily: 10,
      transcriptMaxChars: 60_000,
      visionTimeoutMs: 60_000,
    })
    expect(parseCaptureConfig({ DRAFTROOM_AI_VISION: '' }).vision).toBe(false)
    expect(parseCaptureConfig({ DRAFTROOM_AI_VISION: 'off' }).vision).toBe(false)
    expect(parseCaptureConfig({ DRAFTROOM_AI_VISION: 'ON' }).vision).toBe(true)
    expect(parseAiConfig({}, false).capture.vision).toBe(false)
    expect(loadConfig(testEnv('./.data-test-never-created')).ai.capture.vision).toBe(false)
  })

  it('reads every knob, and refuses bad values (a transcript never past the contract’s 60,000 characters)', () => {
    expect(
      parseCaptureConfig({
        DRAFTROOM_AI_VISION: 'on',
        DRAFTROOM_AI_VISION_MODEL: 'gpt-5.4-vision',
        DRAFTROOM_AI_VISION_USER_DAILY: '3',
        DRAFTROOM_AI_VISION_GLOBAL_DAILY: '0',
        DRAFTROOM_AI_TRANSCRIPT_USER_DAILY: '5',
        DRAFTROOM_AI_TRANSCRIPT_MAX_CHARS: '20000',
        DRAFTROOM_AI_VISION_TIMEOUT_MS: '90000',
      }),
    ).toEqual({
      vision: true,
      visionModel: 'gpt-5.4-vision',
      visionUserDaily: 3,
      visionGlobalDaily: 0,
      transcriptUserDaily: 5,
      transcriptMaxChars: 20_000,
      visionTimeoutMs: 90_000,
    })
    const cases: [Record<string, string>, RegExp][] = [
      [{ DRAFTROOM_AI_VISION: 'yes' }, /DRAFTROOM_AI_VISION must be on or off/],
      [{ DRAFTROOM_AI_VISION_MODEL: 'gpt 5' }, /DRAFTROOM_AI_VISION_MODEL/],
      [{ DRAFTROOM_AI_TRANSCRIPT_MAX_CHARS: '60001' }, /DRAFTROOM_AI_TRANSCRIPT_MAX_CHARS must be between/],
      [{ DRAFTROOM_AI_VISION_USER_DAILY: '-2' }, /whole number/],
      [{ DRAFTROOM_AI_VISION_TIMEOUT_MS: '5' }, /DRAFTROOM_AI_VISION_TIMEOUT_MS/],
    ]
    for (const [env, message] of cases)
      expect(() => parseCaptureConfig(env), JSON.stringify(env)).toThrow(message)
  })
})

describe('ledger helpers', () => {
  it('UTC days and the next midnight', () => {
    const at = new Date('2026-09-28T23:59:59.000Z')
    expect(utcDay(at)).toBe('2026-09-28')
    expect(nextUtcMidnight(at).toISOString()).toBe('2026-09-29T00:00:00.000Z')
  })

  it('budget percent rounds down, reads 0 only when nothing was used and 100 only when nothing is left', () => {
    expect(budgetPercent(0, 400_000)).toBe(0)
    expect(budgetPercent(1_500, 400_000)).toBe(1)
    expect(budgetPercent(9_000, 400_000)).toBe(2)
    expect(budgetPercent(399_999, 400_000)).toBe(99)
    expect(budgetPercent(400_000, 400_000)).toBe(100)
    expect(budgetPercent(500_000, 400_000)).toBe(100)
    expect(budgetPercent(10, 0)).toBe(100)
  })

  it('in-flight limits per person, per workspace and in total; release is idempotent', () => {
    const f = new InFlight({ user: 1, workspace: 2, total: 3 })
    const a = f.acquire('u1', 'w1')
    expect(a).not.toBeNull()
    expect(f.acquire('u1', 'w2')).toBeNull()
    const b = f.acquire('u2', 'w1')
    expect(f.acquire('u3', 'w1')).toBeNull()
    const c = f.acquire('u3', 'w2')
    expect(f.acquire('u4', 'w3')).toBeNull()
    a?.()
    a?.()
    expect(f.running).toBe(2)
    expect(f.acquire('u1', 'w1')).not.toBeNull()
    b?.()
    c?.()
  })

  it('usage: missing or broken numbers are unknown; a total below its parts is raised', () => {
    expect(readUsage(undefined)).toBeNull()
    expect(readUsage({ prompt_tokens: 'x', completion_tokens: 1 })).toBeNull()
    expect(readUsage({ prompt_tokens: -1, completion_tokens: 1 })).toBeNull()
    expect(readUsage({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 })).toEqual({
      input: 10,
      output: 5,
      total: 15,
    })
    expect(readUsage({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 2 })?.total).toBe(15)
    expect(readUsage({ prompt_tokens: 1e12, completion_tokens: 0 })?.input).toBe(10_000_000)
  })
})
