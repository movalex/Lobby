// The worker's side of the office sidecar (office-server.ts): stages the document in the shared jobs
// directory, asks the sidecar to convert it over the Unix socket, and copies the PDF back into the job's
// own temp directory. The staging directory is removed whatever happens. What the sidecar wrote is
// treated as untrusted: it must be the one regular file we expected, within the size cap.
import { createWriteStream, constants as fsConstants, lstatSync, readdirSync, rmSync } from 'node:fs'
import { copyFile, type FileHandle, mkdir, mkdtemp, open, rm } from 'node:fs/promises'
import { connect } from 'node:net'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { LIMITS } from '@draftroom/dev-assets'
import { AbortedError, PreviewError, TransientError } from './errors.ts'
import type { OfficeConverter } from './office.ts'
import {
  OFFICE_PROTOCOL_VERSION,
  type OfficeRequest,
  type OfficeResponse,
  readLine,
} from './office-protocol.ts'

/** How much longer than the conversion's own timeout the worker waits for the sidecar's answer. */
export const REPLY_GRACE_MS = 15_000

export interface SocketConverterOptions {
  socketPath: string
  /** The shared volume, as mounted in the worker (the same path as in the sidecar). */
  jobsDir: string
  replyGraceMs?: number
}

function ask(
  socketPath: string,
  req: OfficeRequest,
  deadlineMs: number,
  signal?: AbortSignal,
): Promise<OfficeResponse> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AbortedError())
      return
    }
    let settled = false
    let replied = false
    const socket = connect(socketPath)
    const finish = (err: Error | null, res?: OfficeResponse) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      // Closing the connection is also how the sidecar learns that nobody waits for this conversion any more.
      socket.destroy()
      if (err) reject(err)
      else if (res) resolve(res)
    }
    const timer = setTimeout(
      () => finish(new PreviewError('TIMEOUT', `office sidecar gave no answer within ${deadlineMs} ms`)),
      deadlineMs,
    )
    const onAbort = () => finish(new AbortedError())
    signal?.addEventListener('abort', onAbort, { once: true })
    socket.on('error', (e: NodeJS.ErrnoException) => {
      if (!replied) finish(new TransientError(`office sidecar unreachable (${e.code ?? e.name})`))
    })
    socket.on('connect', () => {
      // Never end our side first: the sidecar treats a closed connection as a cancelled conversion.
      socket.write(`${JSON.stringify(req)}\n`)
      readLine(socket).then(
        (line) => {
          replied = true
          let res: OfficeResponse
          try {
            res = JSON.parse(line) as OfficeResponse
          } catch {
            finish(new TransientError('office sidecar sent an unreadable answer'))
            return
          }
          if (typeof res !== 'object' || res === null || typeof res.ok !== 'boolean') {
            finish(new TransientError('office sidecar sent an unexpected answer'))
            return
          }
          finish(null, res)
        },
        (e: NodeJS.ErrnoException) =>
          finish(new TransientError(`office sidecar hung up (${e.code ?? e.message})`)),
      )
    })
  })
}

function failure(res: Extract<OfficeResponse, { ok: false }>): Error {
  const detail = typeof res.detail === 'string' ? res.detail.slice(0, 300) : ''
  switch (res.code) {
    case 'TIMEOUT':
    case 'OFFICE_INVALID':
    case 'OFFICE_UNAVAILABLE':
    case 'FILE_TOO_LARGE':
      return new PreviewError(res.code, detail)
    default:
      // BUSY, BAD_REQUEST, INTERNAL: trouble on our side of the fence, not the document's. Retried.
      return new TransientError(`office sidecar ${String(res.code)}: ${detail}`)
  }
}

/**
 * Copies the sidecar's PDF into the worker's private temp dir through one file descriptor opened without
 * following a link (POSIX), so the checked file is the copied file, and never more than the size cap.
 */
async function copyOutput(src: string, dest: string) {
  let fh: FileHandle
  try {
    fh = await open(src, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
  } catch (e) {
    throw new PreviewError(
      'OFFICE_INVALID',
      `sidecar output: ${(e as NodeJS.ErrnoException).code ?? 'unreadable'}`,
    )
  }
  try {
    const st = await fh.stat()
    if (!st.isFile()) throw new PreviewError('OFFICE_INVALID', 'sidecar output is not a regular file')
    if (st.size > LIMITS.maxBytes.pdf)
      throw new PreviewError('FILE_TOO_LARGE', `converted PDF has ${st.size} bytes`)
    await pipeline(
      fh.createReadStream({ start: 0, end: LIMITS.maxBytes.pdf, autoClose: false }),
      createWriteStream(dest, { flags: 'wx' }),
    )
  } finally {
    await fh.close()
  }
}

const STAGE_RE = /^job-[A-Za-z0-9]{6}$/

/**
 * Removes staging directories (`job-XXXXXX`, mkdtemp's names) older than `ageMs` from the shared jobs
 * directory. The volume outlives both containers, so a worker killed mid-conversion (OOM, SIGKILL, a
 * host reboot) would otherwise leave that user's document there for good. A conversion takes minutes
 * at most, so the age rule never touches a live one. Run at worker startup.
 */
export function sweepOfficeJobs(jobsDir: string, ageMs: number, now = Date.now()): number {
  let names: string[]
  try {
    names = readdirSync(jobsDir)
  } catch {
    return 0
  }
  let removed = 0
  for (const n of names) {
    if (!STAGE_RE.test(n)) continue
    const p = join(jobsDir, n)
    try {
      const st = lstatSync(p)
      if (!st.isDirectory() || now - st.mtimeMs < ageMs) continue
      rmSync(p, { recursive: true, force: true, maxRetries: 3 })
      removed++
    } catch {}
  }
  return removed
}

export function socketOfficeConverter(o: SocketConverterOptions): OfficeConverter {
  return {
    describe: 'LibreOffice sidecar (no network, no secrets)',
    async convert(input, format, outDir, c) {
      const stage = await mkdtemp(join(o.jobsDir, 'job-'))
      try {
        const src = join(stage, `document.${format.ext}`)
        await copyFile(input, src, fsConstants.COPYFILE_EXCL)
        const out = join(stage, 'out')
        await mkdir(out)
        const res = await ask(
          o.socketPath,
          { v: OFFICE_PROTOCOL_VERSION, input: src, outDir: out, ext: format.ext, timeoutMs: c.timeoutMs },
          c.timeoutMs + (o.replyGraceMs ?? REPLY_GRACE_MS),
          c.signal,
        )
        if (!res.ok) throw failure(res)
        const expected = join(out, 'document.pdf')
        if (res.pdf !== expected)
          throw new PreviewError('OFFICE_INVALID', 'sidecar named an unexpected output')
        const dest = join(outDir, 'converted.pdf')
        await copyOutput(expected, dest)
        return dest
      } finally {
        await rm(stage, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {})
      }
    },
  }
}
