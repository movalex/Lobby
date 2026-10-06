// Link previews (D2, docs/research/excalidraw/REVIEW-W5-EARLY.md §9): which URLs the api may fetch on a
// person's behalf. The fetch runs inside the api's network, so every hop must be refused unless it is
// a public web server on the default ports:
//   - http(s) only, no user:password, no signed query (canvas-schema `isAllowedLink`), at most 2 KiB;
//   - port 80 or 443 only (the default ports of the scheme);
//   - the host is not a bare name, `localhost`, `*.local`, `*.internal`, `*.localhost` or the like;
//   - EVERY address the host resolves to is public unicast (no loopback, private, link-local such as
//     169.254.169.254, carrier-grade NAT, documentation, benchmark, multicast or reserved ranges; for
//     IPv6 no unique-local, site-local, link-local, NAT64, 6to4, Teredo or v4-mapped private address);
//   - the connection then goes to that vetted address (no second lookup a DNS rebind could change),
//     and each redirect is checked again from the start.
//
// Pure apart from the DNS lookup it is given. A test seam (`allowOrigins`) lets e2e reach a fixture
// server on loopback; the feature honours it only behind the local-dev guard (DRAFTROOM_DEV_AUTH=1,
// never in production).
import { BlockList, isIP } from 'node:net'
import { isAllowedLink, MAX_LINK_BYTES } from '@draftroom/canvas-schema/limits'

const V4_BLOCKED: readonly [string, number][] = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (cloud metadata)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, and the broadcast address
]

const V6_BLOCKED: readonly [string, number][] = [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  // (v4-mapped ::ffff:0:0/96 is refused outright below: a BlockList that holds it also matches IPv4)
  ['64:ff9b::', 96], // NAT64
  ['64:ff9b:1::', 48], // local-use NAT64
  ['100::', 64], // discard
  ['2001::', 23], // IETF protocol assignments (Teredo 2001::/32 included)
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated)
  ['ff00::', 8], // multicast
]

// one list per family: Node's BlockList matches an IPv4 address against IPv6 rules too
const blockedV4 = new BlockList()
for (const [net, prefix] of V4_BLOCKED) blockedV4.addSubnet(net, prefix, 'ipv4')
const blockedV6 = new BlockList()
for (const [net, prefix] of V6_BLOCKED) blockedV6.addSubnet(net, prefix, 'ipv6')

/** The IPv4 address inside a v4-mapped or v4-compatible IPv6 address (`::ffff:a.b.c.d`), else null. */
function embeddedV4(v6: string): string | null {
  const m = /^(?:0{0,4}:){0,5}(?::ffff:|::|ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(v6)
  if (m?.[1]) return m[1]
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(v6)
  if (!hex?.[1] || !hex[2]) return null
  const hi = Number.parseInt(hex[1], 16)
  const lo = Number.parseInt(hex[2], 16)
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`
}

/** Whether `address` (an IPv4 or IPv6 literal) is a public unicast address the api may connect to. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) return !blockedV4.check(address, 'ipv4')
  if (family !== 6) return false
  const bare = address.replace(/^\[|\]$/g, '').split('%')[0] ?? ''
  // an IPv4 address written as IPv6 (::ffff:a.b.c.d, ::a.b.c.d): never a public server's AAAA record
  if (embeddedV4(bare)) return false
  if (blockedV6.check(bare, 'ipv6')) return false
  // only global unicast (2000::/3) is public
  const first = Number.parseInt(bare.split(':')[0] || '0', 16)
  return first >= 0x2000 && first <= 0x3fff
}

/** Host names that never name a public web server. */
function isLocalName(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '')
  if (!h.includes('.')) return true // a bare name resolves through the local search domains
  return /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|private|test|invalid|example|onion|home\.arpa)$/.test(
    h,
  )
}

export interface Target {
  readonly url: URL
  /** the host to resolve (an IP literal's brackets removed) */
  readonly host: string
  readonly port: number
  /** allowed by the test seam: the address check is skipped */
  readonly seam: boolean
}

export type Refusal = 'invalid' | 'blocked'

export interface Policy {
  /** exact origins (`http://127.0.0.1:6830`) the e2e seam may reach; empty outside local dev */
  readonly allowOrigins: ReadonlySet<string>
}

/**
 * Checks a URL before anything is resolved: `invalid` when it is not a link a board may hold (the
 * client is told), `blocked` when it is one the api will not fetch (answered like an unreachable page,
 * so the refusal tells nothing about the api's network).
 */
export function checkUrl(raw: unknown, policy: Policy): Target | Refusal {
  if (typeof raw !== 'string' || !raw || Buffer.byteLength(raw) > MAX_LINK_BYTES) return 'invalid'
  if (!isAllowedLink(raw) || raw.startsWith('/') || /^mailto:/i.test(raw)) return 'invalid'
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return 'invalid'
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'invalid'
  if (url.username || url.password) return 'invalid'
  url.hash = ''
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80
  if (policy.allowOrigins.has(url.origin)) return { url, host, port, seam: true }
  if (port !== 80 && port !== 443) return 'blocked'
  if (isIP(host)) return isPublicAddress(host) ? { url, host, port, seam: false } : 'blocked'
  if (isLocalName(host)) return 'blocked'
  return { url, host, port, seam: false }
}

export interface LookupAddress {
  readonly address: string
  readonly family: number
}
/** A lookup the caller may abandon: `signal` aborts when the answer is no longer wanted (the time ran out). */
export type Lookup = (host: string, signal?: AbortSignal) => Promise<readonly LookupAddress[]>

/** The longest one DNS lookup is waited for (a name server that never answers must not hold a fetch slot). */
export const LOOKUP_TIMEOUT_MS = 3_000

/**
 * The one address the api connects to for `target`, or `blocked` when the host does not resolve (or not within
 * `timeoutMs`: the same answer as a host that does not exist) or any of its addresses is not public (a name
 * that also points inside is refused as a whole).
 */
export async function vetAddress(
  target: Target,
  lookup: Lookup,
  timeoutMs: number = LOOKUP_TIMEOUT_MS,
): Promise<LookupAddress | 'blocked'> {
  const literal = isIP(target.host)
  if (literal) return { address: target.host, family: literal }
  let found: readonly LookupAddress[]
  const ctl = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    found = await Promise.race([
      lookup(target.host, ctl.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          ctl.abort()
          reject(new Error('lookup timed out'))
        }, timeoutMs)
      }),
    ])
  } catch {
    return 'blocked'
  } finally {
    clearTimeout(timer)
  }
  if (!found.length) return 'blocked'
  if (!target.seam && found.some((a) => !isPublicAddress(a.address))) return 'blocked'
  return found.find((a) => a.family === 4) ?? (found[0] as LookupAddress)
}
