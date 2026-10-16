// Which outbound requests the api may make outside link previews (wave R; the reviewed exceptions in AGENTS.md "Server
// egress exception: Miro import" and "…: chat notifications"). A request is refused before anything is resolved
// unless ONE rule allows all of it:
//   - `https:` on port 443 (no other port, no plain http), no user or password, no fragment;
//   - the host matches the rule exactly (a string, compared as lower case, never by suffix), or the rule's anchored
//     pattern (a provider whose host carries a tenant), and it is never an IP literal;
//   - the path matches one of the rule's patterns, the method is one the rule allows, and the rule's own `check`
//     (a signed URL's expiry, a webhook's query) passes;
//   - a Bearer secret only on a rule that carries one (`bearer`), and never on any other.
// The address is then vetted and pinned (fetch.ts). The test seam (`testOrigins`) maps an exact local origin to the
// rule it stands for; every rule check except scheme, port and address still applies there. The seam is honoured
// only behind the local-dev guard (devAuth, never production: config.ts).
//
// Pure. Nothing here logs.

import { isIP } from 'node:net'

export type EgressMethod = 'GET' | 'POST'

export interface HostRule {
  /** a name for logs and tests (`miro-api`, `miro-files`, `slack`, `teams`) */
  readonly id: string
  /** exact lower-case host, a list of them (an empty list matches nothing), or an anchored pattern */
  readonly host: string | readonly string[] | RegExp
  /** the path must match one of these (the query is not part of it) */
  readonly paths: readonly RegExp[]
  readonly methods: readonly EgressMethod[]
  /** whether a Bearer secret may be sent to this host */
  readonly bearer: boolean
  /** a further check of the whole URL (an expiry, the query keys); `now` is epoch ms */
  readonly check?: (url: URL, now: number) => boolean
}

export interface EgressPolicy {
  readonly rules: readonly HostRule[]
  /** exact origins (`http://127.0.0.1:7801`) → the ids of the rules each stands for; empty outside local dev */
  readonly testOrigins: ReadonlyMap<string, readonly string[]>
}

export interface EgressTarget {
  readonly url: URL
  readonly rule: HostRule
  /** the host to resolve and connect to */
  readonly host: string
  readonly port: number
  /** allowed by the test seam: scheme, port and the address check are skipped */
  readonly seam: boolean
}

/** Why a request was refused before it was made (a code only: never the URL). */
export type PolicyRefusal = 'invalid' | 'host' | 'scheme' | 'path' | 'method' | 'bearer' | 'check'

function hostMatches(rule: HostRule, host: string): boolean {
  if (typeof rule.host === 'string') return rule.host === host
  if (rule.host instanceof RegExp) return rule.host.test(host)
  return rule.host.includes(host)
}

/** Why `rule` refuses the request, or null when it allows it. */
function ruleRefusal(rule: HostRule, url: URL, method: EgressMethod, bearer: boolean, now: number) {
  if (!rule.methods.includes(method)) return 'method' as const
  if (bearer && !rule.bearer) return 'bearer' as const
  if (!rule.paths.some((p) => p.test(url.pathname))) return 'path' as const
  if (rule.check && !rule.check(url, now)) return 'check' as const
  return null
}

/** The rule that allows `method raw` (with a Bearer secret or not), or why none does. */
export function checkTarget(
  raw: string,
  method: EgressMethod,
  bearer: boolean,
  policy: EgressPolicy,
  now: number,
): EgressTarget | PolicyRefusal {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 8192) return 'invalid'
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return 'invalid'
  }
  if (url.username || url.password || url.hash) return 'invalid'
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const seamIds = policy.testOrigins.get(url.origin)
  const seam = seamIds !== undefined
  let candidates: readonly HostRule[]
  if (seamIds) candidates = policy.rules.filter((r) => seamIds.includes(r.id))
  else {
    if (url.protocol !== 'https:') return 'scheme'
    if (url.port !== '' && url.port !== '443') return 'scheme'
    if (!host || host.endsWith('.') || isIP(host)) return 'host'
    candidates = policy.rules.filter((r) => hostMatches(r, host))
  }
  if (!candidates.length) return 'host'
  let refusal: PolicyRefusal = 'host'
  for (const rule of candidates) {
    const why = ruleRefusal(rule, url, method, bearer, now)
    if (!why) {
      const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80
      return { url, rule, host, port, seam }
    }
    refusal = why
  }
  return refusal
}

/** A policy from rules and the (dev-guarded) seam origins `[origin, rule id]` (an origin may stand for several). */
export function makeEgressPolicy(
  rules: readonly HostRule[],
  testOrigins: Iterable<readonly [string, string]> = [],
): EgressPolicy {
  const seam = new Map<string, string[]>()
  for (const [origin, id] of testOrigins) seam.set(origin, [...(seam.get(origin) ?? []), id])
  return { rules, testOrigins: seam }
}
