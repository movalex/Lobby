// The link previews' own DNS lookup (J4, LP-DNS-1). `dns.lookup` (getaddrinfo) runs on libuv's small thread
// pool (4 threads by default) with no time limit of its own: a name server that never answers holds a
// thread for as long as the system resolver takes to give up, and a handful of such lookups stall every
// other use of the pool (file reads, zlib, crypto) for the whole api. The names a page can make the api
// look up are the other side's to choose (a link to `a1.attacker.example`, `a2.…`), so the lookup here is
// c-ares's (`dns.promises.Resolver`): it runs off the thread pool, each query has its own time limit and
// retry count, and a lookup the caller abandons (the fetch's time ran out) is cancelled, not left running.
//
// What it gives up compared with getaddrinfo is the hosts file and the system's search domains, neither
// of which a public web server's name needs (names without a dot and `*.local` etc. are refused before
// any lookup, ssrf.ts `checkUrl`). It answers every A and AAAA record, like the `all: true` lookup it
// replaces; vetAddress then refuses the name if ANY of them is not public.
import { Resolver } from 'node:dns/promises'
import type { Lookup, LookupAddress } from './ssrf.ts'

export interface SystemLookupOptions {
  /** one try of one query (c-ares retransmits after it); default 1,500 ms */
  readonly timeoutMs?: number
  /** tries per name server before the query fails; default 2 */
  readonly tries?: number
  /** name servers to ask instead of the system's (tests; `host:port` forms are accepted) */
  readonly servers?: readonly string[]
}

export const DNS_TRY_TIMEOUT_MS = 1_500
export const DNS_TRIES = 2

export function makeSystemLookup(opts: SystemLookupOptions = {}): Lookup {
  return async (host, signal) => {
    // one resolver per lookup: cancelling it can touch nothing else
    const resolver = new Resolver({
      timeout: opts.timeoutMs ?? DNS_TRY_TIMEOUT_MS,
      tries: opts.tries ?? DNS_TRIES,
    })
    if (opts.servers) resolver.setServers([...opts.servers])
    const abandon = () => resolver.cancel()
    if (signal?.aborted) abandon()
    signal?.addEventListener('abort', abandon, { once: true })
    try {
      const [v4, v6] = await Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)])
      const found: LookupAddress[] = []
      if (v4.status === 'fulfilled') for (const address of v4.value) found.push({ address, family: 4 })
      if (v6.status === 'fulfilled') for (const address of v6.value) found.push({ address, family: 6 })
      if (!found.length) throw new Error('the name has no address')
      return found
    } finally {
      signal?.removeEventListener('abort', abandon)
    }
  }
}
