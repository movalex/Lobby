// The api's guarded outbound requests (wave R: Miro import, chat notifications; AGENTS.md "Server egress exception").
// Generalised from link previews' fetch (features/link-preview/fetch.ts, which keeps its own behaviour: http allowed,
// redirects followed and re-checked); it shares their address rules (ssrf.ts isPublicAddress, vetAddress) and DNS
// lookup (dns.ts). For each request:
//   - policy.ts checkTarget allows it, or nothing is resolved (EgressError 'refused');
//   - the host's addresses are looked up with a time limit and EVERY one must be public, then the connection goes to
//     that vetted address (pinned: no second lookup a DNS rebind could change);
//   - a redirect (any 3xx) is refused, never followed: Lobby asks Miro for `redirect=false` answers, and a webhook
//     never needs one;
//   - one deadline covers lookup, connect, headers and the whole body; past it the request is destroyed ('timeout');
//   - the body is read up to `maxBytes` after decompression (a compression bomb stops there): past it 'too-large';
//   - only these headers are sent: User-Agent, Accept, Accept-Encoding, Content-Type and Content-Length for a body,
//     and Authorization: Bearer only when the rule allows it and a RedactedSecret is given. No cookies, ever; no
//     connection reuse (agent: false). Of the answer's headers only EGRESS_RESPONSE_HEADERS are kept.
// Errors are EgressError: a reason code and the HTTP status, never a URL, a header, a body or the cause's message (a
// Node error can name the host; another service's answer can echo a token), so whatever logs or stores one cannot
// leak a secret. Nothing here logs.

import { type ClientRequest, request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP, type LookupFunction } from 'node:net'
import { PassThrough, type Readable } from 'node:stream'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import { LOOKUP_TIMEOUT_MS, type Lookup, vetAddress } from '../features/link-preview/ssrf.ts'
import { checkTarget, type EgressMethod, type EgressPolicy, type EgressTarget } from './policy.ts'
import type { RedactedSecret } from './secret.ts'

export type EgressReason = 'refused' | 'blocked' | 'redirect' | 'timeout' | 'network' | 'too-large'

/** A request that did not give an answer. Its message, JSON and inspection hold the reason only. */
export class EgressError extends Error {
  readonly reason: EgressReason
  /** the answer's status for 'redirect' (and 'too-large' once headers came), else null */
  readonly status: number | null
  /** for 'refused': which rule check failed (policy.ts PolicyRefusal) */
  readonly detail: string | null

  constructor(reason: EgressReason, status: number | null = null, detail: string | null = null) {
    super(`egress ${reason}${detail ? ` (${detail})` : ''}${status ? ` ${status}` : ''}`)
    this.name = 'EgressError'
    this.reason = reason
    this.status = status
    this.detail = detail
  }

  toJSON() {
    return { name: this.name, reason: this.reason, status: this.status, detail: this.detail }
  }
}

/** The answer headers a caller may read (rate limits, retry hints, the body's type and size). */
export const EGRESS_RESPONSE_HEADERS = [
  'content-type',
  'content-length',
  'retry-after',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
] as const
export type EgressResponseHeader = (typeof EGRESS_RESPONSE_HEADERS)[number]

export interface EgressRequest {
  readonly method: EgressMethod
  readonly url: string
  readonly accept?: string
  /** a JSON or text body (POST) */
  readonly body?: string | Buffer
  readonly contentType?: string
  /** sent as `Authorization: Bearer …`, only to a rule with `bearer` */
  readonly bearer?: RedactedSecret
  /** the whole request, lookup to the body's last byte */
  readonly timeoutMs: number
  /** bytes of the (decompressed) body */
  readonly maxBytes: number
}

export interface EgressAnswer {
  readonly status: number
  readonly headers: Readonly<Partial<Record<EgressResponseHeader, string>>>
}
export interface EgressResponse extends EgressAnswer {
  readonly body: Buffer
}
export interface EgressStream extends EgressAnswer {
  /** the body, metered: it errors with EgressError 'too-large' past maxBytes and 'timeout' past the deadline */
  readonly body: Readable
}

export interface EgressDeps {
  readonly policy: EgressPolicy
  readonly lookup: Lookup
  readonly userAgent: string
  /** the longest one DNS lookup may take (and never past the request's own deadline) */
  readonly lookupTimeoutMs?: number
  /** test seam: the request function (http and https alike) */
  readonly request?: typeof httpRequest
  readonly now?: () => number
}

const asEgressError = (e: unknown, fallback: EgressReason = 'network') =>
  e instanceof EgressError ? e : new EgressError(fallback)

function decoded(res: IncomingMessage): Readable {
  const enc = String(res.headers['content-encoding'] ?? '')
    .trim()
    .toLowerCase()
  if (enc === 'gzip' || enc === 'x-gzip') return res.pipe(createGunzip())
  if (enc === 'deflate') return res.pipe(createInflate())
  if (enc === 'br') return res.pipe(createBrotliDecompress())
  return res
}

function keptHeaders(res: IncomingMessage): Partial<Record<EgressResponseHeader, string>> {
  const out: Partial<Record<EgressResponseHeader, string>> = {}
  for (const name of EGRESS_RESPONSE_HEADERS) {
    const v = res.headers[name]
    if (typeof v === 'string') out[name] = v.slice(0, 200)
  }
  return out
}

/**
 * Opens `req` and resolves once the answer's headers came: its status, the kept headers and the body as a metered
 * stream (read it, or destroy it). Rejects with EgressError ('refused' before anything was resolved).
 */
export async function egressOpen(deps: EgressDeps, req: EgressRequest): Promise<EgressStream> {
  const now = deps.now ?? Date.now
  const deadline = now() + req.timeoutMs
  const target = checkTarget(req.url, req.method, req.bearer !== undefined, deps.policy, now())
  if (typeof target === 'string') throw new EgressError('refused', null, target)
  const left = deadline - now()
  if (left <= 0) throw new EgressError('timeout')
  const address = await vetAddress(
    { url: target.url, host: target.host, port: target.port, seam: target.seam },
    deps.lookup,
    Math.min(deps.lookupTimeoutMs ?? LOOKUP_TIMEOUT_MS, left),
  )
  if (address === 'blocked') throw new EgressError('blocked')
  return send(deps, req, target, address, deadline, now)
}

function send(
  deps: EgressDeps,
  req: EgressRequest,
  target: EgressTarget,
  address: { address: string; family: number },
  deadline: number,
  now: () => number,
): Promise<EgressStream> {
  const https = target.url.protocol === 'https:'
  const request = deps.request ?? (https ? httpsRequest : httpRequest)
  // the vetted address, whatever the resolver would say now
  const lookup: LookupFunction = (_host, opts, cb) => {
    if ((opts as { all?: boolean }).all) (cb as never as (e: null, a: unknown[]) => void)(null, [address])
    else cb(null, address.address, address.family)
  }
  const body = req.body === undefined ? null : Buffer.from(req.body)
  const headers: Record<string, string> = {
    'User-Agent': deps.userAgent,
    Accept: req.accept ?? '*/*',
    'Accept-Encoding': 'gzip, deflate, br',
  }
  if (body) {
    headers['Content-Type'] = req.contentType ?? 'application/json'
    headers['Content-Length'] = String(body.length)
  }
  if (req.bearer) headers.Authorization = `Bearer ${req.bearer.reveal()}`
  return new Promise<EgressStream>((resolve, reject) => {
    let settled = false
    let r: ClientRequest | undefined
    // until the answer's headers came, the deadline rejects the request; after it, it fails the body
    let onDeadline: () => void = () => {
      if (settled) return
      settled = true
      r?.destroy()
      reject(new EgressError('timeout'))
    }
    const left = deadline - now()
    if (left <= 0) return reject(new EgressError('timeout'))
    const timer = setTimeout(() => onDeadline(), left)
    const answered = (res: IncomingMessage) => {
      const status = res.statusCode ?? 0
      if (status >= 300 && status < 400) {
        settled = true
        clearTimeout(timer)
        res.resume()
        r?.destroy()
        return reject(new EgressError('redirect', status))
      }
      // the body: decompressed, metered, and still under the one deadline
      const out = new PassThrough()
      // a failure can come before anyone reads (or after a reader left): it stays on the stream (`errored`, which a
      // later reader or pipeline sees), and is never an unhandled 'error' event that would end the process
      out.on('error', () => {})
      const source = decoded(res)
      let size = 0
      const fail = (e: EgressError) => {
        clearTimeout(timer)
        res.destroy()
        r?.destroy()
        out.destroy(e)
      }
      source.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > req.maxBytes) return fail(new EgressError('too-large', status))
        if (!out.write(chunk)) source.pause()
      })
      out.on('drain', () => source.resume())
      source.on('end', () => {
        clearTimeout(timer)
        out.end()
      })
      source.on('error', () => fail(new EgressError('network', status)))
      // a reader that stops early (destroys the body) ends the request too
      out.on('close', () => {
        clearTimeout(timer)
        res.destroy()
      })
      onDeadline = () => fail(new EgressError('timeout', status))
      settled = true
      resolve({ status, headers: keptHeaders(res), body: out })
    }
    try {
      r = request(
        {
          protocol: target.url.protocol,
          host: target.host,
          port: target.port,
          path: `${target.url.pathname}${target.url.search}`,
          method: req.method,
          lookup: isIP(target.host) ? undefined : lookup,
          ...(https && !isIP(target.host) ? { servername: target.host } : {}),
          headers,
          agent: false,
          timeout: left,
        },
        answered,
      )
    } catch {
      settled = true
      clearTimeout(timer)
      return reject(new EgressError('network'))
    }
    r.on('timeout', () => onDeadline())
    r.on('error', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new EgressError('network'))
    })
    r.end(body ?? undefined)
  })
}

/** Reads a metered body to its end into one buffer. */
export async function readBody(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  try {
    for await (const chunk of stream) chunks.push(chunk as Buffer)
  } catch (e) {
    throw asEgressError(e)
  }
  return Buffer.concat(chunks)
}

/** `egressOpen`, then the whole body (at most `maxBytes`). */
export async function egressFetch(deps: EgressDeps, req: EgressRequest): Promise<EgressResponse> {
  const answer = await egressOpen(deps, req)
  return { status: answer.status, headers: answer.headers, body: await readBody(answer.body) }
}
