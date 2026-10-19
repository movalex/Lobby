// OWNER: WS1 (wave W, doc cards; docs/WAVE-W-CONTRACTS.md §2 "Risks"). What a long doc card costs the room: one
// doc card per typist, each holding `--chars` characters of Markdown-lite words, every typist pushing its whole label
// (`originalText` and the wrapped `text`, plus the card's fit when it grows) every `--push-ms` ms as the side panel
// does (TYPING_PUSH_MS), under its text lease (renewed through presence `editing`), and `--watchers` viewers
// receiving every change. Plain Node 24, raw sockets on the frozen protocol (no engine core: the pushes are exactly
// the panel's holder writes, laid out with the server's own helper, canvas-schema `layoutBoundText`).
//
//   node e2e/load/doc-cards.ts --sync http://<sync>:5858 --api-listen 0.0.0.0:7899 --chars 20000 --typists 1 \
//     --watchers 30 --duration-s 120 --out /reports/doc-20000-1.json
//   node e2e/load/doc-cards.ts --relayout-only --chars 20000 --out /reports/relayout-20000.json
//
// Measured: push → ack per push (the typists, ms), push → seen by every watcher (A→B through the server, ms), the
// bytes of one push, the server's own histograms over the run (GET /internal/metrics: commit, receive-to-ack,
// push-to-commit, commit-to-fan-out; the event-loop delay since the process started, so each scenario runs on a
// fresh sync), and, with --relayout-only, the time of one server relayout of such a card (canvas-schema
// `layoutBoundText`, the room's §2.9.4 rule 6 when a holder's lease lapses), run in the container the NAS script gives
// the sync's CPU limit. Secrets come from DRAFTROOM_TICKET_SECRET and DRAFTROOM_INTERNAL_SECRET (never printed).
// Nothing of the words is logged; the report holds numbers only.
import { writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { ticketProtocols } from '../../apps/web/src/board/ticket-protocol.ts'
import { checkElement, type WireElement } from '../../packages/canvas-schema/src/elements.ts'
import {
  installedServerTextMetrics,
  installServerTextMetrics,
  layoutBoundText,
} from '../../packages/canvas-schema/src/engine/index.ts'
import {
  ELEMENT_SCHEMA_VERSION,
  PROTO,
  type ServerMessage,
} from '../../packages/canvas-schema/src/protocol.ts'
import { startFakeApi } from './fake-api.ts'
import { parsePrometheus } from './metrics.ts'
import { seedElements } from './seed.ts'
import { summarize } from './stats.ts'
import { mintTicket, newRunSecrets, secretsFromEnv } from './tickets.ts'

const BOARD = 'brd_doccardsload0001'
const UPDATED = 1_790_000_000_000

/** Deterministic Markdown-lite words of exactly `chars` characters (headings, checklists, paragraphs, links). */
export function docWords(chars: number, seed = 1): string {
  const parts = [
    '# Launch plan',
    '## Goals',
    '- [ ] Book the studio for the second week of shooting',
    '- [x] Send the brief to the agency and the legal team',
    '1. Casting call with the three shortlisted actors',
    '> Keep the logo small in the first three seconds of every cut.',
    'The opening should breathe: a slower push-in on the product before the reveal, **golden hour** light, and',
    'a two-word headline in lowercase. See the [moodboard](https://example.com/mood) for the colour grade.',
    '---',
  ]
  let out = ''
  let i = seed
  while (out.length < chars) {
    out += `${parts[i % parts.length]}\n`
    i++
  }
  return out.slice(0, chars)
}

/** The doc card (a rectangle of kind doc-card) and its bound label holding `words`, laid out as the room lays it out. */
export function docCardElements(id: string, x: number, y: number, words: string): WireElement[] {
  if (!installedServerTextMetrics()) installServerTextMetrics()
  const base = {
    angle: 0,
    strokeColor: '#c4bfb0',
    fillStyle: 'solid' as const,
    strokeWidth: 1,
    strokeStyle: 'solid' as const,
    roughness: 0,
    opacity: 100,
    version: 1,
    isDeleted: false,
    groupIds: [] as string[],
    frameId: null,
    updated: UPDATED,
    created: UPDATED,
    link: null,
    locked: false,
    index: null,
  }
  const card = {
    ...base,
    id,
    type: 'rectangle',
    x,
    y,
    width: 640,
    height: 400,
    backgroundColor: '#ffffff',
    roundness: { type: 3, value: 8 },
    seed: 11,
    versionNonce: 12,
    boundElements: [{ id: `${id}.t`, type: 'text' }],
    customData: { lobby: { kind: 'doc-card' } },
  }
  const label = {
    ...base,
    id: `${id}.t`,
    type: 'text',
    x: x + 5,
    y: y + 5,
    width: 630,
    height: 20,
    strokeColor: '#1b2330',
    backgroundColor: 'transparent',
    roundness: null,
    seed: 13,
    versionNonce: 14,
    boundElements: null,
    text: words,
    originalText: words,
    fontSize: 16,
    baseFontSize: null,
    fontFamily: 6,
    textAlign: 'left',
    verticalAlign: 'top',
    containerId: id,
    autoResize: true,
    lineHeight: 1.25,
  }
  const lay = layoutBoundText(card as never, label as never)
  const out = [
    { ...card, height: lay.container.height },
    { ...label, ...lay.text },
  ] as unknown as WireElement[]
  for (const el of out) {
    const c = checkElement(el)
    if (!c.ok) throw new Error(`doc card element ${el.id} fails the schema: ${c.detail}`)
  }
  return out
}

/** One server relayout of a doc card holding `chars` characters (ms), `n` times. */
export function measureRelayout(chars: number, n: number): number[] {
  const [card, label] = docCardElements('dcrelayout', 0, 0, docWords(chars))
  const ms: number[] = []
  for (let i = 0; i < n; i++) {
    const t0 = performance.now()
    layoutBoundText({ ...(card as object), height: 400 } as never, label as never)
    ms.push(performance.now() - t0)
  }
  return ms
}

// ---- a raw board socket ------------------------------------------------------------------------------------------

interface Sock {
  readonly ws: WebSocket
  readonly welcome: Extract<ServerMessage, { type: 'welcome' }>
  send(m: unknown): void
  on(fn: (m: ServerMessage, raw: string) => void): void
  close(): void
  bytesIn: number
}

async function openSocket(sync: string, ticket: string, tab: string): Promise<Sock> {
  const protocols = ticketProtocols(ticket)
  const query = protocols ? { sessionId: tab } : { sessionId: tab, ticket }
  const url = `${sync.replace(/^http/, 'ws')}/connect/${BOARD}?${new URLSearchParams(query)}`
  const ws = protocols ? new WebSocket(url, protocols) : new WebSocket(url)
  ws.binaryType = 'arraybuffer'
  const listeners: ((m: ServerMessage, raw: string) => void)[] = []
  let welcome: Sock['welcome'] | null = null
  const sock = {
    ws,
    bytesIn: 0,
    send: (m: unknown) => ws.send(JSON.stringify(m)),
    on: (fn: (m: ServerMessage, raw: string) => void) => listeners.push(fn),
    close: () => ws.close(1000, 'done'),
  } as unknown as Sock & { bytesIn: number }
  const got = new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`no welcome for ${tab}`)), 60_000)
    ws.addEventListener('message', (e) => {
      if (typeof e.data !== 'string') {
        sock.bytesIn += (e.data as ArrayBuffer).byteLength
        return
      }
      sock.bytesIn += e.data.length
      const m = JSON.parse(e.data) as ServerMessage
      if (m.type === 'welcome' && !welcome) {
        welcome = m
        ;(sock as { welcome: unknown }).welcome = m
        clearTimeout(t)
        resolve()
      }
      for (const l of listeners) l(m, e.data)
    })
    ws.addEventListener('error', () => reject(new Error(`socket ${tab} failed`)), { once: true })
  })
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true })
    ws.addEventListener('error', () => reject(new Error(`socket ${tab} failed to open`)), { once: true })
  })
  sock.send({ type: 'hello', proto: PROTO, schema: ELEMENT_SCHEMA_VERSION, since: 0, epoch: null, tab })
  await got
  return sock
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ---- the run -----------------------------------------------------------------------------------------------------

interface Hist {
  readonly buckets: [number, number][]
  readonly count: number
  readonly sum: number
}

function histOf(text: string, name: string): Hist {
  const samples = parsePrometheus(text)
  const buckets = samples
    .filter((s) => s.name === `${name}_bucket`)
    .map(
      (s) =>
        [s.labels.le === '+Inf' ? Number.POSITIVE_INFINITY : Number(s.labels.le), s.value] as [
          number,
          number,
        ],
    )
  const count = samples.find((s) => s.name === `${name}_count`)?.value ?? 0
  const sum = samples.find((s) => s.name === `${name}_sum`)?.value ?? 0
  return { buckets, count, sum }
}

/** The window between two scrapes of a histogram: count, mean and the bucket bound holding p50/p95/p99. */
function windowOf(a: Hist, b: Hist) {
  const count = b.count - a.count
  const q = (p: number) => {
    const want = Math.ceil(p * count)
    for (const [le, n] of b.buckets) {
      const before = a.buckets.find(([l]) => l === le)?.[1] ?? 0
      if (n - before >= want) return le
    }
    return null
  }
  return {
    count,
    mean: count ? Math.round(((b.sum - a.sum) / count) * 10) / 10 : null,
    p50le: q(0.5),
    p95le: q(0.95),
    p99le: q(0.99),
  }
}

async function scrape(sync: string, secret: string): Promise<string> {
  const res = await fetch(`${sync}/internal/metrics`, { headers: { 'x-draftroom-internal': secret } })
  return res.ok ? res.text() : ''
}

async function main() {
  const { values } = parseArgs({
    options: {
      sync: { type: 'string', default: 'http://127.0.0.1:7890' },
      'api-listen': { type: 'string', default: '127.0.0.1:7899' },
      chars: { type: 'string', default: '20000' },
      typists: { type: 'string', default: '1' },
      watchers: { type: 'string', default: '30' },
      'duration-s': { type: 'string', default: '120' },
      'push-ms': { type: 'string', default: '500' },
      'relayout-only': { type: 'boolean', default: false },
      fake: { type: 'boolean', default: false },
      out: { type: 'string' },
    },
  })
  const chars = Number(values.chars)
  if (values['relayout-only']) {
    const ms = measureRelayout(chars, 60)
    const report = { kind: 'relayout', chars, ms: summarize(ms.slice(10)) }
    if (values.out) writeFileSync(values.out, JSON.stringify(report, null, 2))
    console.log(`relayout ${chars} chars: ${JSON.stringify(report.ms)}`)
    return
  }
  const typists = Number(values.typists)
  const watchers = Number(values.watchers)
  const durationMs = Number(values['duration-s']) * 1_000
  const pushMs = Number(values['push-ms'])
  const sync = (values.sync as string).replace(/\/$/, '')
  const secrets = values.fake ? newRunSecrets() : secretsFromEnv()
  const [host, port] = (values['api-listen'] as string).split(':')
  const api = await startFakeApi({ internalSecret: secrets.internalSecret, host, port: Number(port) })
  const user = (n: number, role: 'editor' | 'viewer') => ({
    uid: `usr_dc${role[0]}${n.toString(36)}`,
    name: `Doc ${role} ${n}`,
    color: '#1971c2',
    role,
  })
  const editors = Array.from({ length: typists + 1 }, (_, i) => user(i, 'editor'))
  const viewers = Array.from({ length: watchers }, (_, i) => user(i, 'viewer'))
  api.addBoard(BOARD, [
    ...editors.map((u) => [u.uid, 'editor'] as [string, 'editor']),
    ...viewers.map((u) => [u.uid, 'viewer'] as [string, 'viewer']),
  ])
  const ticket = (u: (typeof editors)[number]) => mintTicket(secrets.ticketSecret, BOARD, u)

  // 1. the cards, seeded through the protocol by one more editor
  const seeder = await openSocket(sync, ticket(editors[typists] as never), 'dc-seed')
  const cards = Array.from({ length: typists }, (_, i) => `dccard${i}`)
  const words = docWords(chars)
  const els = cards.flatMap((id, i) => docCardElements(id, i * 800, 0, words))
  const pushBytes = Buffer.byteLength(JSON.stringify(els[1]))
  const acks: ((m: ServerMessage) => void)[] = []
  seeder.on((m) => {
    if (m.type === 'ack') for (const a of acks.splice(0)) a(m)
  })
  const seeded = await seedElements(
    {
      send: (m) => seeder.send(m),
      next: (type) =>
        new Promise((resolve) => {
          acks.push((m) => resolve(m as never))
        }) as never,
    },
    els,
    seeder.welcome.clock,
  )
  if (seeded.ok !== els.length)
    throw new Error(`seeding: ${seeded.ok}/${els.length} (${JSON.stringify(seeded.rejected)})`)
  seeder.close()

  // 2. the watchers: every change of a label noted with its arrival time
  const seen = new Map<string, number[]>()
  const watchSocks: Sock[] = []
  for (const [i, v] of viewers.entries()) {
    const s = await openSocket(sync, ticket(v as never), `dc-w${i}`)
    s.on((m) => {
      if (m.type !== 'changes') return
      const now = performance.now()
      for (const op of (m as { ops?: { id?: string; el?: { id: string; version: number }; v?: number }[] })
        .ops ?? []) {
        const id = op.el?.id ?? op.id
        const v = op.el?.version ?? op.v
        if (!id?.endsWith('.t') || v === undefined) continue
        const key = `${id}:${v}`
        const list = seen.get(key) ?? []
        list.push(now)
        seen.set(key, list)
      }
    })
    watchSocks.push(s)
  }

  // 3. the typists: the lease, then the whole label every push-ms, under it
  const before = await scrape(sync, secrets.internalSecret)
  const ackMs: number[] = []
  const visibleMs: number[] = []
  const sentAt = new Map<string, number>()
  const rejects: Record<string, number> = {}
  let pushes = 0
  let bytesOut = 0
  const t0 = performance.now()
  const runTypist = async (k: number) => {
    const id = cards[k] as string
    const labelId = `${id}.t`
    const s = await openSocket(sync, ticket(editors[k] as never), `dc-t${k}`)
    let clock = s.welcome.clock
    let pv = 1
    let cardPv = 1
    let seq = 0
    let cardH = 0
    const pending = new Map<number, { at: number; v: number }>()
    const granted = new Promise<boolean>((resolve) => {
      s.on((m) => {
        if (m.type === 'lease.grant' && m.id === id) resolve(true)
        if (m.type === 'lease.deny' && m.id === id) resolve(false)
      })
    })
    s.on((m) => {
      if (m.type !== 'ack') return
      clock = Math.max(clock, m.clock)
      const p = pending.get(m.seq)
      if (!p) return
      pending.delete(m.seq)
      ackMs.push(performance.now() - p.at)
      for (const r of m.r) {
        if (r.ok && r.id === labelId) {
          pv = r.v
          sentAt.set(`${labelId}:${r.v}`, p.at)
        } else if (r.ok && r.id === id) cardPv = r.v
        else if (!r.ok) rejects[r.code] = (rejects[r.code] ?? 0) + 1
      }
    })
    s.send({ type: 'lease.acquire', req: 1, id })
    if (!(await granted)) throw new Error(`typist ${k}: lease denied`)
    const card = els.find((e) => e.id === id) as unknown as Record<string, unknown>
    const label = els.find((e) => e.id === labelId) as unknown as Record<string, unknown>
    cardH = card.height as number
    let text = words
    let n = 0
    let lastPresence = 0
    while (performance.now() - t0 < durationMs) {
      // a few characters typed near the end; the length stays at the cap (what a full card costs)
      n++
      const tail = `${n % 1000}`.padStart(3, '0')
      text = `${text.slice(0, Math.max(0, chars - 3))}${tail}`.slice(0, chars)
      const lay = layoutBoundText(
        { ...card, height: cardH } as never,
        { ...label, originalText: text, text } as never,
      )
      const layout: Record<string, unknown> = { text: lay.text.text }
      if (lay.text.height !== label.height) layout.height = lay.text.height
      const op: Record<string, unknown> = {
        k: 'p',
        id: labelId,
        pv,
        g: { text: { originalText: text }, layout },
      }
      const ops: unknown[] = [op]
      if (lay.container.height !== cardH) {
        cardH = lay.container.height
        ops.push({ k: 'p', id, pv: cardPv, fit: { height: cardH } })
      }
      const push = { type: 'push', seq: ++seq, base: clock, ops }
      const raw = JSON.stringify(push)
      bytesOut += raw.length
      pushes++
      pending.set(seq, { at: performance.now(), v: pv })
      s.ws.send(raw)
      const now = performance.now()
      if (now - lastPresence > 1_000) {
        lastPresence = now
        s.send({
          type: 'presence',
          pointer: { x: 300, y: 200 },
          button: 'up',
          sel: [id],
          view: null,
          idle: false,
          editing: id,
        })
      }
      await sleep(pushMs)
    }
    await sleep(1_500)
    s.send({ type: 'lease.release', id })
    await sleep(300)
    s.close()
  }
  await Promise.all(cards.map((_, k) => runTypist(k)))
  await sleep(1_000)
  const after = await scrape(sync, secrets.internalSecret)
  for (const [key, at] of sentAt) for (const t of seen.get(key) ?? []) visibleMs.push(t - at)
  for (const s of watchSocks) s.close()
  await api.close()

  const loop = (text: string, q: string) =>
    parsePrometheus(text).find((m) => m.name === 'lobby_event_loop_delay_ms' && m.labels.quantile === q)
      ?.value ?? null
  const report = {
    kind: 'doc-cards',
    chars,
    typists,
    watchers,
    durationMs,
    pushMs,
    pushes,
    pushBytesMean: pushes ? Math.round(bytesOut / pushes) : 0,
    labelElementBytes: pushBytes,
    rejects,
    client: { ackMs: summarize(ackMs), visibleMs: summarize(visibleMs) },
    server: {
      commitMs: windowOf(histOf(before, 'lobby_commit_ms'), histOf(after, 'lobby_commit_ms')),
      receiveToAckMs: windowOf(
        histOf(before, 'lobby_receive_to_ack_ms'),
        histOf(after, 'lobby_receive_to_ack_ms'),
      ),
      pushToCommitMs: windowOf(
        histOf(before, 'lobby_push_to_commit_ms'),
        histOf(after, 'lobby_push_to_commit_ms'),
      ),
      commitToFanoutMs: windowOf(
        histOf(before, 'lobby_commit_to_fanout_ms'),
        histOf(after, 'lobby_commit_to_fanout_ms'),
      ),
      eventLoopMs: { p50: loop(after, '0.5'), p99: loop(after, '0.99'), max: loop(after, '1') },
    },
  }
  if (values.out) writeFileSync(values.out, JSON.stringify(report, null, 2))
  console.log(`doc-cards ${chars}x${typists} (${watchers} watchers): ${JSON.stringify(report)}`)
}

if (import.meta.main)
  main().then(
    () => process.exit(0),
    (e) => {
      console.error(String(e).slice(0, 500))
      process.exit(1)
    },
  )
