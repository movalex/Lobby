// The fake webhook receiver of the chat notification tests (wave R, WS2; AGENTS.md "Server egress exception: chat
// notifications"). A local node:http server that stands in for Slack and for Teams Workflows: it records every POST it gets and
// answers 200 `ok` (Slack) or 202 (Teams) unless the test scripted another answer. The suites NEVER call the real
// services: the api reaches this server only through DRAFTROOM_CHAT_HOOK_TEST_ORIGINS (local dev only: it requires
// DRAFTROOM_DEV_AUTH=1), where each origin stands for its provider's host; the provider's path and query rules still apply.
//
// Imports nothing of the e2e stack, so the api's own tests use it too (apps/api/test/features/chat-hooks).

import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'

export interface ReceivedPost {
  method: string
  path: string
  query: string
  headers: IncomingHttpHeaders
  raw: string
  /** the JSON body, or null when it was not JSON */
  body: Record<string, unknown> | null
}

export interface FakeAnswer {
  status: number
  /** sent as Retry-After (seconds) */
  retryAfter?: number
  body?: string
  /** answer only after this long */
  delayMs?: number
  /** never answer (the api's 5 s deadline fires) */
  stall?: boolean
}

export interface FakeReceiver {
  /** `http://127.0.0.1:<port>`: what DRAFTROOM_CHAT_HOOK_TEST_ORIGINS names */
  origin: string
  port: number
  /** every POST received, oldest first */
  posts: ReceivedPost[]
  /** queue answers for the next requests (then the defaults again) */
  next(...answers: FakeAnswer[]): void
  /** forget the posts and the queued answers */
  reset(): void
  close(): Promise<void>
}

/** Slack's answer to an accepted message is 200 `ok`; Teams Workflows answers 202 (queued, not delivered). */
export function defaultAnswer(path: string): FakeAnswer {
  return path.startsWith('/powerautomate/') ? { status: 202 } : { status: 200, body: 'ok' }
}

export async function startFakeReceiver(port = 0, host = '127.0.0.1'): Promise<FakeReceiver> {
  const posts: ReceivedPost[] = []
  const queue: FakeAnswer[] = []
  const sockets = new Set<Socket>()
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const [path = '', query = ''] = (req.url ?? '').split('?')
      let body: Record<string, unknown> | null = null
      try {
        const parsed: unknown = JSON.parse(raw)
        body = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null
      } catch {
        body = null
      }
      posts.push({ method: req.method ?? '', path, query, headers: req.headers, raw, body })
      const answer = queue.shift() ?? defaultAnswer(path)
      if (answer.stall) return
      const send = () => {
        res.writeHead(answer.status, {
          'content-type': 'text/plain',
          ...(answer.retryAfter !== undefined ? { 'retry-after': String(answer.retryAfter) } : {}),
        })
        res.end(answer.body ?? '')
      }
      if (answer.delayMs) setTimeout(send, answer.delayMs)
      else send()
    })
  })
  server.on('connection', (s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, resolve)
  })
  const actual = (server.address() as AddressInfo).port
  return {
    origin: `http://${host}:${actual}`,
    port: actual,
    posts,
    next: (...answers) => {
      queue.push(...answers)
    },
    reset: () => {
      posts.length = 0
      queue.length = 0
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy()
        server.close(() => resolve())
      }),
  }
}

/** A Slack incoming-webhook URL on the receiver (the path Slack's rule wants; `suffix` tells hooks apart). */
export const slackHookUrl = (origin: string, suffix = 'abcdEFGH1234') =>
  `${origin}/services/T0000000A/B0000000B/${suffix}`

/** A Teams Workflows URL on the receiver: the path and the four query keys the Teams rule wants. */
export const teamsHookUrl = (origin: string, sig = 'SIGSECRET1234') =>
  `${origin}/powerautomate/automations/direct/workflows/0123abcdef/triggers/manual/paths/invoke?api-version=1&sp=%2Ftriggers%2Fmanual%2Frun&sv=1.0&sig=${sig}`
