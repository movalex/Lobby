// Link previews (D2): the guarded fetch. One GET per hop, to the address ./ssrf.ts vetted (pinned, so a
// DNS answer cannot change between the check and the connect), with a total time limit, a byte limit on
// what is read (after decompression, so a compression bomb stops at the limit), no cookies or
// credentials of any kind, and every redirect checked again from the start. Nothing here logs a URL.
import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP, type LookupFunction } from 'node:net'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import { checkUrl, LOOKUP_TIMEOUT_MS, type Lookup, type Policy, vetAddress } from './ssrf.ts'

export interface FetchLimits {
  /** total time for every hop of one fetch */
  readonly timeoutMs: number
  /** bytes read from the body (decompressed) */
  readonly maxBytes: number
  readonly maxRedirects: number
}

export interface Fetched {
  readonly url: URL
  readonly contentType: string
  /** the Content-Type's charset parameter, if any */
  readonly charset: string | null
  readonly body: Buffer
  /** the body was cut at `maxBytes` (or the reader stopped early) */
  readonly truncated: boolean
}

export interface FetchDeps {
  readonly policy: Policy
  readonly lookup: Lookup
  /** the longest one DNS lookup may take (LOOKUP_TIMEOUT_MS), and never past the fetch's own deadline */
  readonly lookupTimeoutMs?: number
  /** test seam: the request function (http and https alike) */
  readonly request?: typeof httpRequest
}

const UA = 'Mozilla/5.0 (compatible; LobbyLinkPreview/1.0; +https://lobby.darkburn.com)'

/** Why a fetch gave nothing (never shown to anyone, only counted in tests). */
export type RefusedReason = 'invalid' | 'blocked' | 'status' | 'timeout' | 'network' | 'redirects'
export class FetchRefused extends Error {
  readonly reason: RefusedReason
  constructor(reason: RefusedReason) {
    super(reason)
    this.name = 'FetchRefused'
    this.reason = reason
  }
}

interface Hop {
  readonly res: IncomingMessage
  readonly done: () => void
}

function oneHop(
  deps: FetchDeps,
  url: URL,
  address: { address: string; family: number },
  accept: string,
  deadline: number,
): Promise<Hop> {
  const https = url.protocol === 'https:'
  const req = deps.request ?? (https ? httpsRequest : httpRequest)
  // the vetted address, whatever the resolver would say now
  const lookup: LookupFunction = (_host, opts, cb) => {
    if ((opts as { all?: boolean }).all) (cb as never as (e: null, a: unknown[]) => void)(null, [address])
    else cb(null, address.address, address.family)
  }
  return new Promise((resolve, reject) => {
    const left = deadline - Date.now()
    if (left <= 0) return reject(new FetchRefused('timeout'))
    const host = url.hostname.replace(/^\[|\]$/g, '')
    const r = req(
      {
        protocol: url.protocol,
        host,
        port: url.port || (https ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        lookup: isIP(host) ? undefined : lookup,
        ...(https && !isIP(host) ? { servername: host } : {}),
        headers: {
          'User-Agent': UA,
          Accept: accept,
          'Accept-Language': 'en',
          'Accept-Encoding': 'gzip, deflate, br',
        },
        agent: false,
        timeout: left,
      },
      (res) => resolve({ res, done: () => r.destroy() }),
    )
    const timer = setTimeout(() => r.destroy(new FetchRefused('timeout')), left)
    r.on('close', () => clearTimeout(timer))
    r.on('timeout', () => r.destroy(new FetchRefused('timeout')))
    r.on('error', (e) => reject(e instanceof FetchRefused ? e : new FetchRefused('network')))
    r.end()
  })
}

function decoded(res: IncomingMessage): NodeJS.ReadableStream {
  const enc = String(res.headers['content-encoding'] ?? '')
    .trim()
    .toLowerCase()
  if (enc === 'gzip' || enc === 'x-gzip') return res.pipe(createGunzip())
  if (enc === 'deflate') return res.pipe(createInflate())
  if (enc === 'br') return res.pipe(createBrotliDecompress())
  return res
}

/**
 * How often `enough` is asked while the body grows: once per this many new bytes. The server chooses its
 * chunks (a byte at a time is its to send), so asking after every chunk would rescan the whole body for
 * each one: the square of the body's size in work on the event loop (J4).
 */
const ENOUGH_STEP_BYTES = 4096

/**
 * Reads at most `max` bytes (stopping early once `enough(sofar)` says so), then drops the connection.
 * The bytes are copied into ONE buffer allocated up front (never a list of the server's chunks, which it
 * could make as many and as small as it likes), and `enough` sees a view of it, not a copy.
 */
function readCapped(
  res: IncomingMessage,
  max: number,
  deadline: number,
  enough: (sofar: Buffer) => boolean,
): Promise<{ body: Buffer; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const stream = decoded(res)
    const buf = Buffer.allocUnsafe(max)
    let size = 0
    let checked = 0
    let settled = false
    const finish = (truncated: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      res.destroy()
      // a copy of what was read: the page's limit-sized buffer is not kept
      resolve({ body: Buffer.from(buf.subarray(0, size)), truncated })
    }
    const timer = setTimeout(
      () => {
        if (settled) return
        settled = true
        res.destroy()
        reject(new FetchRefused('timeout'))
      },
      Math.max(0, deadline - Date.now()),
    )
    stream.on('data', (chunk: Buffer) => {
      if (settled) return
      const take = Math.min(chunk.length, max - size)
      chunk.copy(buf, size, 0, take)
      size += take
      if (size >= max) return finish(true)
      if (size - checked >= ENOUGH_STEP_BYTES) {
        checked = size
        if (enough(buf.subarray(0, size))) finish(true)
      }
    })
    stream.on('end', () => finish(false))
    stream.on('error', () => {
      if (settled) return
      // a broken compressed stream: whatever was read so far is still usable
      finish(true)
    })
  })
}

/**
 * GETs `raw` (following at most `maxRedirects` redirects, each re-checked) and returns what a 200
 * answered. Throws FetchRefused for a URL the policy refuses, any other status, a timeout or a network
 * error.
 */
export async function guardedFetch(
  deps: FetchDeps,
  raw: string,
  accept: string,
  limits: FetchLimits,
  enough: (sofar: Buffer) => boolean = () => false,
): Promise<Fetched> {
  const deadline = Date.now() + limits.timeoutMs
  let current = raw
  for (let hop = 0; hop <= limits.maxRedirects; hop++) {
    const target = checkUrl(current, deps.policy)
    if (target === 'invalid' || target === 'blocked') throw new FetchRefused(target)
    const left = deadline - Date.now()
    if (left <= 0) throw new FetchRefused('timeout')
    const address = await vetAddress(
      target,
      deps.lookup,
      Math.min(deps.lookupTimeoutMs ?? LOOKUP_TIMEOUT_MS, left),
    )
    if (address === 'blocked') throw new FetchRefused('blocked')
    const { res, done } = await oneHop(deps, target.url, address, accept, deadline)
    const status = res.statusCode ?? 0
    if (status >= 300 && status < 400 && res.headers.location) {
      done()
      res.resume()
      try {
        current = new URL(String(res.headers.location), target.url).href
      } catch {
        throw new FetchRefused('redirects')
      }
      continue
    }
    if (status !== 200) {
      done()
      res.resume()
      throw new FetchRefused('status')
    }
    const header = String(res.headers['content-type'] ?? '')
    const contentType = (header.split(';')[0] ?? '').trim().toLowerCase()
    const charset = /charset="?([\w.:-]+)/i.exec(header)?.[1] ?? null
    const { body, truncated } = await readCapped(res, limits.maxBytes, deadline, enough)
    return { url: target.url, contentType, charset, body, truncated }
  }
  throw new FetchRefused('redirects')
}
