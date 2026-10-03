// The perf harness's servers: the REAL api + sync + preview worker (e2e/tests/support/stack.ts, on the
// E2E_PORT_BASE ports, temp data dir, dev sign-in) and `vite preview` of a production build, exactly
// like the browser suites (playwright.config.ts webServer), so the numbers are the shipped client's.
//
// Import this module only after E2E_PORT_BASE is set: tests/support/ports.ts reads it at import time.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { API_URL, RUN_TAG, SYNC_URL, WEB_PORT, WEB_URL } from '../tests/support/ports.ts'
import { REPO_ROOT, startStack } from '../tests/support/stack.ts'

export interface PerfStack {
  web: string
  /** The build folder vite preview serves (relative to apps/web); rebuilding into it takes effect on reload. */
  outDir: string
  stop(): Promise<void>
}

export interface PerfStackOptions {
  /** Skip `vite build` when this run's build folder already exists. */
  reuseBuild: boolean
  /** Unminified build with source maps, so CPU profiles name the functions. */
  readable: boolean
  log: (line: string) => void
}

const webEnv = () => ({
  ...process.env,
  // the dev-auth guard: the test facade (window.lobbyCanvas) and the board page's debug handle, as for the
  // browser suites (Lobby's board page; no VITE_LOBBY_BOARD_PAGE, so never spike B's)
  VITE_DRAFTROOM_DEV_AUTH: '1',
  VITE_LOBBY_BOARD_PAGE: '',
  DRAFTROOM_API_ORIGIN: API_URL,
  DRAFTROOM_SYNC_ORIGIN: SYNC_URL,
})

export const perfOutDir = (readable: boolean) => `dist/perf-${RUN_TAG}${readable ? '-readable' : ''}`

/** `vite build` of apps/web into `outDir` (relative to apps/web). */
export function buildWeb(outDir: string, readable: boolean, log: (line: string) => void) {
  log(`building the web app into apps/web/${outDir}${readable ? ' (unminified, source maps)' : ''}`)
  const extra = readable ? ' --minify false --sourcemap' : ''
  // One command string: pnpm is a .cmd shim on Windows, which only runs through a shell.
  const build = spawnSync(`pnpm --filter @draftroom/web exec vite build --outDir ${outDir}${extra}`, {
    cwd: REPO_ROOT,
    env: webEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
    windowsHide: true,
  })
  if (build.status !== 0) throw new Error(`vite build failed:\n${build.stdout}\n${build.stderr}`)
}

function killTree(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  } else child.kill('SIGKILL')
}

export async function startPerfStack(opts: PerfStackOptions): Promise<PerfStack> {
  const outDir = perfOutDir(opts.readable)
  if (!(opts.reuseBuild && existsSync(join(REPO_ROOT, 'apps/web', outDir, 'index.html')))) {
    buildWeb(outDir, opts.readable, opts.log)
  }

  const t0 = Date.now()
  const stack = await startStack()
  opts.log(`api + sync + worker up in ${Date.now() - t0} ms`)

  let previewOut = ''
  const preview = spawn(
    `pnpm --filter @draftroom/web exec vite preview --outDir ${outDir} --port ${WEB_PORT} --strictPort`,
    { cwd: REPO_ROOT, env: webEnv(), stdio: ['ignore', 'pipe', 'pipe'], shell: true, windowsHide: true },
  )
  preview.stdout?.on('data', (d) => {
    previewOut += String(d)
  })
  preview.stderr?.on('data', (d) => {
    previewOut += String(d)
  })
  const stop = async () => {
    killTree(preview)
    await stack.stop()
  }
  try {
    const deadline = Date.now() + 60_000
    for (;;) {
      if (preview.exitCode !== null) throw new Error(`vite preview exited:\n${previewOut}`)
      try {
        if ((await fetch(WEB_URL)).ok) break
      } catch {}
      if (Date.now() > deadline) throw new Error(`vite preview did not answer in 60 s:\n${previewOut}`)
      await new Promise((r) => setTimeout(r, 200))
    }
  } catch (e) {
    await stop()
    throw e
  }
  opts.log(`web (vite preview) on ${WEB_URL}`)
  return { web: WEB_URL, outDir, stop }
}
