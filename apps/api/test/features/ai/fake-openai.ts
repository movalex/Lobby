// A local stand-in for OpenAI's chat completions endpoint (docs/WAVE4-CONTRACTS.md §4 ai-assist): a tiny
// node:http server the api reaches through OPENAI_BASE_URL. Tests NEVER call the real API.
//
// By default it answers like a well-behaved model, from the items the api put into the prompt (so the
// answers name the aliases it was sent). `next(...)` queues canned answers instead: malformed,
// oversized, hostile (ids it was never sent, floods of entries), refusals, HTTP errors and stalls.

import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface SeenRequest {
  headers: IncomingMessage['headers']
  body: {
    model?: string
    messages?: { role: string; content: string }[]
    response_format?: { type: string; json_schema?: { name: string; strict: boolean; schema: unknown } }
    max_completion_tokens?: number
    reasoning_effort?: string
    store?: boolean
    [k: string]: unknown
  }
  /** The raw body as received. */
  raw: string
}

export interface FakeItem {
  id: string
  type: string
  text: string
}

/** One canned answer. `content` is the model's JSON (serialized for you unless it is a string). */
export type FakeAnswer =
  | { kind: 'content'; content: unknown; finish?: string; usage?: unknown }
  | { kind: 'refusal'; text: string }
  | { kind: 'status'; status: number; body?: string }
  | { kind: 'raw'; body: string; status?: number }
  | { kind: 'stall'; ms: number }
  /** Headers at once, then the body a byte every `everyMs` (a slow or stuck upstream mid-answer). */
  | { kind: 'trickle'; everyMs: number; bytes: number }
  | { kind: 'huge'; bytes: number }
  | { kind: 'no-usage'; content: unknown }
  /**
   * Billed like the worst case of a byte-level BPE tokenizer: a prompt token per UTF-8 byte of the
   * messages and the response schema, plus the chat framing (symbols, rare scripts and punctuation
   * soup get close to that; no real tokenizer makes more).
   */
  | { kind: 'byte-usage'; content: unknown }

export interface FakeOpenAi {
  /** OPENAI_BASE_URL for the api (…/v1). */
  url: string
  requests: SeenRequest[]
  /** Queues answers for the next requests (first in, first out); the default answer resumes after. */
  next(...answers: FakeAnswer[]): void
  close(): Promise<void>
}

/** The items the api put between the prompt's <<<ITEMS / ITEMS>>> lines. */
export function itemsOf(req: SeenRequest): FakeItem[] {
  const user = req.body.messages?.find((m) => m.role === 'user')?.content ?? ''
  const start = user.indexOf('<<<ITEMS\n')
  const end = user.lastIndexOf('\nITEMS>>>')
  if (start < 0 || end < 0) return []
  return user
    .slice(start + '<<<ITEMS\n'.length, end)
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FakeItem)
}

/** A plausible answer to any of the four actions (by the response schema's name). */
export function defaultAnswer(req: SeenRequest): unknown {
  const items = itemsOf(req)
  const schema = req.body.response_format?.json_schema?.name
  const user = req.body.messages?.find((m) => m.role === 'user')?.content ?? ''
  switch (schema) {
    case 'lobby_summary':
      return { summary: `The board holds ${items.length} items. ${items[0]?.text ?? ''}`.trim() }
    case 'lobby_themes': {
      const half = Math.ceil(items.length / 2)
      return {
        themes: [
          { name: 'First Half', note_ids: items.slice(0, half).map((i) => i.id) },
          { name: 'Second Half', note_ids: items.slice(half).map((i) => i.id) },
        ],
      }
    }
    case 'lobby_action_items':
      return {
        items: items.slice(0, 3).map((i, k) => ({
          task: `Follow up on ${i.text.slice(0, 40)}`,
          owner: k === 0 ? 'Sam' : null,
        })),
      }
    case 'lobby_ideas': {
      const n = Number(/Write exactly (\d+) new/.exec(user)?.[1] ?? 3)
      return { ideas: Array.from({ length: n }, (_, k) => `Fresh idea number ${k + 1}`) }
    }
    default:
      return {}
  }
}

const usageFor = (req: SeenRequest, content: string) => {
  const prompt = Math.ceil(req.raw.length / 4)
  const completion = Math.ceil(content.length / 4)
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion }
}

function envelope(req: SeenRequest, content: string | null, extra: Record<string, unknown> = {}) {
  return {
    id: 'chatcmpl-fake',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: req.body.model ?? 'fake',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content, refusal: null, ...(extra.message as object) },
        finish_reason: (extra.finish as string) ?? 'stop',
      },
    ],
    usage: extra.usage === undefined ? usageFor(req, content ?? '') : extra.usage,
  }
}

export async function startFakeOpenAi(): Promise<FakeOpenAi> {
  const requests: SeenRequest[] = []
  const queue: FakeAnswer[] = []
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      let body: SeenRequest['body'] = {}
      try {
        body = JSON.parse(raw)
      } catch {
        // recorded as empty
      }
      const seen: SeenRequest = { headers: req.headers, body, raw }
      requests.push(seen)
      const send = (status: number, payload: string) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(payload)
      }
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return send(404, '{"error":{}}')
      const answer = queue.shift()
      if (!answer) {
        const content = JSON.stringify(defaultAnswer(seen))
        return send(200, JSON.stringify(envelope(seen, content)))
      }
      switch (answer.kind) {
        case 'content': {
          const content = typeof answer.content === 'string' ? answer.content : JSON.stringify(answer.content)
          return send(
            200,
            JSON.stringify(envelope(seen, content, { finish: answer.finish, usage: answer.usage })),
          )
        }
        case 'byte-usage': {
          const content = JSON.stringify(answer.content)
          const messages = seen.body.messages ?? []
          const prompt =
            messages.reduce((n, m) => n + Buffer.byteLength(m.content, 'utf8') + 3, 0) +
            Buffer.byteLength(JSON.stringify(seen.body.response_format?.json_schema?.schema ?? {}), 'utf8') +
            3
          const completion = Math.ceil(content.length / 4)
          const usage = {
            prompt_tokens: prompt,
            completion_tokens: completion,
            total_tokens: prompt + completion,
          }
          return send(200, JSON.stringify(envelope(seen, content, { usage })))
        }
        case 'no-usage': {
          const content = JSON.stringify(answer.content)
          const env = envelope(seen, content) as Record<string, unknown>
          delete env.usage
          return send(200, JSON.stringify(env))
        }
        case 'refusal':
          return send(200, JSON.stringify(envelope(seen, null, { message: { refusal: answer.text } })))
        case 'status':
          return send(answer.status, answer.body ?? '{"error":{"message":"fake failure"}}')
        case 'raw':
          return send(answer.status ?? 200, answer.body)
        case 'stall': {
          const t = setTimeout(
            () => send(200, JSON.stringify(envelope(seen, '{"summary":"late"}'))),
            answer.ms,
          )
          res.on('close', () => clearTimeout(t))
          return
        }
        case 'trickle': {
          res.writeHead(200, { 'content-type': 'application/json' })
          let left = answer.bytes
          const t = setInterval(() => {
            if (left-- <= 0) {
              clearInterval(t)
              return void res.end()
            }
            res.write(' ')
          }, answer.everyMs)
          res.on('close', () => clearInterval(t))
          res.on('error', () => {})
          return
        }
        case 'huge': {
          res.writeHead(200, { 'content-type': 'application/json' })
          const chunk = 'x'.repeat(64 * 1024)
          let left = answer.bytes
          const pump = () => {
            while (left > 0) {
              left -= chunk.length
              if (!res.write(chunk)) return void res.once('drain', pump)
            }
            res.end()
          }
          res.on('error', () => {})
          return pump()
        }
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    next: (...answers) => queue.push(...answers),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
