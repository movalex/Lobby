// pnpm --filter @draftroom/e2e demo:video — records and composes the Lobby demo video (README.md).
//
//   1. builds the web app (local-dev guard on; the tldraw licence key if one is given),
//   2. starts a fresh local stack (tests/support/stack.ts: real api, sync server and preview worker,
//      dev sign-in, its own temporary data dir) and `vite preview` on port base 11000,
//   3. records the scenes (scenes.ts) and writes out/timeline.json,
//   4. composes out/lobby-demo.mp4 and out/contact-sheet.png (compose.ts),
//   5. stops everything it started.
//
// Options (flags or environment):
//   --narration=<file>          DEMO_NARRATION            narration.json (required)
//   --license-key-file=<file>   DEMO_TLDRAW_LICENSE_FILE  a file holding the tldraw licence key
//                               VITE_TLDRAW_LICENSE_KEY   ...or the key itself (never printed)
//   --until=<scene id>          stop recording after this scene (quick iterations)
//   --compose-only              re-compose from the last out/timeline.json
//   --record-only               record (and write out/timeline.json) without composing
//   --headed                    show the browser windows
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { loadNarration, type Timeline } from './timeline.ts'

// The stack and the preview server take their ports from E2E_PORT_BASE (tests/support/ports.ts),
// which is read when that module loads: set it before importing.
process.env.E2E_PORT_BASE ||= '11000'
const { REPO_ROOT, startStack } = await import('../tests/support/stack.ts')
const { API_URL, RUN_TAG, SYNC_URL, WEB_PORT, WEB_URL } = await import('../tests/support/ports.ts')
const { recordDemo } = await import('./scenes.ts')
const { compose, probe } = await import('./compose.ts')

const argv = process.argv.slice(2)
// `pnpm … demo:video -- --flag` passes the "--" through: it is not the end of the options here.
if (argv[0] === '--') argv.shift()
const { values: args } = parseArgs({
  args: argv,
  options: {
    narration: { type: 'string' },
    'license-key-file': { type: 'string' },
    until: { type: 'string' },
    'compose-only': { type: 'boolean', default: false },
    'record-only': { type: 'boolean', default: false },
    headed: { type: 'boolean', default: false },
  },
  allowPositionals: true,
})

const DEMO_DIR = import.meta.dirname
const OUT = join(DEMO_DIR, 'out')
const WEB_DIR = join(REPO_ROOT, 'apps/web')
const VITE = join(WEB_DIR, 'node_modules/vite/bin/vite.js')
const BUILD_DIR = `dist/demo-${RUN_TAG}`
const started = Date.now()
const log = (msg: string) =>
  console.log(`[demo ${((Date.now() - started) / 1000).toFixed(1).padStart(6)}s] ${msg}`)

const narrationFile = args.narration ?? process.env.DEMO_NARRATION
if (!narrationFile || !existsSync(narrationFile)) {
  console.error('Pass --narration=<narration.json> (or set DEMO_NARRATION). See e2e/demo/README.md.')
  process.exit(2)
}
const narration = loadNarration(resolve(narrationFile))
for (const n of narration) if (!existsSync(n.audio)) throw new Error(`missing narration clip ${n.audio}`)
mkdirSync(OUT, { recursive: true })

function licenseKey(): string | undefined {
  const file = args['license-key-file'] ?? process.env.DEMO_TLDRAW_LICENSE_FILE
  if (file) return readFileSync(file, 'utf8').trim() || undefined
  return process.env.VITE_TLDRAW_LICENSE_KEY?.trim() || undefined
}

function buildWeb() {
  const env: NodeJS.ProcessEnv = { ...process.env, VITE_DRAFTROOM_DEV_AUTH: '1' }
  const key = licenseKey()
  if (key) env.VITE_TLDRAW_LICENSE_KEY = key
  else delete env.VITE_TLDRAW_LICENSE_KEY
  log(`building the web app into apps/web/${BUILD_DIR} (${key ? 'with' : 'without'} a tldraw licence key)`)
  const r = spawnSync(process.execPath, [VITE, 'build', '--outDir', BUILD_DIR, '--emptyOutDir'], {
    cwd: WEB_DIR,
    env,
    encoding: 'utf8',
    windowsHide: true,
  })
  if (r.status !== 0) throw new Error(`web build failed: ${(r.stderr || r.stdout).slice(-2000)}`)
}

function answers(url: string): Promise<boolean> {
  return new Promise((ok) => {
    const req = request(url, { timeout: 1000 }, (res) => {
      res.resume()
      ok((res.statusCode ?? 500) < 500)
    })
    req.on('timeout', () => req.destroy())
    req.on('error', () => ok(false))
    req.end()
  })
}

async function startPreview(): Promise<ChildProcess> {
  if (await answers(WEB_URL)) throw new Error(`${WEB_URL} is already in use`)
  const child = spawn(
    process.execPath,
    [VITE, 'preview', '--outDir', BUILD_DIR, '--port', String(WEB_PORT), '--strictPort'],
    {
      cwd: WEB_DIR,
      // Same origin for everything: vite preview proxies /api and /files to the api, /connect to sync.
      env: { ...process.env, DRAFTROOM_API_ORIGIN: API_URL, DRAFTROOM_SYNC_ORIGIN: SYNC_URL },
      stdio: 'ignore',
      windowsHide: true,
    },
  )
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('vite preview exited during startup')
    if (await answers(WEB_URL)) return child
    await new Promise((r) => setTimeout(r, 200))
  }
  child.kill()
  throw new Error('vite preview did not start in 30 s')
}

interface AiSetup {
  /** Extra env for the api process only (StackOptions.apiEnv: the stack strips OPENAI_* otherwise). */
  env: Record<string, string>
  stop?: () => Promise<void>
  note: string
}

/**
 * The AI scene's provider. A real OPENAI_API_KEY in this process's environment goes to the api (only
 * the api), with OPENAI_MODEL and OPENAI_BASE_URL when they are set. Otherwise the repo's fake OpenAI
 * server (e2e/tests/support/ai.ts) answers: it groups the Lobby tour's Brainstorm notes into three
 * themes the way a person would, and nothing leaves the machine.
 */
const OPENAI_VARS = ['OPENAI_API_KEY', 'OPENAI_MODEL', 'OPENAI_BASE_URL'] as const
/** OpenAI settings from this process's environment, taken out of it so no other process inherits them. */
const openaiFromEnv: Record<string, string> = {}
for (const k of OPENAI_VARS) {
  const v = process.env[k]?.trim()
  if (v) openaiFromEnv[k] = v
  delete process.env[k]
}

async function aiSetup(): Promise<AiSetup> {
  if (openaiFromEnv.OPENAI_API_KEY) {
    const model = openaiFromEnv.OPENAI_MODEL ?? 'the api default'
    return {
      env: { ...openaiFromEnv, DRAFTROOM_AI: 'on' },
      note: `AI: OPENAI_API_KEY from the environment, for the api only (model: ${model})`,
    }
  }
  const { AI_API_ENV, startFakeOpenAi } = await import('../tests/support/ai.ts')
  const fake = await startFakeOpenAi()
  return {
    env: { ...AI_API_ENV },
    stop: () => fake.close(),
    note: `AI: the repo's fake OpenAI server (tests/support/ai.ts) at ${AI_API_ENV.OPENAI_BASE_URL}`,
  }
}

async function recordAll(): Promise<Timeline> {
  buildWeb()
  rmSync(join(OUT, 'recordings'), { recursive: true, force: true })
  rmSync(join(OUT, 'debug'), { recursive: true, force: true })
  const ai = await aiSetup()
  log(ai.note)
  log('starting the local stack (fresh data dir, dev sign-in)')
  // The AI settings reach the api alone: the sync server, the worker and vite preview never see them.
  const stack = await startStack({ apiEnv: ai.env }).catch(async (e: unknown) => {
    await ai.stop?.().catch(() => {})
    throw e
  })
  let preview: ChildProcess | null = null
  try {
    preview = await startPreview()
    log(`recording on ${WEB_URL}`)
    const timeline = await recordDemo({
      webUrl: WEB_URL,
      outDir: OUT,
      narration,
      until: args.until,
      headed: args.headed,
      log,
    })
    writeFileSync(join(OUT, 'timeline.json'), JSON.stringify(timeline, null, 2))
    return timeline
  } catch (e) {
    writeFileSync(
      join(OUT, 'stack-logs.txt'),
      [stack.api, stack.sync, stack.worker].map((p) => `== ${p.name}\n${p.logs()}`).join('\n'),
    )
    throw e
  } finally {
    if (preview && preview.exitCode === null) {
      const exited = new Promise((r) => preview?.once('exit', r))
      preview.kill()
      await exited
    }
    await stack.stop()
    await ai.stop?.().catch(() => {})
    // The build has the licence key inlined: it is not kept once the recording is done.
    rmSync(join(WEB_DIR, BUILD_DIR), { recursive: true, force: true })
    log('stack and preview stopped; demo build removed')
  }
}

const timeline: Timeline = args['compose-only']
  ? (JSON.parse(readFileSync(join(OUT, 'timeline.json'), 'utf8')) as Timeline)
  : await recordAll()
if (args['record-only']) {
  log(`recorded ${timeline.scenes.length} scenes; out/timeline.json written (compose with --compose-only)`)
  process.exit(0)
}

const result = await compose({
  timeline,
  narration,
  outDir: OUT,
  repoRoot: REPO_ROOT,
  people: {
    left: { name: 'Alex Rivera', role: 'board owner', color: timeline.colors?.alex ?? '#0e7c86' },
    right: { name: 'Sam Lee', role: 'teammate', color: timeline.colors?.sam ?? '#c8102e' },
  },
  phoneLabel: 'Jordan, a client, on their phone',
  log,
})

const p = probe(result.video)
log(`wrote ${result.video}`)
log(`  ${p.duration.toFixed(2)} s; ${p.streams.join('; ')}`)
log(`  contact sheet: ${result.contactSheet}`)
for (const s of result.scenes) {
  const where =
    s.at >= 0
      ? `at ${s.at.toFixed(1).padStart(6)} s for ${s.duration.toFixed(1).padStart(5)} s`
      : 'not in the video'
  log(
    `  ${s.id.padEnd(13)} ${s.status.padEnd(8)} ${where} (narration ${s.narrationSec.toFixed(1)} s) ${s.note}`,
  )
}
