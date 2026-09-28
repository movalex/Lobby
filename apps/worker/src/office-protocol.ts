// Messages between the worker (office-client.ts) and the office sidecar (office-server.ts): one JSON
// line each way per connection, over a Unix socket in the volume both containers mount. Both sides run
// as the same unprivileged user; the sidecar still treats every request as untrusted input (paths must
// stay inside its jobs directory).
import type { Socket } from 'node:net'
import type { OfficeExt } from '@draftroom/dev-assets'

export const OFFICE_PROTOCOL_VERSION = 1

export interface OfficeRequest {
  v: typeof OFFICE_PROTOCOL_VERSION
  /** `<jobs dir>/job-XXXX/document.<ext>`, written by the worker. */
  input: string
  /** `<jobs dir>/job-XXXX/out`: the sidecar writes `document.pdf` there. */
  outDir: string
  ext: OfficeExt
  timeoutMs: number
}

export type OfficeFailureCode =
  | 'TIMEOUT'
  | 'OFFICE_INVALID'
  | 'OFFICE_UNAVAILABLE'
  | 'FILE_TOO_LARGE'
  | 'BAD_REQUEST'
  | 'BUSY'
  | 'INTERNAL'

export type OfficeResponse =
  | { ok: true; pdf: string; ms: number }
  | { ok: false; code: OfficeFailureCode; detail: string }

/** Requests are a few hundred bytes; replies a little more. */
export const MAX_MESSAGE_BYTES = 16 * 1024

/** Resolves with the first newline-terminated line, rejects when the peer closes first or sends too much. */
export function readLine(socket: Socket, maxBytes = MAX_MESSAGE_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = ''
    const done = (err: Error | null, line?: string) => {
      socket.off('data', onData)
      socket.off('end', onEnd)
      socket.off('close', onEnd)
      socket.off('error', onError)
      if (err) reject(err)
      else resolve(line ?? '')
    }
    const onData = (chunk: Buffer) => {
      buf += chunk.toString('utf8')
      const nl = buf.indexOf('\n')
      if (nl !== -1) done(null, buf.slice(0, nl))
      else if (buf.length > maxBytes) done(new Error('message too long'))
    }
    const onEnd = () =>
      done(Object.assign(new Error('closed before a complete message'), { code: 'ECONNRESET' }))
    const onError = (e: Error) => done(e)
    socket.on('data', onData)
    socket.on('end', onEnd)
    socket.on('close', onEnd)
    socket.on('error', onError)
  })
}

/** A Windows named pipe (tests on the dev PC) rather than a Unix socket file. */
export const isNamedPipe = (path: string) => /^\\\\[.?]\\pipe\\/i.test(path)
