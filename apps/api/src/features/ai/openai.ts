// The one outbound call of ai-assist: POST {OPENAI_BASE_URL}/chat/completions with a strict JSON-schema
// response format, a completion-token cap and a hard timeout (docs/WAVE4-CONTRACTS.md §4). Plain fetch,
// no SDK. Tests and e2e point OPENAI_BASE_URL at a local fake (test/features/ai/fake-openai.ts); nothing
// in the repository calls the real API.
//
// Everything that comes back is untrusted: the body is read with a byte cap, the envelope is checked
// with zod, the usage numbers are clamped, and the content is only JSON-parsed here (plan.ts validates
// what it says). Nothing from the request or the answer is logged: the caller logs counts only.

import { z } from 'zod'
import { REASONING_EFFORTS, type ReasoningEffort } from './config.ts'

/** Token counts OpenAI reported for one call. */
export interface AiUsage {
  input: number
  output: number
  total: number
}

/**
 * What a call cost, as far as anyone can tell:
 * - 'usage': OpenAI reported it (charge `usage.total`);
 * - 'none': refused before any generation (an HTTP 4xx: OpenAI does not bill those);
 * - 'unknown': it may have been billed and we cannot know how much (timeout, dropped connection, 5xx,
 *   an answer without usage): the caller keeps the full reservation.
 */
export type Billing = 'usage' | 'none' | 'unknown'

export type ChatOutcome =
  | { ok: true; json: unknown; usage: AiUsage | null; billing: Billing }
  | {
      ok: false
      kind:
        | 'timeout'
        | 'network'
        | 'http'
        | 'too-large'
        | 'bad-response'
        | 'refused'
        | 'truncated'
        | 'bad-json'
      status: number | null
      usage: AiUsage | null
      billing: Billing
    }

export interface ChatRequest {
  system: string
  user: string
  schemaName: string
  schema: Record<string, unknown>
  /** This call's output cap (never above the configured one). */
  maxOutputTokens?: number
  /**
   * This call's reasoning effort at most (sent only when the configuration sends one at all): the lower of
   * it and the configured one goes, so a call can lower the effort but never raise it.
   */
  reasoningEffort?: ReasoningEffort
}

/** The lower of two efforts (config.ts REASONING_EFFORTS runs from the least to the most). */
export function lowerEffort(a: ReasoningEffort, b: ReasoningEffort | undefined): ReasoningEffort {
  if (b === undefined) return a
  return REASONING_EFFORTS.indexOf(b) < REASONING_EFFORTS.indexOf(a) ? b : a
}

export interface OpenAiClient {
  chat(req: ChatRequest): Promise<ChatOutcome>
}

export interface OpenAiClientOptions {
  apiKey: string
  baseUrl: string
  model: string
  timeoutMs: number
  maxOutputTokens: number
  reasoningEffort: ReasoningEffort | null
  fetchImpl?: typeof fetch
}

/** The most answer bytes read: 1.5k output tokens are a few KB; anything far beyond is not an answer. */
export const MAX_RESPONSE_BYTES = 256 * 1024
/** Error bodies are drained up to this, then dropped unread (never logged: they can echo the prompt). */
const MAX_ERROR_BYTES = 16 * 1024
const MAX_REPORTED_TOKENS = 10_000_000

const Envelope = z.object({
  choices: z
    .array(
      z.object({
        message: z
          .object({
            content: z.string().nullable().optional(),
            refusal: z.string().nullable().optional(),
          })
          .optional(),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .min(1),
  usage: z.unknown().optional(),
})

function count(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  return Math.min(MAX_REPORTED_TOKENS, Math.ceil(value))
}

/** OpenAI's usage block, or null when it is missing or unusable (the call then counts as unknown). */
export function readUsage(raw: unknown): AiUsage | null {
  if (typeof raw !== 'object' || raw === null) return null
  const u = raw as Record<string, unknown>
  const input = count(u.prompt_tokens)
  const output = count(u.completion_tokens)
  const total = count(u.total_tokens)
  if (input === null || output === null) return null
  // Never less than the parts: a total that undercounts its own parts is not believed.
  return { input, output, total: Math.max(total ?? 0, input + output) }
}

class TooLarge extends Error {}

/** Reads a body as text, refusing (and cancelling the stream) past `limit` bytes. */
async function readCapped(res: Response, limit: number): Promise<string> {
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > limit) {
    await res.body?.cancel().catch(() => {})
    throw new TooLarge()
  }
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel().catch(() => {})
      throw new TooLarge()
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function drain(res: Response): Promise<void> {
  try {
    await readCapped(res, MAX_ERROR_BYTES)
  } catch {
    // Over the cap or broken: dropped either way.
  }
}

export function createOpenAiClient(opts: OpenAiClientOptions): OpenAiClient {
  const fetchImpl = opts.fetchImpl ?? fetch
  const url = `${opts.baseUrl}/chat/completions`
  return {
    async chat(req) {
      const body: Record<string, unknown> = {
        model: opts.model,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: req.schemaName, strict: true, schema: req.schema },
        },
        max_completion_tokens: Math.min(opts.maxOutputTokens, req.maxOutputTokens ?? opts.maxOutputTokens),
        n: 1,
        // Nothing of a board is kept at OpenAI for distillation or evals.
        store: false,
      }
      // DRAFTROOM_AI_REASONING_EFFORT=off (a model without the parameter) wins over a call's own effort,
      // and a call's effort only ever lowers the configured one.
      if (opts.reasoningEffort) body.reasoning_effort = lowerEffort(opts.reasoningEffort, req.reasoningEffort)
      let res: Response
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${opts.apiKey}`,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify(body),
          redirect: 'error',
          signal: AbortSignal.timeout(opts.timeoutMs),
        })
      } catch (e) {
        const kind = (e as Error)?.name === 'TimeoutError' ? 'timeout' : 'network'
        return { ok: false, kind, status: null, usage: null, billing: 'unknown' }
      }
      if (!res.ok) {
        await drain(res)
        // A 4xx is refused before any generation; a 5xx may have run part of the way.
        const billing: Billing = res.status >= 400 && res.status < 500 ? 'none' : 'unknown'
        return { ok: false, kind: 'http', status: res.status, usage: null, billing }
      }
      let text: string
      try {
        text = await readCapped(res, MAX_RESPONSE_BYTES)
      } catch (e) {
        const kind =
          e instanceof TooLarge ? 'too-large' : (e as Error)?.name === 'TimeoutError' ? 'timeout' : 'network'
        return { ok: false, kind, status: res.status, usage: null, billing: 'unknown' }
      }
      let raw: unknown
      try {
        raw = JSON.parse(text)
      } catch {
        return { ok: false, kind: 'bad-response', status: res.status, usage: null, billing: 'unknown' }
      }
      const envelope = Envelope.safeParse(raw)
      const usage = readUsage((raw as { usage?: unknown } | null)?.usage)
      const billing: Billing = usage ? 'usage' : 'unknown'
      if (!envelope.success) return { ok: false, kind: 'bad-response', status: res.status, usage, billing }
      const choice = envelope.data.choices[0]
      const refusal = choice?.message?.refusal
      if (typeof refusal === 'string' && refusal.trim())
        return { ok: false, kind: 'refused', status: res.status, usage, billing }
      if (choice?.finish_reason === 'length')
        return { ok: false, kind: 'truncated', status: res.status, usage, billing }
      const content = choice?.message?.content
      if (typeof content !== 'string' || !content.trim())
        return { ok: false, kind: 'bad-json', status: res.status, usage, billing }
      try {
        return { ok: true, json: JSON.parse(content), usage, billing }
      } catch {
        return { ok: false, kind: 'bad-json', status: res.status, usage, billing }
      }
    },
  }
}
