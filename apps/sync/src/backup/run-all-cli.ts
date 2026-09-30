// Starts POST /internal/backups/run-all and waits for its report (bridge release R0; docs/DEPLOY.md
// "R0 at the cut-over and in a rollback"). From the sync service's Shell:
//
//   node apps/sync/src/backup/run-all-cli.ts [--expect-maintenance] [--run <runId>] [--url <sync url>]
//     [--interval-ms <ms>]
//   (dev: pnpm --filter @draftroom/sync backup:run-all …)
//
// Starts a run, or with --run follows one already started (the id is on the first line this prints;
// GET /internal/backups/run-all lists the recent ones). Progress goes to stderr; the finished report is
// printed as JSON on stdout. Exit 0 only when the report says ok, and with --expect-maintenance also
// `inMaintenance`. Exit 1 otherwise: a board failed, the run failed, or the server no longer knows the
// run (it restarted, which also turned maintenance off). Exit 2: bad arguments or no secret.
//
// Every request is short: the server answers the POST at once (202 and the run's id) and the CLI polls
// GET /internal/backups/run-all/<runId>, each request with its own 30 s timeout. No request waits for the
// run itself, so Node's fetch limit (300 s without response headers) never ends one, and a run that
// outlasts a dropped Shell can be followed again with --run.
//
// The internal secret is the service's own DRAFTROOM_INTERNAL_SECRET (a Render Shell has it). The URL
// defaults to http://127.0.0.1:$PORT (5858, sync's default, without PORT). Nothing printed carries a
// secret: board ids, file names, object keys and digests.

import { INTERNAL_SECRET_HEADER } from '@draftroom/auth-tickets'
import { RUN_ALL_ID_RE, type RunAllReport, type RunAllRunView } from './run-all.ts'

const REQUEST_TIMEOUT_MS = 30_000
/** Polls in a row without an answer before giving up (the run itself goes on in the server). */
const MAX_MISSES = 12

interface Args {
  url: string
  runId: string | null
  expectMaintenance: boolean
  intervalMs: number
}

class UsageError extends Error {}

function parseArgs(argv: string[], env: NodeJS.ProcessEnv): Args {
  const out: Args = {
    url: `http://127.0.0.1:${env.PORT || '5858'}`,
    runId: null,
    expectMaintenance: false,
    intervalMs: 5_000,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? ''
    const eq = /^(--[a-z-]+)=(.*)$/.exec(a)
    const flag = eq?.[1] ?? a
    const value = () => (eq ? eq[2] : argv[++i]) ?? ''
    if (flag === '--url') out.url = value()
    else if (flag === '--run') out.runId = value()
    else if (flag === '--interval-ms') out.intervalMs = Number(value())
    else if (a === '--expect-maintenance') out.expectMaintenance = true
    else throw new UsageError(`unknown argument ${a.slice(0, 40)}`)
  }
  if (!/^https?:\/\/[^/]+\/?$/.test(out.url)) throw new UsageError('--url must be http(s)://host:port')
  if (out.runId !== null && !RUN_ALL_ID_RE.test(out.runId))
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

function summary(runId: string, report: RunAllReport): string[] {
  const good = report.boards.filter((b) => b.ok).length
  const lines = [
    `run-all ${runId}: ${report.ok ? 'ok' : 'NOT ok'}: ${good} of ${report.boards.length} boards backed up; offsite ${report.offsite}; maintenance ${report.inMaintenance ? 'on from start to end' : 'NOT on from start to end'}`,
  ]
  for (const b of report.boards) if (!b.ok) lines.push(`  FAIL ${b.boardId}: ${b.error ?? 'failed'}`)
  return lines
}

/** Returns the exit code; `out` is what goes to stdout. */
async function main(): Promise<{ code: number; out?: string }> {
  let args: Args
  try {
    args = parseArgs(process.argv.slice(2), process.env)
  } catch (e) {
    say(`run-all: ${(e as Error).message}`)
    return { code: 2 }
  }
  const secret = process.env.DRAFTROOM_INTERNAL_SECRET
  if (!secret) {
    say('run-all: DRAFTROOM_INTERNAL_SECRET is not set (run this in the sync service Shell)')
    return { code: 2 }
  }
  let runId = args.runId
  if (!runId) {
    const started = await call(args, secret, 'POST', '/internal/backups/run-all')
    const view = started.body as RunAllRunView | null
    if (started.status !== 202 || !view || !RUN_ALL_ID_RE.test(view.runId)) {
      say(`run-all: refused (HTTP ${started.status}, ${errorText(started.body)})`)
      return { code: 1 }
    }
    runId = view.runId
    say(`run-all ${runId}: ${view.status}; to follow it again: --run ${runId}`)
  } else say(`run-all ${runId}: following`)

  let misses = 0
  let last = ''
  for (;;) {
    let view: RunAllRunView | null = null
    try {
      const got = await call(args, secret, 'GET', `/internal/backups/run-all/${runId}`)
      if (got.status === 404) {
        say(
          `run-all ${runId}: the sync server does not know this run. It restarted (which also turned maintenance off), or the id is wrong.`,
        )
        return { code: 1 }
      }
      if (got.status !== 200) throw new Error(`HTTP ${got.status}, ${errorText(got.body)}`)
      view = got.body as RunAllRunView
      misses = 0
    } catch (e) {
      const why = (e as Error)?.message ?? String(e)
      if (++misses >= MAX_MISSES) {
        say(`run-all ${runId}: no answer from the sync server (${why}); follow it again with --run ${runId}`)
        return { code: 1 }
      }
      say(`run-all ${runId}: no answer (${why}); retrying`)
    }
    if (view?.status === 'done' && view.report) {
      for (const line of summary(runId, view.report)) say(line)
      const inMaintenance = view.report.inMaintenance
      if (args.expectMaintenance && !inMaintenance)
        say(`run-all ${runId}: maintenance was not on from start to end; this is not the final backup set`)
      return {
        code: view.report.ok && (!args.expectMaintenance || inMaintenance) ? 0 : 1,
        out: `${JSON.stringify(view.report, null, 2)}\n`,
      }
    }
    if (view?.status === 'failed') {
      say(`run-all ${runId}: failed: ${view.error ?? 'no reason given'}`)
      return { code: 1 }
    }
    if (view) {
      const line = `${view.status}: ${view.boardsDone} of ${view.boardsTotal ?? '?'} boards`
      if (line !== last) say(`run-all ${runId}: ${line}`)
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
    say(`run-all: ${(e as Error)?.message ?? e}`)
    process.exit(1)
  },
)
