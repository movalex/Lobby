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
  /** Wave M (M8-2): `content` after `ms` (the model answers while something changes meanwhile). */
  | { kind: 'delayed'; ms: number; content: unknown }
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

/**
 * A message's text (wave N, WS5: a capture photo's user message is an array of a text part and an image part; typed
 * as a string for the older tests, which never see one).
 */
export function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const text = (p: unknown) =>
    p && typeof p === 'object' && (p as { type?: unknown }).type === 'text'
      ? String((p as { text?: unknown }).text ?? '')
      : ''
  return content.map(text).join('\n')
}

/** The image parts of a request's user message (wave N, WS5): what was sent, as the request carried it. */
export function imagePartsOf(req: SeenRequest): { url: string; detail: string | null }[] {
  const out: { url: string; detail: string | null }[] = []
  for (const m of req.body.messages ?? []) {
    const content = m.content as unknown
    if (!Array.isArray(content)) continue
    for (const p of content as { type?: unknown; image_url?: { url?: unknown; detail?: unknown } }[])
      if (p?.type === 'image_url')
        out.push({
          url: String(p.image_url?.url ?? ''),
          detail: typeof p.image_url?.detail === 'string' ? p.image_url.detail : null,
        })
  }
  return out
}

/** The user message's text. */
export const userTextOf = (req: SeenRequest): string =>
  textOf(req.body.messages?.find((m) => m.role === 'user')?.content)

/** The items the api put between the prompt's <<<ITEMS / ITEMS>>> lines. */
export function itemsOf(req: SeenRequest): FakeItem[] {
  const user = userTextOf(req)
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
  const user = userTextOf(req)
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
    default: {
      const waveL = waveLAnswer(schema, items)
      if (waveL !== undefined) return waveL
      const capture = captureAnswer(schema, req)
      return capture === undefined ? {} : capture
    }
  }
}

/**
 * Wave L (W1): the canned model answers for the six new actions and the vote-weighted actions, by response schema name, from
 * the items the api sent (so they name only aliases it was sent). These are the MODEL's JSON shapes, the
 * ones W1's prompt.ts schemas ask for and its plan.ts validates and maps back (alias ids, snake_case like
 * `note_ids`); the api's results (contracts AiResult) are what plan.ts makes of them. Undefined for any
 * other schema name. W1 owns this file and adjusts a shape here together with its prompt schema.
 *
 * - lobby_recap   {title, summary, decisions[{text, ids}], actions[{task, owner, ids}], questions[{text, ids}]}
 * - lobby_answer  {answer, found: 'yes' | 'partial' | 'no', citations[{ids}]}   ([n] in the answer = citations[n-1])
 * - lobby_command {ops[AiCommandOp with alias ids], explain}
 * - lobby_diagram {nodes[{id, label, kind}], edges[{from, to, label}]}         (the model's own node ids)
 * - lobby_sort    {themes[{name, note_ids}]}                                  (themes' shape, named by the lens)
 * - lobby_score   {scores[{id, x, y}]}                                        (integers from -5 to 5)
 * - lobby_voted_actions {items[{task, owner, ids}]}                          (vote-weighted actions, L1-7)
 */
export function waveLAnswer(schema: string | undefined, items: readonly FakeItem[]): unknown {
  const ids = items.map((i) => i.id)
  switch (schema) {
    case 'lobby_recap':
      return {
        title: 'Session recap',
        summary: `The session covered ${items.length} items.`,
        decisions: ids.slice(0, 1).map((id) => ({ text: `Go with ${id}`, ids: [id] })),
        actions: ids.slice(1, 3).map((id) => ({ task: `Follow up on ${id}`, owner: null, ids: [id] })),
        questions: ids.slice(3, 4).map((id) => ({ text: `What about ${id}?`, ids: [id] })),
      }
    case 'lobby_answer':
      return items.length
        ? { answer: 'The board says so [1].', found: 'yes', citations: [{ ids: ids.slice(0, 2) }] }
        : { answer: '', found: 'no', citations: [] }
    case 'lobby_command':
      return {
        ops: ids.length ? [{ op: 'select', ids: ids.slice(0, 3) }] : [],
        explain: `Selected ${Math.min(3, ids.length)} items`,
      }
    case 'lobby_diagram':
      return {
        nodes: [
          { id: 'start', label: 'Start', kind: 'terminal' },
          { id: 'work', label: items[0]?.text.slice(0, 40) || 'Do the work', kind: 'process' },
          { id: 'ok', label: 'Done?', kind: 'decision' },
          { id: 'end', label: 'End', kind: 'terminal' },
        ],
        edges: [
          { from: 'start', to: 'work', label: '' },
          { from: 'work', to: 'ok', label: '' },
          { from: 'ok', to: 'end', label: 'yes' },
          { from: 'ok', to: 'work', label: 'no' },
        ],
      }
    case 'lobby_sort': {
      const half = Math.ceil(ids.length / 2)
      return {
        themes: [
          { name: 'Sooner', note_ids: ids.slice(0, half) },
          { name: 'Later', note_ids: ids.slice(half) },
        ],
      }
    }
    case 'lobby_voted_actions':
      // in the order sent (reading order): the api re-sorts them by the vote tallies
      return {
        items: items
          .slice(0, 4)
          .map((i) => ({ task: `Follow up on ${i.text.slice(0, 40)}`, owner: null, ids: [i.id] })),
      }
    case 'lobby_score':
      return { scores: ids.map((id, k) => ({ id, x: (k % 11) - 5, y: 5 - (k % 11) })) }
    default:
      return undefined
  }
}

/**
 * Wave N (WS5, Capture the room): the canned model answers for the capture schemas (capture-prompt.ts), the MODEL's
 * shapes (its own node ids, indexes into its notes), which capture-plan.ts validates and maps:
 * - lobby_capture_notes / _auto  three notes in two columns, two groups (auto: kind 'notes')
 * - lobby_capture_diagram        three nodes (its own ids) and two edges, one labelled
 * - lobby_capture_meeting        a theme per part from the transcript's first lines, a decision and an action
 * - lobby_capture_themes         every note sent in one theme
 */
export function captureAnswer(schema: string | undefined, req: SeenRequest): unknown {
  const notes = [
    { text: 'Keep the demo', color: 'yellow', box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } },
    { text: 'Shorter stand-ups', color: 'light-red', box: { x: 0.1, y: 0.4, w: 0.2, h: 0.2 } },
    { text: 'Slow builds', color: 'orange', box: { x: 0.6, y: 0.1, w: 0.2, h: 0.2 } },
  ]
  const groups = [
    { name: 'Keep', notes: [0, 1] },
    { name: 'Change', notes: [2] },
  ]
  const nodes = [
    { id: 'start', label: 'Brief', shape: 'ellipse', box: { x: 0.05, y: 0.4, w: 0.15, h: 0.1 } },
    { id: 'work', label: 'Sketch', shape: 'rect', box: { x: 0.4, y: 0.4, w: 0.15, h: 0.1 } },
    { id: 'ok', label: 'Happy?', shape: 'diamond', box: null },
  ]
  const edges = [
    { from: 'start', to: 'work', label: '', kind: 'arrow' },
    { from: 'work', to: 'ok', label: 'review', kind: 'line' },
  ]
  const user = userTextOf(req)
  switch (schema) {
    case 'lobby_capture_notes':
      return { notes, groups }
    case 'lobby_capture_diagram':
      return { nodes, edges }
    case 'lobby_capture_auto':
      return { kind: 'notes', notes, groups, nodes: [], edges: [] }
    case 'lobby_capture_meeting': {
      const start = user.indexOf('<<<TRANSCRIPT\n')
      const end = user.lastIndexOf('\nTRANSCRIPT>>>')
      const lines =
        start < 0 || end < 0
          ? []
          : user
              .slice(start + '<<<TRANSCRIPT\n'.length, end)
              .split('\n')
              .map((l) => l.trim())
              .filter(Boolean)
      const part = Number(/part (\d+) of/.exec(user)?.[1] ?? 1)
      return {
        themes: [{ name: `Theme ${part}`, notes: lines.slice(0, 2).map((l) => l.slice(0, 120)) }],
        decisions: [`Decision ${part}`],
        actions: [{ text: `Action ${part}`, owner: null }],
      }
    }
    case 'lobby_capture_themes': {
      const ids = [...user.matchAll(/"id":"(t\d+)"/g)].map((m) => m[1])
      return { themes: [{ name: 'Whole meeting', note_ids: ids }] }
    }
    default:
      return undefined
  }
}

/** An image's prompt tokens as the fake bills them (a high-detail 2048 px image on a patch-based model, roughly). */
export const FAKE_IMAGE_TOKENS = 2_500
const DATA_URL_RE = /data:image\/[a-z]+;base64,[A-Za-z0-9+/=]+/g

const usageFor = (req: SeenRequest, content: string) => {
  // an image is billed as FAKE_IMAGE_TOKENS, never by its base64 length
  const images = req.raw.match(DATA_URL_RE)?.length ?? 0
  const prompt = Math.ceil(req.raw.replace(DATA_URL_RE, '').length / 4) + images * FAKE_IMAGE_TOKENS
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
            messages.reduce((n, m) => n + Buffer.byteLength(textOf(m.content), 'utf8') + 3, 0) +
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
        case 'delayed': {
          const content = JSON.stringify(answer.content)
          const t = setTimeout(() => send(200, JSON.stringify(envelope(seen, content))), answer.ms)
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
