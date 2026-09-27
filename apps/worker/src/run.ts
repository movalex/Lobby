// Child-process helper: argv array (never a shell), hard SIGKILL timeout, bounded stdout, minimal env.
import { spawn } from 'node:child_process'
import { performance } from 'node:perf_hooks'

export interface RunOptions {
  timeoutMs: number
  maxStdoutBytes: number
  /** Written to the child's stdin, which is then closed. */
  stdin?: string
  signal?: AbortSignal
}

export interface RunResult {
  code: number | null
  signal: NodeJS.Signals | null
  /** We killed it because it exceeded `timeoutMs`. */
  timedOut: boolean
  /** We killed it because stdout exceeded `maxStdoutBytes`. */
  overflow: boolean
  /** We killed it because `signal` aborted. */
  aborted: boolean
  /** The executable could not be started (e.g. ENOENT); `code` is null. */
  spawnError: string | null
  stdout: Buffer
  /** Truncated; may contain absolute paths, so it is for server logs only. */
  stderr: string
  ms: number
  pid: number | undefined
}

/** Children never see the worker's environment (storage/DB credentials later). SYSTEMROOT is required on Windows. */
export function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? '' }
  if (process.env.SYSTEMROOT) env.SYSTEMROOT = process.env.SYSTEMROOT
  return env
}

export function run(cmd: string, args: string[], opts: RunOptions): Promise<RunResult> {
  return new Promise((resolve) => {
    const t0 = performance.now()
    const res: RunResult = {
      code: null,
      signal: null,
      timedOut: false,
      overflow: false,
      aborted: false,
      spawnError: null,
      stdout: Buffer.alloc(0),
      stderr: '',
      ms: 0,
      pid: undefined,
    }
    if (opts.signal?.aborted) {
      res.aborted = true
      resolve(res)
      return
    }
    const child = spawn(cmd, args, {
      stdio: [opts.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: childEnv(),
    })
    res.pid = child.pid
    const out: Buffer[] = []
    let outBytes = 0
    let settled = false
    const kill = () => {
      try {
        child.kill('SIGKILL')
      } catch {}
    }
    // Our own timer (rather than spawn's `timeout`) so a timeout is told apart from other kills.
    const timer = setTimeout(() => {
      res.timedOut = true
      kill()
    }, opts.timeoutMs)
    const onAbort = () => {
      res.aborted = true
      kill()
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    const settle = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      res.stdout = Buffer.concat(out)
      res.ms = Math.round(performance.now() - t0)
      resolve(res)
    }
    child.stdout?.on('data', (b: Buffer) => {
      outBytes += b.length
      if (outBytes > opts.maxStdoutBytes) {
        res.overflow = true
        kill()
        return
      }
      out.push(b)
    })
    child.stderr?.on('data', (b: Buffer) => {
      if (res.stderr.length < 8192) res.stderr += b.toString('utf8')
    })
    child.on('error', (e) => {
      // 'error' without 'close' happens when the executable cannot be spawned at all.
      if (child.pid === undefined) {
        res.spawnError = (e as NodeJS.ErrnoException).code ?? 'spawn failed'
        settle()
      }
    })
    child.on('close', (code, signal) => {
      res.code = code
      res.signal = signal
      settle()
    })
    if (opts.stdin !== undefined && child.stdin) {
      child.stdin.on('error', () => {}) // EPIPE if the child exits before reading; the exit status tells the story
      child.stdin.end(opts.stdin)
    }
  })
}

/** Last lines of stderr for the worker log, with anything path-like removed. */
export function stderrTail(stderr: string, lines = 2): string {
  return stderr
    .trim()
    .split(/\r?\n/)
    .slice(-lines)
    .join(' | ')
    .replace(/(?:[A-Za-z]:)?[\\/][^\s'"]+/g, '<path>')
    .slice(0, 300)
}
