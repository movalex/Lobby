// OWNER: WS1 (wave V). The live activities load test (docs/WAVE-V-CONTRACTS.md §2.6, the acceptance): 200 virtual
// participants, each a name-only guest with its own session (joined through workshop links, as a room of people
// would), each holding the board's event stream, answer a poll and then a word cloud in 10 s bursts, against the real
// api (./activities-api.ts) on Postgres. Each participant refetches the activity when its stream says it changed (as
// the web does). Measured: the answer ack (request to response, client side), the refetch, every
// `workshop.activity` event each stream received, and the wire (no participant id or name in any event).
//
// Pass: answer ack p95 < 1 s; at most one windowed `workshop.activity` event per window per activity on every
// stream; every answer counted at the reveal; no 5xx; no participant id or name in an event.
//
//   node e2e/load/activities.ts --api http://127.0.0.1:3101 [--participants 200] [--bursts 3] [--burst-ms 10000]
//     [--out report.json]
//
// The api must trust X-Forwarded-For (TRUST_PROXY=true): each virtual participant sends its own private address
// (10.77.x.y), so the guest join windows count them as the separate phones they stand for; joins are spread over
// enough workshop links to stay within today's per-link window (60 per 10 min; wave V's R1 fix is WS3's).

import { writeFileSync } from 'node:fs'

// ---- pure parts (unit-tested in ./activities.test.ts) -------------------------------------------------------

/** Nearest-rank percentile; NaN for none. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length))) - 1] as number
}

export interface LatencySummary {
  n: number
  p50: number
  p95: number
  p99: number
  max: number
}
export const summarize = (v: readonly number[]): LatencySummary => ({
  n: v.length,
  p50: Math.round(percentile(v, 50)),
  p95: Math.round(percentile(v, 95)),
  p99: Math.round(percentile(v, 99)),
  max: Math.round(v.length ? v.reduce((a, b) => Math.max(a, b), 0) : Number.NaN),
})

export interface SeenEvent {
  /** when the stream received it (ms since the epoch) */
  at: number
  activityId: string
  status: string
  answered: number
}

/**
 * The most windowed events one stream got in one tally window, per activity. A windowed event is one of an OPEN
 * activity after its start event (the start, close, reveal, cancel and placement events are not windowed). Event k is
 * sent just after a boundary, so it is counted in the window it arrived in.
 */
export function maxEventsPerWindow(events: readonly SeenEvent[], windowMs: number): Record<string, number> {
  const out: Record<string, number> = {}
  const started = new Set<string>()
  const per = new Map<string, number>()
  for (const e of events) {
    if (e.status !== 'open') continue
    if (!started.has(e.activityId)) {
      started.add(e.activityId) // its start event
      continue
    }
    const k = `${e.activityId}|${Math.floor(e.at / windowMs)}`
    const n = (per.get(k) ?? 0) + 1
    per.set(k, n)
    out[e.activityId] = Math.max(out[e.activityId] ?? 0, n)
  }
  return out
}

/** Spreads `n` moments uniformly over `ms` (random order), for one burst. */
export const burstOffsets = (n: number, ms: number, rnd: () => number = Math.random): number[] =>
  Array.from({ length: n }, () => Math.floor(rnd() * ms))

export interface Verdict {
  pass: boolean
  reasons: string[]
}
export function verdict(r: {
  answerAck: Record<string, LatencySummary>
  maxEventsPerWindow: number
  counted: Record<string, { expected: number; answered: number }>
  serverErrors: number
  wireLeaks: number
}): Verdict {
  const reasons: string[] = []
  for (const [k, s] of Object.entries(r.answerAck))
    if (!(s.p95 < 1000)) reasons.push(`${k}: answer ack p95 ${s.p95} ms (needs < 1000)`)
  if (r.maxEventsPerWindow > 1) reasons.push(`a stream got ${r.maxEventsPerWindow} events in one window`)
  for (const [k, c] of Object.entries(r.counted))
    if (c.answered !== c.expected) reasons.push(`${k}: ${c.answered} answers counted of ${c.expected}`)
  if (r.serverErrors) reasons.push(`${r.serverErrors} server errors`)
  if (r.wireLeaks) reasons.push(`${r.wireLeaks} events carried a participant id or name`)
  return { pass: reasons.length === 0, reasons }
}

// ---- the run --------------------------------------------------------------------------------------------------

interface Args {
  api: string
  participants: number
  bursts: number
  burstMs: number
  links: number
  out: string | null
}

function args(argv: string[]): Args {
  const get = (name: string, dflt: string) => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 && argv[i + 1] ? (argv[i + 1] as string) : dflt
  }
  const n = Number(get('participants', '200'))
  return {
    api: get('api', 'http://127.0.0.1:3101').replace(/\/$/, ''),
    participants: n,
    bursts: Number(get('bursts', '3')),
    burstMs: Number(get('burst-ms', '10000')),
    links: Number(get('links', String(Math.max(1, Math.ceil(n / 50))))),
    out: argv.includes('--out') ? get('out', '') || null : null,
  }
}

const DEV_STUDIO = 'wsp_DevStudio00000000000'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface Person {
  name: string
  userId: string
  cookie: string
  ip: string
  events: SeenEvent[]
  raw: string[]
  stop: () => void
}

async function main() {
  const a = args(process.argv.slice(2))
  const origin = process.env.LOAD_ORIGIN ?? 'http://load.test'
  const statuses: Record<string, number> = {}
  const count = (what: string, status: number) => {
    const k = `${what} ${status}`
    statuses[k] = (statuses[k] ?? 0) + 1
  }
  const call = async (
    what: string,
    method: string,
    path: string,
    opts: { cookie?: string; ip?: string; body?: unknown } = {},
  ) => {
    const headers: Record<string, string> = { origin }
    if (opts.cookie) headers.cookie = opts.cookie
    if (opts.ip) headers['x-forwarded-for'] = opts.ip
    if (opts.body !== undefined) headers['content-type'] = 'application/json'
    const t0 = performance.now()
    const res = await fetch(`${a.api}${path}`, {
      method,
      headers,
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    })
    const text = await res.text()
    const ms = performance.now() - t0
    count(what, res.status)
    return { status: res.status, text, ms, res }
  }
  const json = <T>(t: { text: string }) => JSON.parse(t.text) as T
  const cookieOf = (res: Response) => {
    const c = res.headers.getSetCookie().find((x) => x.startsWith('dr_session='))
    if (!c) throw new Error('no session cookie')
    return c.split(';')[0] as string
  }
  const log = (s: string) => console.log(`${new Date().toISOString()} ${s}`)

  // 1. the facilitator, the board and its workshop links
  const fac = await call('login', 'POST', '/api/auth/dev/login', {
    body: { handle: 'loadfac', name: 'Load Facilitator' },
  })
  if (fac.status !== 200) throw new Error(`facilitator login: ${fac.status} ${fac.text}`)
  const facCookie = cookieOf(fac.res)
  const facId = json<{ user: { id: string } }>(fac).user.id
  const b = await call('board', 'POST', `/api/workspaces/${DEV_STUDIO}/boards`, {
    cookie: facCookie,
    body: { title: 'Load: live activities' },
  })
  if (b.status !== 201 && b.status !== 200) throw new Error(`board: ${b.status} ${b.text}`)
  const board = json<{ id?: string; board?: { id: string } }>(b)
  const bid = board.board?.id ?? board.id ?? ''
  const links: string[] = []
  for (let i = 0; i < a.links; i++) {
    const l = await call('link', 'POST', `/api/boards/${bid}/review-links`, {
      cookie: facCookie,
      body: { role: 'editor', allowGuests: true },
    })
    if (l.status !== 201) throw new Error(`link: ${l.status} ${l.text}`)
    const url = json<{ url: string }>(l).url
    links.push(url.slice(url.lastIndexOf('/') + 1))
  }
  log(`board ${bid}, ${links.length} workshop links`)

  // 2. the participants join (guest sessions) and open their streams
  const people: Person[] = []
  const t0join = performance.now()
  for (let i = 0; i < a.participants; i++) {
    const ip = `10.77.${Math.floor(i / 250)}.${(i % 250) + 1}`
    const name = `Loadguest ${String(i).padStart(3, '0')}`
    const token = links[i % links.length] as string
    const j = await call('join', 'POST', `/api/invitations/${token}/guest`, { ip, body: { name } })
    if (j.status !== 201) throw new Error(`join ${i}: ${j.status} ${j.text}`)
    people.push({
      name,
      userId: json<{ user: { id: string } }>(j).user.id,
      cookie: cookieOf(j.res),
      ip,
      events: [],
      raw: [],
      stop: () => {},
    })
  }
  log(`${people.length} guests joined in ${Math.round(performance.now() - t0join)} ms`)

  const refetch: number[] = []
  const facEvents: SeenEvent[] = []
  const openStream = async (
    cookie: string,
    ip: string | undefined,
    sink: SeenEvent[],
    raw: string[],
    onActivity?: () => void,
  ) => {
    const ctrl = new AbortController()
    const res = await fetch(`${a.api}/api/boards/${bid}/events`, {
      headers: { origin, cookie, ...(ip ? { 'x-forwarded-for': ip } : {}) },
      signal: ctrl.signal,
    })
    if (res.status !== 200 || !res.body) throw new Error(`stream: ${res.status}`)
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    void (async () => {
      let buf = ''
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) return
          buf += dec.decode(value, { stream: true })
          let k = buf.indexOf('\n\n')
          while (k >= 0) {
            const line = buf
              .slice(0, k)
              .split('\n')
              .find((x) => x.startsWith('data: '))
            buf = buf.slice(k + 2)
            if (line) {
              const e = JSON.parse(line.slice(6)) as { type: string; data: Record<string, unknown> }
              if (e.type === 'workshop.activity') {
                raw.push(line)
                const act = e.data.activity as { id: string; status: string }
                sink.push({
                  at: Date.now(),
                  activityId: act.id,
                  status: act.status,
                  answered: e.data.answered as number,
                })
                onActivity?.()
              } else if (e.type === 'workshop.activity.results') raw.push(line)
            }
            k = buf.indexOf('\n\n')
          }
        }
      } catch {
        // aborted
      }
    })()
    return () => ctrl.abort()
  }
  const stopFac = await openStream(facCookie, undefined, facEvents, [])
  for (const p of people)
    p.stop = await openStream(p.cookie, p.ip, p.events, p.raw, () => {
      // the web refetches its own state when the activity changes
      void call('refetch', 'GET', `/api/boards/${bid}/activity`, { cookie: p.cookie, ip: p.ip }).then((r) =>
        refetch.push(r.ms),
      )
    })
  log(`${people.length + 1} event streams open`)
  await sleep(500)

  // 3. the activities: a poll, then a word cloud, each answered in bursts
  const plans = [
    {
      key: 'poll',
      input: {
        kind: 'poll',
        prompt: 'Which one first?',
        config: { options: ['Alpha', 'Beta', 'Gamma', 'Delta'] },
      },
      answerOf: (i: number, burst: number) => ({ kind: 'poll', choices: [(i + burst) % 4] }),
    },
    {
      key: 'words',
      input: { kind: 'words', prompt: 'Three words for this quarter', config: { maxWords: 3 } },
      answerOf: (i: number, burst: number) => ({
        kind: 'words',
        words: [`theme${i % 17}`, `word${(i * 7 + burst) % 61}`, i % 3 ? 'focus' : 'Focus'],
      }),
    },
  ] as const
  const ack: Record<string, number[]> = {}
  const counted: Record<string, { expected: number; answered: number }> = {}
  const activityIds: Record<string, string> = {}
  for (const plan of plans) {
    const s = await call('start', 'POST', `/api/boards/${bid}/activities`, {
      cookie: facCookie,
      body: plan.input,
    })
    if (s.status !== 201) throw new Error(`start ${plan.key}: ${s.status} ${s.text}`)
    const aid = json<{ activity: { id: string } }>(s).activity.id
    activityIds[plan.key] = aid
    ack[plan.key] = []
    log(`${plan.key} ${aid} started`)
    for (let burst = 0; burst < a.bursts; burst++) {
      const offsets = burstOffsets(people.length, a.burstMs)
      const t = performance.now()
      await Promise.all(
        people.map(async (p, i) => {
          await sleep(offsets[i] as number)
          const r = await call(`answer ${plan.key}`, 'POST', `/api/activities/${aid}/answer`, {
            cookie: p.cookie,
            ip: p.ip,
            body: { answer: plan.answerOf(i, burst) },
          })
          ack[plan.key]?.push(r.ms)
          if (r.status !== 200) log(`answer ${plan.key} ${i}: ${r.status} ${r.text.slice(0, 120)}`)
        }),
      )
      log(
        `${plan.key} burst ${burst + 1}: ${people.length} answers in ${Math.round(performance.now() - t)} ms`,
      )
    }
    // the last window ends, then the facilitator reveals
    await sleep(6_000)
    const rv = await call('reveal', 'POST', `/api/activities/${aid}/reveal`, { cookie: facCookie, body: {} })
    if (rv.status !== 200) throw new Error(`reveal ${plan.key}: ${rv.status} ${rv.text}`)
    const results = json<{ results: { answered: number } }>(rv).results
    counted[plan.key] = { expected: people.length, answered: results.answered }
    log(`${plan.key} revealed: ${results.answered} answered`)
    await sleep(1_000)
  }

  // 4. let the last refetches land, close the streams, report
  await sleep(2_000)
  stopFac()
  for (const p of people) p.stop()

  const windowMs = 5_000
  let maxPerWindow = 0
  const perActivity: Record<string, number> = {}
  for (const evs of [facEvents, ...people.map((p) => p.events)]) {
    for (const [aid, n] of Object.entries(maxEventsPerWindow(evs, windowMs))) {
      perActivity[aid] = Math.max(perActivity[aid] ?? 0, n)
      maxPerWindow = Math.max(maxPerWindow, n)
    }
  }
  const ids = people.map((p) => p.userId)
  const names = people.map((p) => p.name)
  let wireLeaks = 0
  for (const p of people)
    for (const line of p.raw)
      if (ids.some((id) => line.includes(id)) || names.some((n) => line.includes(n))) wireLeaks++
  const serverErrors = Object.entries(statuses)
    .filter(([k]) => Number(k.split(' ').at(-1)) >= 500)
    .reduce((s, [, n]) => s + n, 0)
  const answerAck = Object.fromEntries(Object.entries(ack).map(([k, v]) => [k, summarize(v)]))
  const report = {
    at: new Date().toISOString(),
    api: a.api,
    participants: people.length,
    bursts: a.bursts,
    burstMs: a.burstMs,
    links: links.length,
    activities: activityIds,
    answerAck,
    refetch: summarize(refetch),
    eventsAtFacilitator: facEvents.length,
    eventsPerParticipant: summarize(people.map((p) => p.events.length)),
    maxWindowedEventsPerWindow: { overall: maxPerWindow, byActivity: perActivity },
    counted,
    statuses,
    serverErrors,
    wireLeaks,
    facilitatorId: facId,
  }
  const v = verdict({ answerAck, maxEventsPerWindow: maxPerWindow, counted, serverErrors, wireLeaks })
  const out = { ...report, verdict: v }
  console.log(JSON.stringify(out, null, 2))
  if (a.out) writeFileSync(a.out, `${JSON.stringify(out, null, 2)}\n`)
  process.exit(v.pass ? 0 : 1)
}

if (import.meta.main) await main()
