// ai-assist e2e support (docs/WAVE4-CONTRACTS.md §4): a local stand-in for OpenAI's chat completions
// endpoint that the stack's api reaches through OPENAI_BASE_URL (StackOptions.apiEnv). The suite NEVER
// calls the real API: the stack also strips any OPENAI_* variable from the developer's shell.
//
// By default the fake answers like a sensible model, from the items the api put into the prompt (so
// its answers only ever name the aliases it was sent). For the Lobby tour's Brainstorm notes it groups
// them into three themes the way a person would. `next(...)` queues canned answers instead: hostile,
// malformed or expensive ones.

import { createServer, type IncomingMessage, type Server } from 'node:http'
import { HOST, PORT_BASE } from './ports.ts'

/** base + 3: next to the stack's sync (base), api (base + 1) and web (base + 2) ports. */
export const FAKE_OPENAI_PORT = PORT_BASE === null ? 5889 : PORT_BASE + 3
export const FAKE_OPENAI_URL = `http://${HOST}:${FAKE_OPENAI_PORT}/v1`
export const FAKE_KEY = 'sk-e2e-fake-key-not-a-real-one-0123456789'

/** The api env of the ai-assist suite's stack. */
export const AI_API_ENV: Record<string, string> = {
  OPENAI_API_KEY: FAKE_KEY,
  OPENAI_BASE_URL: FAKE_OPENAI_URL,
  OPENAI_MODEL: 'gpt-5.4-mini',
  DRAFTROOM_AI: 'on',
}

export interface SeenRequest {
  headers: IncomingMessage['headers']
  body: {
    model?: string
    messages?: { role: string; content: string }[]
    response_format?: { json_schema?: { name?: string } }
    [k: string]: unknown
  }
  raw: string
}

export interface FakeItem {
  id: string
  type: string
  text: string
}

export type FakeAnswer =
  | { kind: 'content'; content: unknown; usage?: unknown }
  | { kind: 'status'; status: number }
  | { kind: 'stall'; ms: number }

export interface FakeOpenAi {
  requests: SeenRequest[]
  next(...answers: FakeAnswer[]): void
  /** Forgets queued answers and seen requests. */
  reset(): void
  close(): Promise<void>
}

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

/** How a person would group the tour's Brainstorm notes; anything else is split in three. */
const TOUR_THEMES: [string, RegExp][] = [
  ['Big Gameplay Moments', /boss fight|unbroken shot|co-op/i],
  ['Story Twists', /villain|ending|rewind/i],
  ['Made With Players', /player clips|code in the last|creators|premiere/i],
]

export function themesFor(items: readonly FakeItem[]) {
  const groups = TOUR_THEMES.map(([name]) => ({ name, note_ids: [] as string[] }))
  const rest: string[] = []
  for (const item of items) {
    const i = TOUR_THEMES.findIndex(([, re]) => re.test(item.text))
    if (i >= 0) groups[i]?.note_ids.push(item.id)
    else rest.push(item.id)
  }
  if (groups.every((g) => g.note_ids.length === 0)) {
    const third = Math.ceil(items.length / 3)
    return [
      { name: 'First Thoughts', note_ids: items.slice(0, third).map((i) => i.id) },
      { name: 'Next Steps', note_ids: items.slice(third, third * 2).map((i) => i.id) },
      { name: 'Open Questions', note_ids: items.slice(third * 2).map((i) => i.id) },
    ].filter((g) => g.note_ids.length)
  }
  // Notes that match nothing join the smallest theme, as a model would put them somewhere.
  const smallest = groups.reduce((a, b) => (b.note_ids.length < a.note_ids.length ? b : a))
  smallest.note_ids.push(...rest)
  return groups.filter((g) => g.note_ids.length)
}

export function defaultAnswer(req: SeenRequest): unknown {
  const items = itemsOf(req)
  const user = req.body.messages?.find((m) => m.role === 'user')?.content ?? ''
  switch (req.body.response_format?.json_schema?.name) {
    case 'lobby_summary':
      return {
        summary: `The team is looking for the launch trailer's hook. ${items.length} ideas cover big gameplay moments, story twists and ways to make it with players.`,
      }
    case 'lobby_themes':
      return { themes: themesFor(items) }
    case 'lobby_action_items':
      return {
        items: [
          { task: 'Cut a rough edit of the boss-fight opening', owner: 'Sam' },
          { task: 'Ask three creators about a live premiere', owner: null },
          { task: 'Collect player clips from the beta', owner: 'Priya' },
        ],
      }
    case 'lobby_ideas': {
      const n = Number(/Write exactly (\d+) new/.exec(user)?.[1] ?? 3)
      const pool = [
        'Countdown built from player deaths',
        'Trailer that plays backwards',
        'Hide the logo in the final boss arena',
        'Let the villain narrate',
        'Live co-op premiere with two creators',
        'A one-shot through every biome',
        'Fans vote on the ending shot',
        'Silent trailer, only game sounds',
        'Map reveal drawn by hand',
        'Speedrunner commentary cut',
        'Behind-the-scenes teaser first',
        'Trailer inside the game engine',
      ]
      return { ideas: Array.from({ length: n }, (_, i) => pool[i % pool.length]) }
    }
    default:
      return {}
  }
}

function envelope(req: SeenRequest, content: string, usage?: unknown) {
  const prompt = Math.ceil(req.raw.length / 4)
  const completion = Math.ceil(content.length / 4)
  return {
    id: 'chatcmpl-e2e',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: req.body.model ?? 'fake',
    choices: [{ index: 0, message: { role: 'assistant', content, refusal: null }, finish_reason: 'stop' }],
    usage: usage ?? {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: prompt + completion,
    },
  }
}

export async function startFakeOpenAi(port = FAKE_OPENAI_PORT): Promise<FakeOpenAi> {
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
      const seen = { headers: req.headers, body, raw }
      requests.push(seen)
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(payload))
      }
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') return send(404, { error: {} })
      if (req.headers.authorization !== `Bearer ${FAKE_KEY}`) return send(401, { error: {} })
      const answer = queue.shift()
      if (!answer) return send(200, envelope(seen, JSON.stringify(defaultAnswer(seen))))
      if (answer.kind === 'status') return send(answer.status, { error: { message: 'fake failure' } })
      if (answer.kind === 'stall') {
        const t = setTimeout(() => send(200, envelope(seen, JSON.stringify(defaultAnswer(seen)))), answer.ms)
        res.on('close', () => clearTimeout(t))
        return
      }
      const content = typeof answer.content === 'string' ? answer.content : JSON.stringify(answer.content)
      return send(200, envelope(seen, content, answer.usage))
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, HOST, () => resolve())
  })
  return {
    requests,
    next: (...answers) => queue.push(...answers),
    reset: () => {
      queue.length = 0
      requests.length = 0
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
