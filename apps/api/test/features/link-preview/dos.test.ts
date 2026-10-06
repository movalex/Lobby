// J4 (wave J): what one hostile page, name server or crowd of callers can cost the api's event loop through
// the link previews. LP-REDOS: the <head> parser was five regexes retried from every `<` (the square of the
// page: 13 s of the loop for a 512 KiB page of `<!--`, 19 s for `<meta `). LP-DNS-1: a DNS lookup with no time
// limit, and an unbounded queue behind six fetch slots. Each test here fails on the code before J4 (the
// pathological inputs take seconds there, the bounds below are a few hundred milliseconds).

import { createSocket, type Socket } from 'node:dgram'
import { EventEmitter } from 'node:events'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { PassThrough } from 'node:stream'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeSystemLookup } from '../../../src/features/link-preview/dns.ts'
import { guardedFetch } from '../../../src/features/link-preview/fetch.ts'
import { Gate, GateFull } from '../../../src/features/link-preview/gate.ts'
import { LINK_PREVIEW_LIMITS, readPreview } from '../../../src/features/link-preview/index.ts'
import {
  cleanText,
  decodeHtml,
  MAX_HEAD_CHARS,
  MAX_ICONS,
  MAX_TAG_CHARS,
  MAX_TITLE_CHARS,
  type PageMeta,
  parseHead,
} from '../../../src/features/link-preview/parse.ts'
import { checkUrl, type Lookup, vetAddress } from '../../../src/features/link-preview/ssrf.ts'
import { type Client, createBoard, createTestApi, DEV_STUDIO, type TestApi } from '../../helpers.ts'

const NONE = { allowOrigins: new Set<string>() }
const KIB = 1024

/** The wall-clock bound for anything that was seconds of work before J4 (a loaded CI core stays far below). */
const FAST_MS = 300

const timed = <T>(fn: () => T): { value: T; ms: number } => {
  const t0 = performance.now()
  const value = fn()
  return { value, ms: performance.now() - t0 }
}

// ---- LP-REDOS: the parser -----------------------------------------------------------------------------

/** The parser as it was before J4 (regexes), kept as the oracle the linear scan is compared with. */
function legacyParseHead(html: string): PageMeta {
  const attrsOf = (tag: string) => {
    const out: Record<string, string> = {}
    const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
    const body = tag.replace(/^<\s*[a-zA-Z]+/, '').replace(/\/?>$/, '')
    for (const m of body.matchAll(re)) {
      const name = (m[1] ?? '').toLowerCase()
      if (!name || name in out) continue
      out[name] = m[3] ?? m[4] ?? m[5] ?? ''
    }
    return out
  }
  const end = html.search(/<\/head\s*>|<body[\s>]/i)
  const head = end >= 0 ? html.slice(0, end) : html
  const scan = head
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1\s*>/gi, ' ')
  const metas: Record<string, string>[] = []
  const icons: PageMeta['icons'][number][] = []
  let charset: string | null = null
  for (const m of scan.matchAll(/<(meta|link)\b[^>]*>/gi)) {
    const a = attrsOf(m[0])
    if ((m[1] ?? '').toLowerCase() === 'meta') {
      metas.push(a)
      if (a.charset) charset = a.charset
      else if ((a['http-equiv'] ?? '').toLowerCase() === 'content-type')
        charset = /charset=([\w.:-]+)/i.exec(a.content ?? '')?.[1] ?? charset
      continue
    }
    const rel = (a.rel ?? '').toLowerCase().split(/\s+/)
    if (a.href && (rel.includes('icon') || rel.includes('apple-touch-icon')))
      icons.push({
        href: a.href,
        rel: rel.join(' '),
        sizes: (a.sizes ?? '').toLowerCase(),
        type: a.type ?? '',
      })
  }
  const meta = (key: string) =>
    metas.find((a) => (a.property ?? a.name ?? '').toLowerCase() === key && typeof a.content === 'string')
      ?.content ?? null
  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(scan)?.[1] ?? null
  const rawTitle = meta('og:title') ?? meta('twitter:title') ?? titleTag
  const rawSite = meta('og:site_name') ?? meta('application-name')
  return {
    title: rawTitle === null ? null : cleanText(rawTitle, MAX_TITLE_CHARS),
    siteName: rawSite === null ? null : cleanText(rawSite, 80),
    icons,
    charset,
  }
}

describe('LP-REDOS: the <head> parser is linear and bounded', () => {
  /** A page of exactly `bytes` characters made of `unit` repeated (after an opening <head>). */
  const page = (unit: string, bytes = 512 * KIB) =>
    `<head>${unit.repeat(Math.ceil(bytes / unit.length))}`.slice(0, bytes)

  const HOSTILE: Record<string, string> = {
    'unclosed comments': '<!--',
    'unclosed meta tags': '<meta ',
    'unclosed link tags': '<link rel=icon ',
    'unclosed scripts': '<script ',
    'unclosed noscripts': '<noscript>',
    'unclosed styles': '<style>',
    'unclosed titles': '<title>',
    'bare angle brackets': '<',
    'closing tags without >': '</head ',
    'closing script tags that never close right': '<script></script ',
    mixed: '<!--<meta <script <title>',
    'meta tags whose > never comes': '<meta a="b" c=\'d\' e=f ',
  }

  for (const [name, unit] of Object.entries(HOSTILE)) {
    it(`a 512 KiB page of ${name} is read in a few milliseconds`, () => {
      const { ms } = timed(() => parseHead(page(unit)))
      expect(ms).toBeLessThan(FAST_MS)
    })
  }

  it('one enormous tag, one enormous attribute list and one enormous title are bounded too', () => {
    for (const html of [
      `<head><meta ${'a '.repeat(250 * KIB)}>`,
      `<head><meta a="${'x'.repeat(500 * KIB)}">`,
      `<head><meta a=${' '.repeat(500 * KIB)}">`,
      `<head><title>${' '.repeat(500 * KIB)}x</title>`,
      `<head><title>${'x'.repeat(500 * KIB)}</title>`,
      `<head>${'<meta a=b>'.repeat(50_000)}`,
      `<head>${'<link rel=icon href=/x>'.repeat(20_000)}`,
    ]) {
      const { value, ms } = timed(() => parseHead(html))
      expect(ms, html.slice(0, 40)).toBeLessThan(FAST_MS)
      expect(value.icons.length).toBeLessThanOrEqual(MAX_ICONS)
      expect((value.title ?? '').length).toBeLessThanOrEqual(MAX_TITLE_CHARS)
    }
  })

  it('the charset sniff of the first 4 KiB is linear as well', () => {
    const body = Buffer.from('<meta'.repeat(900))
    expect(timed(() => decodeHtml(body, null)).ms).toBeLessThan(FAST_MS)
    expect(decodeHtml(Buffer.from('<meta charset="utf-8"><title>é</title>', 'utf8'), null)).toContain('é')
    // the page says windows-1252: its byte 0xe9 is é (the sniff reads the meta tag)
    const latin = Buffer.concat([Buffer.from('<meta charset=windows-1252><title>'), Buffer.from([0xe9])])
    expect(decodeHtml(latin, null)).toContain('é')
    const equiv = Buffer.concat([
      Buffer.from('<meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1"><title>'),
      Buffer.from([0xe9]),
    ])
    expect(decodeHtml(equiv, null)).toContain('é')
    // the header's charset wins over the meta tag
    expect(decodeHtml(Buffer.from('<meta charset=windows-1252>é', 'utf8'), 'utf-8')).toContain('é')
  })

  it('reads at most MAX_HEAD_CHARS: a title after that is not found, one before it is', () => {
    const filler = `<style>${'x'.repeat(MAX_HEAD_CHARS)}</style>`
    expect(parseHead(`<head>${filler}<title>late</title>`).title).toBeNull()
    expect(parseHead(`<head><title>early</title>${filler}`).title).toBe('early')
    expect(parseHead(`<head><style>${'x'.repeat(100 * KIB)}</style><title>mid</title>`).title).toBe('mid')
  })

  it('skips a tag longer than MAX_TAG_CHARS and keeps reading after it', () => {
    const long = `<meta property="og:title" content="${'x'.repeat(MAX_TAG_CHARS)}">`
    expect(parseHead(`<head>${long}<meta property="og:site_name" content="Still here">`)).toMatchObject({
      title: null,
      siteName: 'Still here',
    })
    const ok = `<meta property="og:title" content="${'y'.repeat(MAX_TAG_CHARS - 200)}">`
    expect(parseHead(`<head>${ok}`).title?.startsWith('yyy')).toBe(true)
  })

  it('keeps at most MAX_ICONS icon links', () => {
    const many = Array.from({ length: MAX_ICONS * 3 }, (_, i) => `<link rel="icon" href="/i${i}.png">`).join(
      '',
    )
    expect(parseHead(`<head>${many}</head>`).icons).toHaveLength(MAX_ICONS)
  })

  it('what the head holds is read as a browser would: scripts, styles, comments and noscript hide tags', () => {
    const meta = parseHead(
      '<head><script>var s="</head><title>no</title>"</script><title>Real</title>' +
        '<!-- </head> <meta property="og:site_name" content="hidden"> -->' +
        '<noscript><meta property="og:site_name" content="hidden"></noscript>' +
        '<style>/* <title>no</title> */</style><meta property="og:site_name" content="Seen"></head>' +
        '<body><title>body</title><meta property="og:site_name" content="body">',
    )
    expect(meta).toMatchObject({ title: 'Real', siteName: 'Seen' })
  })

  it('a comment, a script or a title that never ends hides the rest, or gives no title', () => {
    expect(
      parseHead('<head><title>a</title><!-- never ended <meta property="og:site_name" content="x">'),
    ).toMatchObject({ title: 'a', siteName: null })
    expect(parseHead('<head><script>never ended <title>x</title>').title).toBeNull()
    expect(parseHead('<head><title>never ended <meta property="og:site_name" content="x">')).toMatchObject({
      title: null,
      siteName: 'x',
    })
  })

  // The linear scan answers what the regexes answered, on well-formed heads: a generated corpus of balanced
  // fragments in any order (with `</head>` and `<body` only where they end the head), both parsers, same answer.
  it('gives the answers the regex parser gave, on a generated corpus of well-formed pages', () => {
    const FRAGMENTS = [
      '<title>Hello &amp; goodbye</title>',
      '<TITLE >Upper</TITLE >',
      '<title>\n  spaced ‮ out \n</title>',
      '<meta property="og:title" content="OG title">',
      "<meta name='twitter:title' content='TW title'>",
      '<meta charset=utf-8>',
      '<META HTTP-EQUIV="Content-Type" content="text/html; charset=iso-8859-1">',
      '<meta property="og:site_name" content="The Site">',
      '<meta name="application-name" content="App">',
      '<meta name="viewport" content="width=device-width">',
      '<link rel="icon" href="/a.png" sizes="32x32">',
      '<link rel="shortcut icon" type="image/x-icon" href="/fav.ico">',
      '<link rel="apple-touch-icon" href="/b.png" sizes="180x180">',
      '<link rel="stylesheet" href="/c.css">',
      '<link rel=icon href=/unquoted.png>',
      '<!-- <title>commented</title> <meta property="og:title" content="hidden"> -->',
      '<script>var a = "<title>x</title><meta property=og:title content=h>";</script>',
      '<SCRIPT type="module">import "x"</SCRIPT >',
      '<style>.a > .b { color: red }</style>',
      '<noscript><link rel="icon" href="/hidden.png"></noscript>',
      '<base href="/">',
      'some stray text ',
      '<div class="x">',
      '</div>',
    ]
    let seed = 0x9e3779b9
    const rnd = () => {
      seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x297a2d39) | 0
      return (seed >>> 0) / 4294967296
    }
    const pick = () => FRAGMENTS[Math.floor(rnd() * FRAGMENTS.length)] as string
    for (let n = 0; n < 1_500; n++) {
      const inHead = Array.from({ length: 1 + Math.floor(rnd() * 9) }, pick).join(rnd() < 0.3 ? '\n' : '')
      const closing = ['</head>', '</HEAD >', '<body>', '<BODY class=x>', ''][Math.floor(rnd() * 5)] as string
      const after = closing ? Array.from({ length: Math.floor(rnd() * 4) }, pick).join('') : ''
      const html = `<!doctype html><html><head>${inHead}${closing}${after}`
      expect(parseHead(html), html).toEqual(legacyParseHead(html))
    }
  })
})

// ---- LP-REDOS: the body read ----------------------------------------------------------------------------

describe('LP-REDOS: a body arriving a byte at a time is read in linear time', () => {
  const LIMITS = { timeoutMs: 20_000, maxBytes: 512 * KIB, maxRedirects: 2 }

  /** A request function (the guarded fetch's test seam) whose server writes `chunks` pieces of `size` bytes. */
  const trickle = (chunks: number, size: number) =>
    ((_opts: unknown, cb: (res: IncomingMessage) => void) => {
      const req = Object.assign(new EventEmitter(), {
        end() {
          const res = Object.assign(new PassThrough(), {
            statusCode: 200,
            headers: { 'content-type': 'text/html' },
          }) as unknown as IncomingMessage
          cb(res)
          const piece = Buffer.alloc(size, 0x61)
          setImmediate(() => {
            for (let i = 0; i < chunks; i++) (res as unknown as PassThrough).write(piece)
            ;(res as unknown as PassThrough).end()
          })
        },
        destroy() {
          req.emit('close')
        },
      })
      return req
    }) as never

  it('asks "is the head complete?" a bounded number of times, not once per chunk', async () => {
    const asked = vi.fn(() => false)
    const t0 = performance.now()
    const got = await guardedFetch(
      {
        policy: NONE,
        lookup: async () => [{ address: '93.184.216.34', family: 4 }],
        request: trickle(300_000, 1),
      },
      'https://news.example.com/',
      '*/*',
      LIMITS,
      asked,
    )
    const ms = performance.now() - t0
    expect(got.body.length).toBe(300_000)
    expect(got.truncated).toBe(false)
    // once per 4 KiB of new bytes at most (300,000 chunks of one byte each used to be 300,000 rescans)
    expect(asked.mock.calls.length).toBeLessThanOrEqual(Math.ceil(300_000 / 4096) + 1)
    expect(ms).toBeLessThan(3_000)
  })

  it('still stops early once the head is complete, and at the byte limit', async () => {
    const deps = {
      policy: NONE,
      lookup: async () => [{ address: '93.184.216.34', family: 4 }],
      request: trickle(40_000, 1),
    }
    const early = await guardedFetch(
      deps,
      'https://news.example.com/',
      '*/*',
      LIMITS,
      (sofar) => sofar.length >= 8192,
    )
    expect(early.truncated).toBe(true)
    expect(early.body.length).toBeGreaterThanOrEqual(8192)
    expect(early.body.length).toBeLessThan(8192 + 4096 + 1)
    const capped = await guardedFetch(deps, 'https://news.example.com/', '*/*', {
      ...LIMITS,
      maxBytes: 5_000,
    })
    expect(capped.body.length).toBe(5_000)
    expect(capped.truncated).toBe(true)
    expect(capped.body.every((b) => b === 0x61)).toBe(true)
  })
})

// ---- LP-DNS-1: the lookup's time limit ----------------------------------------------------------------

describe('LP-DNS-1: a DNS lookup has a time limit', () => {
  const target = (host = 'slow.example.com') => {
    const t = checkUrl(`https://${host}/`, NONE)
    if (t === 'invalid' || t === 'blocked') throw new Error('unexpected')
    return t
  }

  it('a name server that never answers: the name is refused (like one that does not exist) within the limit, and the lookup is told to stop', async () => {
    let aborted = false
    const hung: Lookup = (_host, signal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          aborted = true
          reject(new Error('cancelled'))
        })
      })
    const { value, ms } = await (async () => {
      const t0 = performance.now()
      return { value: await vetAddress(target(), hung, 80), ms: performance.now() - t0 }
    })()
    expect(value).toBe('blocked')
    expect(ms).toBeGreaterThanOrEqual(70)
    expect(ms).toBeLessThan(1_000)
    expect(aborted).toBe(true)
  })

  it('a lookup that ignores the signal is not waited for either, and an answer after the limit is not used', async () => {
    const late: Lookup = () =>
      new Promise((r) => setTimeout(() => r([{ address: '93.184.216.34', family: 4 }]), 400))
    expect(await vetAddress(target(), late, 50)).toBe('blocked')
    const quick: Lookup = async () => [{ address: '93.184.216.34', family: 4 }]
    expect(await vetAddress(target(), quick, 50)).toEqual({ address: '93.184.216.34', family: 4 })
  })

  it('the fetch passes its own deadline on: a lookup never outlasts the fetch', async () => {
    const hung: Lookup = () => new Promise(() => {})
    const t0 = performance.now()
    await expect(
      guardedFetch(
        { policy: NONE, lookup: hung, lookupTimeoutMs: 10_000 },
        'https://slow.example.com/',
        '*/*',
        {
          timeoutMs: 150,
          maxBytes: 1024,
          maxRedirects: 1,
        },
      ),
    ).rejects.toMatchObject({ reason: 'blocked' })
    expect(performance.now() - t0).toBeLessThan(1_500)
    // and readPreview never throws for it: all null, within the same bound
    const t1 = performance.now()
    expect(
      await readPreview({ policy: NONE, lookup: hung, lookupTimeoutMs: 100 }, 'https://slow.example.com/'),
    ).toEqual({
      title: null,
      siteName: null,
      icon: null,
    })
    expect(performance.now() - t1).toBeLessThan(1_500)
  })

  describe('the system lookup (c-ares, off the thread pool)', () => {
    let dns: Socket
    let port = 0
    let queries = 0
    let answer: (query: Buffer, from: { address: string; port: number }) => void = () => {}
    beforeAll(async () => {
      dns = createSocket('udp4')
      dns.on('message', (msg, rinfo) => {
        queries++
        answer(msg, rinfo)
      })
      await new Promise<void>((r) => dns.bind(0, '127.0.0.1', r))
      port = dns.address().port
    })
    afterAll(() => new Promise<void>((r) => dns.close(() => r())))
    beforeEach(() => {
      queries = 0
      answer = () => {} // a black hole: never answers
    })

    /** A DNS response to `query`: its question, and the given records (type 1 = A, 28 = AAAA). */
    const respond = (query: Buffer, records: { type: number; rdata: Buffer }[]) => {
      let end = 12
      while (query[end] !== 0) end += (query[end] ?? 0) + 1
      const question = query.subarray(12, end + 5)
      const head = Buffer.alloc(12)
      query.copy(head, 0, 0, 2)
      head.writeUInt16BE(0x8180, 2)
      head.writeUInt16BE(1, 4)
      head.writeUInt16BE(records.length, 6)
      const answers = records.map((r) => {
        const b = Buffer.alloc(12 + r.rdata.length)
        b.writeUInt16BE(0xc00c, 0)
        b.writeUInt16BE(r.type, 2)
        b.writeUInt16BE(1, 4)
        b.writeUInt32BE(60, 6)
        b.writeUInt16BE(r.rdata.length, 10)
        r.rdata.copy(b, 12)
        return b
      })
      return Buffer.concat([head, question, ...answers])
    }
    const qtype = (query: Buffer) => {
      let end = 12
      while (query[end] !== 0) end += (query[end] ?? 0) + 1
      return query.readUInt16BE(end + 1)
    }

    it('answers every A and AAAA record of the name', async () => {
      answer = (q, from) => {
        const records =
          qtype(q) === 1
            ? [
                { type: 1, rdata: Buffer.from([93, 184, 216, 34]) },
                { type: 1, rdata: Buffer.from([10, 0, 0, 1]) },
              ]
            : qtype(q) === 28
              ? [{ type: 28, rdata: Buffer.from('26062800022000010248189325c81946', 'hex') }]
              : []
        dns.send(respond(q, records), from.port, from.address)
      }
      const lookup = makeSystemLookup({ servers: [`127.0.0.1:${port}`], timeoutMs: 500, tries: 1 })
      const found = await lookup('news.example.com')
      expect(found).toEqual([
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.1', family: 4 },
        { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
      ])
      // and vetAddress refuses it as a whole: one of its addresses is inside
      expect(await vetAddress(target('news.example.com'), lookup, 2_000)).toBe('blocked')
    })

    it('a name with only an IPv6 or only an IPv4 record resolves; one with none is an error', async () => {
      answer = (q, from) =>
        dns.send(
          respond(q, qtype(q) === 1 ? [{ type: 1, rdata: Buffer.from([93, 184, 216, 34]) }] : []),
          from.port,
          from.address,
        )
      const lookup = makeSystemLookup({ servers: [`127.0.0.1:${port}`], timeoutMs: 500, tries: 1 })
      expect(await lookup('v4only.example.com')).toEqual([{ address: '93.184.216.34', family: 4 }])
      answer = (q, from) => dns.send(respond(q, []), from.port, from.address)
      await expect(lookup('nothing.example.com')).rejects.toThrow()
    })

    it('a name server that never answers: the lookup gives up by itself, and by the caller’s limit sooner', async () => {
      const own = makeSystemLookup({ servers: [`127.0.0.1:${port}`], timeoutMs: 150, tries: 1 })
      const t0 = performance.now()
      await expect(own('hole.example.com')).rejects.toThrow()
      const gaveUp = performance.now() - t0
      expect(gaveUp).toBeLessThan(2_000)
      expect(queries).toBeGreaterThan(0)
      // a resolver that would wait a minute is cancelled by vetAddress's limit
      const patient = makeSystemLookup({ servers: [`127.0.0.1:${port}`], timeoutMs: 30_000, tries: 3 })
      const t1 = performance.now()
      expect(await vetAddress(target('hole2.example.com'), patient, 150)).toBe('blocked')
      expect(performance.now() - t1).toBeLessThan(1_500)
    })

    it('a flood of lookups to a name server that never answers does not touch libuv’s thread pool', async () => {
      // 32 stuck lookups at once, then file reads (the pool's work) still complete at once: getaddrinfo would
      // have held every thread of the pool of four
      const own = makeSystemLookup({ servers: [`127.0.0.1:${port}`], timeoutMs: 1_000, tries: 1 })
      const stuck = Array.from({ length: 32 }, (_, i) => own(`h${i}.example.com`).catch(() => null))
      const { readFile } = await import('node:fs/promises')
      const t0 = performance.now()
      await Promise.all(Array.from({ length: 8 }, () => readFile(new URL(import.meta.url))))
      expect(performance.now() - t0).toBeLessThan(500)
      await Promise.all(stuck)
    })
  })
})

// ---- LP-DNS-1: the bounded queue -------------------------------------------------------------------------

describe('LP-DNS-1: the gate (shared fetch slots)', () => {
  const hold = (gate: Gate) => {
    let release!: () => void
    const done = gate.run(() => new Promise<void>((r) => (release = r)))
    return { release: () => release(), done }
  }

  it('lets `concurrent` run, queues `maxQueue`, and refuses the rest at once', async () => {
    const gate = new Gate({ concurrent: 2, maxQueue: 3 })
    const running = [hold(gate), hold(gate)]
    const queued = [hold(gate), hold(gate), hold(gate)]
    expect(gate.running).toBe(2)
    expect(gate.waiting).toBe(3)
    await expect(gate.acquire()).rejects.toMatchObject({ name: 'GateFull', refusal: 'full' })
    await expect(gate.run(async () => 1)).rejects.toBeInstanceOf(GateFull)
    // a place freed goes to the first waiter, and the count never exceeds `concurrent`
    running[0]?.release()
    await running[0]?.done
    expect(gate.running).toBe(2)
    expect(gate.waiting).toBe(2)
    for (const h of [...running.slice(1), ...queued]) {
      h.release()
      await h.done
    }
    expect(gate.running).toBe(0)
    expect(gate.waiting).toBe(0)
    expect(await gate.run(async () => 'free again')).toBe('free again')
  })

  it('never lets more than `concurrent` run, whatever the order callers arrive and finish in', async () => {
    const gate = new Gate({ concurrent: 3, maxQueue: 500 })
    let now = 0
    let peak = 0
    const work = async (i: number) => {
      now++
      peak = Math.max(peak, now)
      await new Promise((r) => setTimeout(r, i % 3))
      now--
    }
    await Promise.all(Array.from({ length: 300 }, (_, i) => gate.run(() => work(i))))
    expect(peak).toBe(3)
    expect(gate.running).toBe(0)
  })

  it('a caller that waits too long is refused, and leaves the queue', async () => {
    const gate = new Gate({ concurrent: 1, maxQueue: 5, maxWaitMs: 60 })
    const first = hold(gate)
    const t0 = performance.now()
    await expect(gate.acquire()).rejects.toMatchObject({ refusal: 'wait-timeout' })
    expect(performance.now() - t0).toBeGreaterThanOrEqual(50)
    expect(gate.waiting).toBe(0)
    first.release()
    await first.done
    // the place was not lost to the caller that gave up
    expect(await gate.run(async () => 'ok')).toBe('ok')
    expect(gate.running).toBe(0)
  })

  it('a release is counted once however often it is called', async () => {
    const gate = new Gate({ concurrent: 1, maxQueue: 0 })
    const release = await gate.acquire()
    release()
    release()
    const again = await gate.acquire()
    await expect(gate.acquire()).rejects.toBeInstanceOf(GateFull) // one place, not two
    again()
  })
})

// ---- the route -------------------------------------------------------------------------------------------

describe('POST /api/boards/:bid/link-preview under hostile pages and a crowd', () => {
  let server: Server
  let origin = ''
  let handler: (req: IncomingMessage, res: import('node:http').ServerResponse) => void = (_q, r) => r.end()
  beforeAll(async () => {
    server = createServer((req, res) => handler(req, res))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => new Promise<void>((r) => server.close(() => r())))

  const saved = { ...LINK_PREVIEW_LIMITS }
  let api: TestApi
  let alice: Client
  let board: string
  const open: import('node:http').ServerResponse[] = []
  afterEach(async () => {
    Object.assign(LINK_PREVIEW_LIMITS, saved)
    for (const r of open.splice(0)) r.destroy()
    await api.close()
  })
  async function world(limits: Partial<typeof LINK_PREVIEW_LIMITS> = {}) {
    Object.assign(LINK_PREVIEW_LIMITS, limits)
    api = await createTestApi({ env: { DRAFTROOM_LINK_PREVIEW_TEST_ORIGINS: origin } })
    alice = await api.login('alice')
    board = await createBoard(alice, DEV_STUDIO, 'Links')
  }
  const ask = (url: string) => alice.req('POST', `/api/boards/${board}/link-preview`, { url })

  /** Samples how long the event loop was held at a time while `during` ran. */
  async function lagDuring<T>(during: () => Promise<T>): Promise<{ value: T; maxLagMs: number }> {
    let last = performance.now()
    let max = 0
    const timer = setInterval(() => {
      const now = performance.now()
      max = Math.max(max, now - last - 10)
      last = now
    }, 10)
    try {
      return { value: await during(), maxLagMs: max }
    } finally {
      clearInterval(timer)
    }
  }

  it('a 512 KiB page of unclosed comments or meta tags answers, and the loop is never held for long', async () => {
    await world()
    for (const unit of ['<!--', '<meta ', '<script ', '<title>']) {
      handler = (_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(`<head>${unit.repeat(Math.ceil((512 * KIB) / unit.length))}`.slice(0, 512 * KIB))
      }
      const { value, maxLagMs } = await lagDuring(() => ask(`${origin}/page-${encodeURIComponent(unit)}`))
      expect(value.statusCode, value.body).toBe(200)
      expect(value.json()).toEqual({ title: null, siteName: null, icon: null })
      // the regex parser held the loop for 1 to 19 seconds on these
      expect(maxLagMs, unit).toBeLessThan(500)
    }
  })

  it('past the slots and the queue the answer is 503 LINK_PREVIEW_BUSY at once; the queued ones are served in turn', async () => {
    await world({ concurrent: 1, maxQueue: 1, queueWaitMs: 5_000, pageTimeoutMs: 500 })
    handler = (_req, res) => {
      open.push(res) // headers never come: the fetch runs into its time limit
    }
    const first = ask(`${origin}/a`)
    await vi.waitFor(() => expect(open.length).toBe(1))
    const second = ask(`${origin}/b`) // queued behind the first
    await new Promise((r) => setTimeout(r, 100))
    const t0 = performance.now()
    const third = await ask(`${origin}/c`) // no place, no room in the queue
    expect(third.statusCode, third.body).toBe(503)
    expect(third.json().error.code).toBe('LINK_PREVIEW_BUSY')
    expect(performance.now() - t0).toBeLessThan(250)
    // the first two time out (500 ms each) and answer like an unreachable page; nothing was lost
    for (const r of await Promise.all([first, second])) {
      expect(r.statusCode, r.body).toBe(200)
      expect(r.json()).toEqual({ title: null, siteName: null, icon: null })
    }
    // the refusal is not cached: once there is room the same link is fetched
    handler = (_req, res) =>
      res.writeHead(200, { 'content-type': 'text/html' }).end('<title>Now served</title>')
    const again = await ask(`${origin}/c`)
    expect(again.json()).toEqual({ title: 'Now served', siteName: null, icon: null })
  })

  it('a request that waits longer than the limit for a place is refused 503, not left hanging', async () => {
    await world({ concurrent: 1, maxQueue: 5, queueWaitMs: 150, pageTimeoutMs: 1_200 })
    handler = (_req, res) => {
      open.push(res)
    }
    const first = ask(`${origin}/a`)
    await vi.waitFor(() => expect(open.length).toBe(1))
    const t0 = performance.now()
    const second = await ask(`${origin}/b`)
    expect(second.statusCode, second.body).toBe(503)
    expect(second.json().error.code).toBe('LINK_PREVIEW_BUSY')
    expect(performance.now() - t0).toBeLessThan(1_000)
    expect((await first).statusCode).toBe(200)
  })
})
