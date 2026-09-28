// The office sidecar's server (entry point: office-sidecar.ts). It runs in its own container of the
// worker image with NO network, no secrets (no worker token, no credentials) and its own memory and
// process caps, so a document that exploits LibreOffice finds nothing to steal and nowhere to send it.
// The worker reaches it over a Unix socket in a volume both containers mount (office-protocol.ts).
//
// Every request is untrusted: the input must be a regular file named document.<ext> and the output a
// directory, both inside the jobs directory after resolving links; the timeout is clamped; one
// conversion runs at a time and a short queue waits (BUSY beyond it); a client that disconnects
// cancels its conversion (the whole soffice tree is killed).
import { chmod, lstat, readdir, realpath, rm, stat } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { basename, isAbsolute, join, sep } from 'node:path'
import { LIMITS, OFFICE_FORMATS, type OfficeExt } from '@draftroom/dev-assets'
import { AbortedError, PreviewError } from './errors.ts'
import {
  isNamedPipe,
  MAX_MESSAGE_BYTES,
  OFFICE_PROTOCOL_VERSION,
  type OfficeFailureCode,
  type OfficeRequest,
  type OfficeResponse,
  readLine,
} from './office-protocol.ts'
import { convertWithSoffice } from './soffice.ts'

export interface OfficeServerConfig {
  /** Unix socket path (or a Windows named pipe in tests). */
  socketPath: string
  /** Requests may only name files inside this directory (the shared volume). */
  jobsDir: string
  /** Parent of each conversion's scratch directory (profile, HOME, TMPDIR). */
  workDir: string
  command: string[]
  maxTimeoutMs: number
  /** Conversions waiting behind the running one before new requests get BUSY. */
  maxQueue: number
  /**
   * Where LibreOffice leaves its per-profile IPC socket (OSL_PIPE_<uid>_SingleOfficeIPC_<hash>): always
   * /tmp, whatever TMPDIR says, and left behind when soffice is killed (timeout, cancel). The sidecar is
   * the only LibreOffice user in its container and runs one conversion at a time, so between conversions
   * every such socket is stale and is removed. null: never sweep.
   */
  pipeDir?: string | null
  log: (line: string) => void
}

const OSL_PIPE_RE = /^OSL_PIPE_\d+_SingleOfficeIPC_[0-9a-f]+$/

/** Removes LibreOffice IPC sockets left in `dir` (only sockets with LibreOffice's own naming). */
export async function sweepOfficePipes(dir: string): Promise<number> {
  let removed = 0
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return 0
  }
  for (const n of names.filter((x) => OSL_PIPE_RE.test(x))) {
    try {
      if ((await lstat(join(dir, n))).isSocket()) {
        await rm(join(dir, n), { force: true })
        removed++
      }
    } catch {}
  }
  return removed
}

const EXTS = new Set<string>(OFFICE_FORMATS.map((f) => f.ext))
/** Converter failures passed on as they are; anything else is INTERNAL. */
const PASSED_ON = new Set<string>(['TIMEOUT', 'OFFICE_INVALID', 'OFFICE_UNAVAILABLE', 'FILE_TOO_LARGE'])
/** How long a client has to send its request line. */
const REQUEST_READ_MS = 5_000

export interface OfficeServer {
  readonly server: Server
  /** Conversions running or waiting. */
  pending(): number
  close(): Promise<void>
}

class BadRequest extends Error {}

async function insideRoot(root: string, p: unknown): Promise<string> {
  if (typeof p !== 'string' || !isAbsolute(p) || p.length > 4096)
    throw new BadRequest('path must be absolute')
  let real: string
  try {
    real = await realpath(p)
  } catch {
    throw new BadRequest('path does not exist')
  }
  if (!real.startsWith(root + sep)) throw new BadRequest('path outside the jobs directory')
  return real
}

async function parseRequest(line: string, root: string, maxTimeoutMs: number): Promise<OfficeRequest> {
  let raw: Partial<OfficeRequest>
  try {
    raw = JSON.parse(line) as Partial<OfficeRequest>
  } catch {
    throw new BadRequest('not JSON')
  }
  if (typeof raw !== 'object' || raw === null || raw.v !== OFFICE_PROTOCOL_VERSION) {
    throw new BadRequest('unknown protocol version')
  }
  if (typeof raw.ext !== 'string' || !EXTS.has(raw.ext)) throw new BadRequest('unknown format')
  const ext = raw.ext as OfficeExt
  const input = await insideRoot(root, raw.input)
  const outDir = await insideRoot(root, raw.outDir)
  // lstat on the resolved paths: realpath already followed any link, so these are the real objects.
  const [inSt, outSt] = await Promise.all([lstat(input), lstat(outDir)])
  if (!inSt.isFile() || basename(input) !== `document.${ext}`)
    throw new BadRequest('input must be document.<ext>')
  if (!outSt.isDirectory()) throw new BadRequest('outDir must be a directory')
  if (inSt.size > LIMITS.maxOfficeBytes) throw new BadRequest('input too large')
  const t =
    typeof raw.timeoutMs === 'number' && Number.isFinite(raw.timeoutMs) ? Math.round(raw.timeoutMs) : 0
  return {
    v: OFFICE_PROTOCOL_VERSION,
    input,
    outDir,
    ext,
    timeoutMs: Math.min(Math.max(t, 1_000), maxTimeoutMs),
  }
}

function reply(socket: Socket, res: OfficeResponse) {
  if (socket.destroyed) return
  socket.end(`${JSON.stringify(res)}\n`)
}

export async function startOfficeServer(cfg: OfficeServerConfig): Promise<OfficeServer> {
  const root = await realpath(cfg.jobsDir)
  if (!(await stat(root)).isDirectory()) throw new Error('OFFICE_JOBS_DIR must be a directory')
  const pipe = isNamedPipe(cfg.socketPath)
  if (!pipe) {
    // A socket file left by a previous run (the container restarted) is ours to replace; anything else
    // at that path is not, and the server refuses to start rather than delete it.
    try {
      const st = await lstat(cfg.socketPath)
      if (!st.isSocket()) throw new Error('OFFICE_SOCKET exists and is not a socket')
      await rm(cfg.socketPath, { force: true })
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }
  }

  let queue: Promise<void> = Promise.resolve()
  let pending = 0
  const inFlight = new Set<AbortController>()

  const handle = async (socket: Socket) => {
    socket.setTimeout(REQUEST_READ_MS, () => socket.destroy())
    let req: OfficeRequest
    try {
      req = await parseRequest(await readLine(socket, MAX_MESSAGE_BYTES), root, cfg.maxTimeoutMs)
    } catch (e) {
      if (e instanceof BadRequest) {
        cfg.log(`[office] refused a request: ${e.message}`)
        reply(socket, { ok: false, code: 'BAD_REQUEST', detail: e.message })
      } else socket.destroy()
      return
    }
    socket.setTimeout(0)
    if (pending > cfg.maxQueue) {
      reply(socket, { ok: false, code: 'BUSY', detail: `${pending} conversions pending` })
      return
    }
    const ctl = new AbortController()
    // The worker gave up (its own timeout, a lost lease, shutdown): stop converting for it.
    socket.on('close', () => ctl.abort('client gone'))
    socket.on('error', () => {})
    inFlight.add(ctl)
    pending++
    const turn = queue.then(async () => {
      if (ctl.signal.aborted) return
      const t0 = Date.now()
      try {
        const pdf = await convertWithSoffice(req.input, req.ext, req.outDir, {
          command: cfg.command,
          workRoot: cfg.workDir,
          timeoutMs: req.timeoutMs,
          maxOutputBytes: LIMITS.maxBytes.pdf,
          signal: ctl.signal,
        })
        const ms = Date.now() - t0
        cfg.log(`[office] ${req.ext} converted in ${ms} ms`)
        reply(socket, { ok: true, pdf, ms })
      } catch (e) {
        if (e instanceof AbortedError || ctl.signal.aborted) {
          cfg.log(`[office] ${req.ext} cancelled after ${Date.now() - t0} ms (the worker disconnected)`)
          return
        }
        const code = (
          e instanceof PreviewError && PASSED_ON.has(e.code) ? e.code : 'INTERNAL'
        ) as OfficeFailureCode
        const detail = e instanceof PreviewError ? e.detail : String((e as Error)?.name ?? 'Error')
        cfg.log(
          `[office] ${req.ext} failed ${code} after ${Date.now() - t0} ms${detail ? ` (${detail})` : ''}`,
        )
        reply(socket, { ok: false, code, detail })
      } finally {
        // Nothing converts until the next turn: any LibreOffice IPC socket left now is stale.
        if (cfg.pipeDir) await sweepOfficePipes(cfg.pipeDir)
      }
    })
    queue = turn.finally(() => {
      pending--
      inFlight.delete(ctl)
    })
  }

  const server = createServer({ allowHalfOpen: false }, (socket) => {
    void handle(socket).catch(() => socket.destroy())
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(cfg.socketPath, () => {
      server.off('error', reject)
      resolve()
    })
  })
  // Owner only (both containers run as the same uid). Named pipes have their own ACLs.
  if (!pipe) await chmod(cfg.socketPath, 0o600)
  return {
    server,
    pending: () => pending,
    async close() {
      for (const c of inFlight) c.abort('server stopping')
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await queue.catch(() => {})
      if (!pipe) await rm(cfg.socketPath, { force: true }).catch(() => {})
    },
  }
}
