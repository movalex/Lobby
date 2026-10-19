// Child-process helper: argv array (never a shell), hard SIGKILL timeout, bounded stdout, minimal env, and (Linux) a
// resident-memory cap.
//
// The memory cap (wave W review M3). `--max-old-space-size` bounds only a child's V8 heap: pdf.js keeps decompressed
// streams (fonts, page content) in buffers outside it, and libvips and ONNX Runtime allocate natively, so a 1.5 MB PDF
// whose one stream inflates to zeros drove a "384 MB" child to 3.4 GB. `maxRssBytes` is the real bound:
//   - Linux: a watchdog reads `/proc/<pid>/status` every RSS_POLL_MS (50 ms) and SIGKILLs the child (its whole process
//     group with `killTree`) as soon as its resident set is over the cap; the result says `memoryExceeded`. It decides
//     on VmHWM (the kernel's own high-water mark of VmRSS), so a spike that came and went between two reads still
//     counts. 50 ms: a read is one small procfs file (microseconds, so 20 reads a second cost nothing), and the review's
//     file grew its child to 3.3 GB in about 3 s (Windows, 2026-10-19), about 55 MB per 50 ms on average, so the child
//     ends a few tens of MB past the cap (bursts more), inside the container's headroom; the requirement is ≤ 100 ms.
//   - Not `prlimit --as` / RLIMIT_AS: V8 reserves far more address space than it uses, and an address-space limit makes
//     a healthy Node child fail at start-up or at its first large reservation.
//   - Other platforms (the Windows dev machine, macOS): there is no cheap per-poll read, so the watchdog is SKIPPED and
//     `memoryExceeded` is never set: the heap flag and, in a container, its memory limit are the only caps there. Tests
//     inject `readRss` to exercise the kill path everywhere.
// Only the direct child's resident set is read (the pdf, pdf-text and bg children start no helpers of their own).
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'

/** How often the Linux watchdog reads a capped child's resident set (≤ 100 ms by contract; see the header). */
export const RSS_POLL_MS = 50

/** A process's resident set in bytes (its high-water mark where known), or null when it cannot be read (gone). */
export type RssReader = (pid: number) => number | null

/** Linux: VmHWM (peak resident) of /proc/<pid>/status, else VmRSS; null when the process is gone or unreadable. */
export function procStatusRss(pid: number): number | null {
  let text: string
  try {
    text = readFileSync(`/proc/${pid}/status`, 'utf8')
  } catch {
    return null
  }
  const kb = (name: string) => {
    const m = new RegExp(`^${name}:\\s+(\\d+)\\s+kB`, 'm').exec(text)
    return m ? Number(m[1]) * 1024 : null
  }
  return kb('VmHWM') ?? kb('VmRSS')
}

/** The platform's reader: /proc on Linux, none elsewhere (the watchdog is then skipped; see the header). */
export const defaultRssReader: RssReader | null = process.platform === 'linux' ? procStatusRss : null

/** True where `maxRssBytes` is enforced by default (Linux). */
export const rssCapEnforced = defaultRssReader !== null

export interface RunOptions {
  timeoutMs: number
  maxStdoutBytes: number
  /** Written to the child's stdin, which is then closed. */
  stdin?: string
  signal?: AbortSignal
  /** The child's whole environment (default childEnv()). Never the worker's own environment. */
  env?: NodeJS.ProcessEnv
  cwd?: string
  /**
   * The child starts helpers of its own (LibreOffice: oosplash → soffice.bin). Kill the whole tree, not
   * just the direct child: on a timeout or abort, and on POSIX also whatever is left of its process
   * group once the direct child has exited.
   */
  killTree?: boolean
  /**
   * The child's resident-memory cap in bytes: over it, the child is SIGKILLed and `memoryExceeded` is set. Enforced on
   * Linux only (the header): elsewhere it is ignored unless a test passes `readRss`.
   */
  maxRssBytes?: number
  /** Test hook: the resident-set reader (default `defaultRssReader`, null off Linux). */
  readRss?: RssReader | null
  /** Test hook: the watchdog's period (default RSS_POLL_MS). */
  rssPollMs?: number
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
  /** We killed it because its resident set went over `maxRssBytes` (Linux, or a test's `readRss`). */
  memoryExceeded: boolean
  /** The largest resident set the watchdog read (bytes), null when no watchdog ran or nothing was read. */
  peakRssBytes: number | null
  /** The executable could not be started (e.g. ENOENT); `code` is null. */
  spawnError: string | null
  stdout: Buffer
  /** Truncated; may contain absolute paths, so it is for server logs only. */
  stderr: string
  ms: number
  pid: number | undefined
}

/** How long a child's stdio may stay open after it exited (held by something it started) before we close it. */
const PIPE_GRACE_MS = 2_000

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
      memoryExceeded: false,
      peakRssBytes: null,
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
    const tree = opts.killTree === true
    const child = spawn(cmd, args, {
      stdio: [opts.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: opts.env ?? childEnv(),
      cwd: opts.cwd,
      // POSIX: its own process group (pgid = pid), so the whole group can be killed at once.
      detached: tree && process.platform !== 'win32',
    })
    res.pid = child.pid
    const out: Buffer[] = []
    let outBytes = 0
    let settled = false
    const kill = () => (tree ? killProcessTree(child) : killChild(child))
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
    // The resident-memory watchdog (the header): Linux by default, a test's reader elsewhere.
    const readRss = opts.readRss === undefined ? defaultRssReader : opts.readRss
    const cap = opts.maxRssBytes
    let watchdog: NodeJS.Timeout | null = null
    const stopWatchdog = () => {
      if (watchdog) clearInterval(watchdog)
      watchdog = null
    }
    if (cap !== undefined && cap > 0 && readRss && child.pid !== undefined) {
      const pid = child.pid
      watchdog = setInterval(() => {
        const rss = readRss(pid)
        if (rss === null) return
        if (res.peakRssBytes === null || rss > res.peakRssBytes) res.peakRssBytes = rss
        if (rss > cap && !res.memoryExceeded) {
          res.memoryExceeded = true
          stopWatchdog()
          kill()
        }
      }, opts.rssPollMs ?? RSS_POLL_MS)
    }
    const settle = () => {
      if (settled) return
      settled = true
      stopWatchdog()
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
    child.on('exit', () => {
      stopWatchdog() // its pid may be reused from here on
      // A helper that outlives the direct child could keep the stdio pipes (and so 'close') open for ever.
      if (tree && process.platform !== 'win32') killGroup(child.pid)
      // One that escaped even that (its own session, or an orphan taskkill /T no longer finds) still
      // must not keep us waiting: once the child is gone, its pipes get a short grace and are then closed.
      const t = setTimeout(() => {
        child.stdout?.destroy()
        child.stderr?.destroy()
        child.stdin?.destroy()
      }, PIPE_GRACE_MS)
      child.once('close', () => clearTimeout(t))
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

function killChild(child: ChildProcess) {
  try {
    child.kill('SIGKILL')
  } catch {}
}

function killGroup(pid: number | undefined) {
  if (pid === undefined) return
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {} // ESRCH: the group is already gone
}

/** SIGKILL for the child and everything it started: its process group (POSIX) or its process tree (Windows). */
export function killProcessTree(child: ChildProcess) {
  if (child.pid === undefined) return
  if (process.platform === 'win32') {
    // taskkill /T walks the tree from the (still living) child; /F terminates. Nothing else kills grandchildren here.
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    killChild(child)
    return
  }
  killGroup(child.pid)
  killChild(child)
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
