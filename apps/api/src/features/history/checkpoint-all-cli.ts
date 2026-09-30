// Starts POST /internal/checkpoints/run-all (a manual checkpoint of every board, checkpoint-all.ts) and
// waits for its report (bridge release R0; docs/DEPLOY.md "R0 at the cut-over and in a rollback"). From
// the api service's Shell:
//
//   node apps/api/src/features/history/checkpoint-all-cli.ts [--run <runId>] [--url <api url>]
//     [--interval-ms <ms>]
//
// Starts a run, or with --run follows one already started (the id is on the first line this prints;
// GET /internal/checkpoints/run-all lists the recent ones). Progress goes to stderr; the finished report
// is printed as JSON on stdout. Exit 0 only when no board failed; 1 otherwise (a board failed, the run
// failed, or the api no longer knows the run: it restarted); 2 on bad arguments or no secret.
//
// Every request is short: the api answers the POST at once (202 and the run's id) and this polls
// GET /internal/checkpoints/run-all/<runId>, each request with its own 30 s timeout, so Node's fetch limit
// (300 s without response headers) never ends one.
//
// The internal secret is the service's own DRAFTROOM_INTERNAL_SECRET (a Render Shell has it). The URL
// defaults to http://127.0.0.1:$PORT (5859, the api's default, without PORT). The report names boards,
// workspaces and checkpoints, never a secret.

import { INTERNAL_SECRET_HEADER } from '@draftroom/auth-tickets'
import {
  CHECKPOINT_ALL_ID_RE,
  CHECKPOINT_ALL_ROUTE,
  type CheckpointAllReport,
  type CheckpointAllRunView,
} from './checkpoint-all.ts'

const REQUEST_TIMEOUT_MS = 30_000
/** Polls in a row without an answer before giving up (the run itself goes on in the api). */
const MAX_MISSES = 12

interface Args {
  url: string
  runId: string | null
  intervalMs: number
}

class UsageError extends Error {}

function parseArgs(argv: string[], env: NodeJS.ProcessEnv): Args {
  const out: Args = { url: `http://127.0.0.1:${env.PORT || '5859'}`, runId: null, intervalMs: 5_000 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? ''
    const eq = /^(--[a-z-]+)=(.*)$/.exec(a)
    const flag = eq?.[1] ?? a
    const value = () => (eq ? eq[2] : argv[++i]) ?? ''
    if (flag === '--url') out.url = value()
    else if (flag === '--run') out.runId = value()
    else if (flag === '--interval-ms') out.intervalMs = Number(value())
    else throw new UsageError(`unknown argument ${a.slice(0, 40)}`)
  }
  if (!/^https?:\/\/[^/]+\/?$/.test(out.url)) throw new UsageError('--url must be http(s)://host:port')
  if (out.runId !== null && !CHECKPOINT_ALL_ID_RE.test(out.runId))
    throw new UsageError('--run must be a run id (run_ and 16 hex digits)')
  if (!Number.isInteger(out.intervalMs) || out.intervalMs < 10 || out.intervalMs > 600_000)
    throw new UsageError('--interval-ms must be 10 to 600000')
  return out
}

const say = (line: string) => process.stderr.write(`${line}\n`)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function call(args: Args, secret: string, method: 'GET' | 'POST', path: string) {
  const res = await fetch(new URL(path, args.url), {
    method,
    headers: { [INTERNAL_SECRET_HEADER]: secret },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const text = await res.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {}
  return { status: res.status, body }
}

const errorText = (body: unknown) => {
  const e = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error
  return e ? `${String(e.code)}: ${String(e.message)}` : 'no error body'
}

function summary(runId: string, r: CheckpointAllReport): string[] {
  const lines = [
    `checkpoints ${runId}: ${r.ok ? 'ok' : 'NOT ok'}: ${r.boards.length} boards: ${r.saved} saved, ${r.unchanged} unchanged, ${r.skipped} skipped, ${r.failed} failed ("${r.name}")`,
  ]
  for (const b of r.boards)
    if (b.outcome === 'failed') lines.push(`  FAIL ${b.boardId}: ${b.error ?? 'failed'}`)
    else if (b.outcome === 'skipped') lines.push(`  skipped ${b.boardId}: ${b.why ?? ''}`)
  return lines
}

async function main(): Promise<{ code: number; out?: string }> {
  let args: Args
  try {
    args = parseArgs(process.argv.slice(2), process.env)
  } catch (e) {
    say(`checkpoints: ${(e as Error).message}`)
    return { code: 2 }
  }
  const secret = process.env.DRAFTROOM_INTERNAL_SECRET
  if (!secret) {
    say('checkpoints: DRAFTROOM_INTERNAL_SECRET is not set (run this in the api service Shell)')
    return { code: 2 }
  }
  let runId = args.runId
  if (!runId) {
    const started = await call(args, secret, 'POST', CHECKPOINT_ALL_ROUTE)
    const view = started.body as CheckpointAllRunView | null
    if (started.status !== 202 || !view || !CHECKPOINT_ALL_ID_RE.test(view.runId)) {
      say(`checkpoints: refused (HTTP ${started.status}, ${errorText(started.body)})`)
      return { code: 1 }
    }
    runId = view.runId
    say(`checkpoints ${runId}: ${view.status}; to follow it again: --run ${runId}`)
  } else say(`checkpoints ${runId}: following`)

  let misses = 0
  let last = ''
  for (;;) {
    let view: CheckpointAllRunView | null = null
    try {
      const got = await call(args, secret, 'GET', `${CHECKPOINT_ALL_ROUTE}/${runId}`)
      if (got.status === 404) {
        say(`checkpoints ${runId}: the api does not know this run (it restarted, or the id is wrong)`)
        return { code: 1 }
      }
      if (got.status !== 200) throw new Error(`HTTP ${got.status}, ${errorText(got.body)}`)
      view = got.body as CheckpointAllRunView
      misses = 0
    } catch (e) {
      const why = (e as Error)?.message ?? String(e)
      if (++misses >= MAX_MISSES) {
        say(`checkpoints ${runId}: no answer from the api (${why}); follow it again with --run ${runId}`)
        return { code: 1 }
      }
      say(`checkpoints ${runId}: no answer (${why}); retrying`)
    }
    if (view?.status === 'done' && view.report) {
      for (const line of summary(runId, view.report)) say(line)
      return { code: view.report.ok ? 0 : 1, out: `${JSON.stringify(view.report, null, 2)}\n` }
    }
    if (view?.status === 'failed') {
      say(`checkpoints ${runId}: failed: ${view.error ?? 'no reason given'}`)
      return { code: 1 }
    }
    if (view) {
      const line = `${view.status}: ${view.boardsDone} of ${view.boardsTotal ?? '?'} boards`
      if (line !== last) say(`checkpoints ${runId}: ${line}`)
      last = line
    }
    await sleep(args.intervalMs)
  }
}

main().then(
  ({ code, out }) => {
    // Exit once stdout is flushed: a piped report must never be cut short.
    if (out) process.stdout.write(out, () => process.exit(code))
    else process.exit(code)
  },
  (e: unknown) => {
    say(`checkpoints: ${(e as Error)?.message ?? e}`)
    process.exit(1)
  },
)
