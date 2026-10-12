// AI settings (docs/WAVE4-CONTRACTS.md §4 ai-assist), parsed by loadConfig() into ApiConfig.ai. Error
// messages name variables, never values (OPENAI_API_KEY is a secret).
//
// The OpenAI key has NO spending cap at the provider, so these limits are the only protection. Every
// limit is enforced server-side in budget.ts; the defaults are the contract's:
//   input ≈ 12k tokens and output ≈ 1.5k tokens per call, 20 calls per person per hour, 400k tokens per
//   workspace per UTC day. Two more, because a per-workspace budget multiplies by the workspaces one
//   person can create (every account gets a personal workspace) and by the people in one workspace:
//   150k tokens per person per day, and 2M tokens per day for the whole of Lobby.
// DRAFTROOM_AI=off is the kill switch: nothing is called, the feature is hidden.
//
// Wave N (WS5, N5-1): Capture the room (capture.ts) adds its own knobs (AiConfig.capture). Photos and board images
// go to OpenAI only with DRAFTROOM_AI_VISION=on (unset or empty is off: fail-closed), and every capture is held to
// per-day caps counted from the ledger's rows, on top of the token budgets above:
//   DRAFTROOM_AI_VISION=on|off, DRAFTROOM_AI_VISION_MODEL (default OPENAI_MODEL), DRAFTROOM_AI_VISION_USER_DAILY
//   (10 a person), DRAFTROOM_AI_VISION_GLOBAL_DAILY (150 for all of Lobby), DRAFTROOM_AI_TRANSCRIPT_USER_DAILY (10 a
//   person), DRAFTROOM_AI_TRANSCRIPT_MAX_CHARS (60,000, the contract's most), DRAFTROOM_AI_VISION_TIMEOUT_MS (60 s).
// A capture's answer is longer than a board run's (a wall of 100 notes is strict JSON with a text, a colour and a box
// each, about 40 tokens a note, and reasoning tokens count too), so capture calls have an output cap of their own:
//   DRAFTROOM_AI_CAPTURE_MAX_OUTPUT_TOKENS (6,000; the board's DRAFTROOM_AI_MAX_OUTPUT_TOKENS is not raised for it).

import {
  CAPTURE_DEFAULT_CAPS,
  CAPTURE_TRANSCRIPT_MAX_CHARS,
  CAPTURE_VISION_TIMEOUT_MS_DEFAULT,
} from '@draftroom/contracts'

type Env = Record<string, string | undefined>

export const REASONING_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high'] as const
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]

export interface AiConfig {
  /** DRAFTROOM_AI=on (default) | off: the global kill switch. */
  enabled: boolean
  /** OPENAI_API_KEY; null = AI is not configured (the feature is hidden). */
  apiKey: string | null
  /** OPENAI_MODEL (default gpt-5.4-mini). */
  model: string
  /** OPENAI_BASE_URL without a trailing slash (default https://api.openai.com/v1; https in production). */
  baseUrl: string
  /** DRAFTROOM_AI_TIMEOUT_MS: the whole OpenAI request, answer included (default 30 s). */
  timeoutMs: number
  /** DRAFTROOM_AI_MAX_INPUT_TOKENS: the prompt, estimated conservatively (default 12,000). */
  maxInputTokens: number
  /** DRAFTROOM_AI_MAX_OUTPUT_TOKENS: max_completion_tokens, reasoning included (default 1,500). */
  maxOutputTokens: number
  /** DRAFTROOM_AI_CALLS_PER_HOUR: per person, every call counted, failed ones too (default 20). */
  callsPerUserPerHour: number
  /** DRAFTROOM_AI_DAILY_TOKENS: per workspace per UTC day (default 400,000). */
  workspaceDailyTokens: number
  /** DRAFTROOM_AI_USER_DAILY_TOKENS: per person per UTC day, across workspaces (default 150,000). */
  userDailyTokens: number
  /** DRAFTROOM_AI_GLOBAL_DAILY_TOKENS: all of Lobby per UTC day (default 2,000,000). */
  globalDailyTokens: number
  /**
   * DRAFTROOM_AI_REASONING_EFFORT: sent as reasoning_effort (default low: reasoning tokens count toward
   * the output cap). `off` = not sent, for models without the parameter.
   */
  reasoningEffort: ReasoningEffort | null
  /** Wave N (WS5): Capture the room. */
  capture: CaptureConfig
}

/** Capture the room's knobs (see the header). */
export interface CaptureConfig {
  /** DRAFTROOM_AI_VISION=on | off (unset or empty: off): photos and board images may be sent to OpenAI. */
  vision: boolean
  /** DRAFTROOM_AI_VISION_MODEL; null: OPENAI_MODEL. */
  visionModel: string | null
  /** DRAFTROOM_AI_VISION_USER_DAILY: photo and board-image captures per person per UTC day (default 10). */
  visionUserDaily: number
  /** DRAFTROOM_AI_VISION_GLOBAL_DAILY: photo and board-image captures for all of Lobby per UTC day (default 150). */
  visionGlobalDaily: number
  /** DRAFTROOM_AI_TRANSCRIPT_USER_DAILY: transcript captures per person per UTC day (default 10). */
  transcriptUserDaily: number
  /** DRAFTROOM_AI_TRANSCRIPT_MAX_CHARS: the most of a transcript that is read (default and most 60,000). */
  transcriptMaxChars: number
  /**
   * DRAFTROOM_AI_VISION_TIMEOUT_MS: one photo call, answer included (default 60 s). A transcript part's call gets
   * the longer of it and DRAFTROOM_AI_TIMEOUT_MS: its answer can be as long as a photo's.
   */
  visionTimeoutMs: number
  /**
   * DRAFTROOM_AI_CAPTURE_MAX_OUTPUT_TOKENS: max_completion_tokens of every capture call (a photo, a board image, a
   * transcript part and the themes call), reasoning included, and what each reserves for its answer (default 6,000).
   */
  maxOutputTokens: number
}

/** A capture call's output cap by default: the contract's 120 notes at about 40 tokens each, and the reasoning. */
export const CAPTURE_MAX_OUTPUT_TOKENS_DEFAULT = 6_000

export const DEFAULT_CAPTURE_CONFIG: Readonly<CaptureConfig> = Object.freeze<CaptureConfig>({
  vision: false,
  visionModel: null,
  visionUserDaily: CAPTURE_DEFAULT_CAPS.visionUserDaily,
  visionGlobalDaily: CAPTURE_DEFAULT_CAPS.visionGlobalDaily,
  transcriptUserDaily: CAPTURE_DEFAULT_CAPS.transcriptUserDaily,
  transcriptMaxChars: CAPTURE_TRANSCRIPT_MAX_CHARS,
  visionTimeoutMs: CAPTURE_VISION_TIMEOUT_MS_DEFAULT,
  maxOutputTokens: CAPTURE_MAX_OUTPUT_TOKENS_DEFAULT,
})

export const DEFAULT_AI_CONFIG: Readonly<AiConfig> = Object.freeze<AiConfig>({
  enabled: true,
  apiKey: null,
  model: 'gpt-5.4-mini',
  baseUrl: 'https://api.openai.com/v1',
  timeoutMs: 30_000,
  maxInputTokens: 12_000,
  maxOutputTokens: 1_500,
  callsPerUserPerHour: 20,
  workspaceDailyTokens: 400_000,
  userDailyTokens: 150_000,
  globalDailyTokens: 2_000_000,
  reasoningEffort: 'low',
  capture: DEFAULT_CAPTURE_CONFIG,
})

const read = (env: Env, name: string): string | undefined => {
  const v = env[name]?.trim()
  return v ? v : undefined
}

function int(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = read(env, name)
  if (raw === undefined) return fallback
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a whole number`)
  const n = Number(raw)
  if (n < min || n > max) throw new Error(`${name} must be between ${min} and ${max}`)
  return n
}

// OpenAI keys are opaque; this only refuses obvious paste mistakes (spaces, quotes, newlines).
const KEY_RE = /^[A-Za-z0-9_\-.]{20,512}$/
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/

function baseUrl(env: Env, production: boolean): string {
  const raw = read(env, 'OPENAI_BASE_URL') ?? DEFAULT_AI_CONFIG.baseUrl
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('OPENAI_BASE_URL must be an absolute http(s) URL')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new Error('OPENAI_BASE_URL must be an absolute http(s) URL')
  // The key rides on every request: never over plain http in production.
  if (production && url.protocol !== 'https:') throw new Error('OPENAI_BASE_URL must be https in production')
  if (url.username || url.password || url.search || url.hash)
    throw new Error('OPENAI_BASE_URL must not carry credentials, a query or a fragment')
  return url.href.replace(/\/+$/, '')
}

export function parseAiConfig(env: Env, production: boolean): AiConfig {
  const d = DEFAULT_AI_CONFIG
  const switchRaw = read(env, 'DRAFTROOM_AI')?.toLowerCase() ?? 'on'
  if (switchRaw !== 'on' && switchRaw !== 'off') throw new Error('DRAFTROOM_AI must be on or off')
  const apiKey = read(env, 'OPENAI_API_KEY') ?? null
  if (apiKey !== null && !KEY_RE.test(apiKey)) throw new Error('OPENAI_API_KEY is malformed')
  const model = read(env, 'OPENAI_MODEL') ?? d.model
  if (!MODEL_RE.test(model)) throw new Error('OPENAI_MODEL must be a model name such as gpt-5.4-mini')
  const effortRaw = read(env, 'DRAFTROOM_AI_REASONING_EFFORT')?.toLowerCase()
  let reasoningEffort: ReasoningEffort | null = d.reasoningEffort
  if (effortRaw === 'off') reasoningEffort = null
  else if (effortRaw !== undefined) {
    if (!(REASONING_EFFORTS as readonly string[]).includes(effortRaw))
      throw new Error(`DRAFTROOM_AI_REASONING_EFFORT must be off, ${REASONING_EFFORTS.join(', ')}`)
    reasoningEffort = effortRaw as ReasoningEffort
  }
  return {
    enabled: switchRaw === 'on',
    apiKey,
    model,
    baseUrl: baseUrl(env, production),
    timeoutMs: int(env, 'DRAFTROOM_AI_TIMEOUT_MS', d.timeoutMs, 1_000, 120_000),
    maxInputTokens: int(env, 'DRAFTROOM_AI_MAX_INPUT_TOKENS', d.maxInputTokens, 1_000, 32_000),
    maxOutputTokens: int(env, 'DRAFTROOM_AI_MAX_OUTPUT_TOKENS', d.maxOutputTokens, 256, 4_000),
    callsPerUserPerHour: int(env, 'DRAFTROOM_AI_CALLS_PER_HOUR', d.callsPerUserPerHour, 1, 1_000),
    workspaceDailyTokens: int(env, 'DRAFTROOM_AI_DAILY_TOKENS', d.workspaceDailyTokens, 0, 100_000_000),
    userDailyTokens: int(env, 'DRAFTROOM_AI_USER_DAILY_TOKENS', d.userDailyTokens, 0, 100_000_000),
    globalDailyTokens: int(env, 'DRAFTROOM_AI_GLOBAL_DAILY_TOKENS', d.globalDailyTokens, 0, 1_000_000_000),
    reasoningEffort,
    capture: parseCaptureConfig(env),
  }
}

/** Capture the room's knobs (AiConfig.capture). Unset, empty or `off` DRAFTROOM_AI_VISION is off. */
export function parseCaptureConfig(env: Env): CaptureConfig {
  const d = DEFAULT_CAPTURE_CONFIG
  const vision = read(env, 'DRAFTROOM_AI_VISION')?.toLowerCase() ?? 'off'
  if (vision !== 'on' && vision !== 'off') throw new Error('DRAFTROOM_AI_VISION must be on or off')
  const visionModel = read(env, 'DRAFTROOM_AI_VISION_MODEL') ?? null
  if (visionModel !== null && !MODEL_RE.test(visionModel))
    throw new Error('DRAFTROOM_AI_VISION_MODEL must be a model name such as gpt-5.4-mini')
  return {
    vision: vision === 'on',
    visionModel,
    visionUserDaily: int(env, 'DRAFTROOM_AI_VISION_USER_DAILY', d.visionUserDaily, 0, 1_000),
    visionGlobalDaily: int(env, 'DRAFTROOM_AI_VISION_GLOBAL_DAILY', d.visionGlobalDaily, 0, 100_000),
    transcriptUserDaily: int(env, 'DRAFTROOM_AI_TRANSCRIPT_USER_DAILY', d.transcriptUserDaily, 0, 1_000),
    // never past the contract's most (CaptureTranscriptRequest refuses longer text anyway)
    transcriptMaxChars: int(
      env,
      'DRAFTROOM_AI_TRANSCRIPT_MAX_CHARS',
      d.transcriptMaxChars,
      1_000,
      CAPTURE_TRANSCRIPT_MAX_CHARS,
    ),
    visionTimeoutMs: int(env, 'DRAFTROOM_AI_VISION_TIMEOUT_MS', d.visionTimeoutMs, 1_000, 180_000),
    maxOutputTokens: int(env, 'DRAFTROOM_AI_CAPTURE_MAX_OUTPUT_TOKENS', d.maxOutputTokens, 256, 16_000),
  }
}

/** AI can be offered at all: switched on and a key configured. */
export const aiConfigured = (c: AiConfig) => c.enabled && c.apiKey !== null
