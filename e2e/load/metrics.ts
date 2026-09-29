// Scrapes sync's `GET /internal/metrics` (Prometheus text, §2.4.6; O1's room serves it behind the internal
// secret) every window of a run and keeps every sample, so the report can show the server's own numbers
// (commit ms, pushes per commit, fsync ms, event-loop delay, outbound bytes and closes, presence in/out,
// re-snaps, …) next to the clients' view. Names are O1's; nothing here assumes one, the report maps the
// ones it knows (report.ts SERVER_METRICS) and keeps the rest raw.

export interface MetricSample {
  readonly name: string
  readonly labels: Readonly<Record<string, string>>
  readonly value: number
}

/** Parses Prometheus text exposition (comments and TYPE/HELP lines skipped; NaN/Inf kept as numbers). */
export function parsePrometheus(text: string): MetricSample[] {
  const out: MetricSample[] = []
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^([A-Za-z_:][A-Za-z0-9_:]*)(\{([^}]*)\})?\s+(\S+)(\s+\d+)?$/.exec(line)
    if (!m) continue
    const labels: Record<string, string> = {}
    if (m[3]) {
      for (const pair of m[3].matchAll(/([A-Za-z_][A-Za-z0-9_]*)="((?:[^"\\]|\\.)*)"/g))
        labels[pair[1] as string] = (pair[2] as string).replace(/\\(.)/g, '$1')
    }
    const v = m[4] as string
    const value =
      v === '+Inf' ? Number.POSITIVE_INFINITY : v === '-Inf' ? Number.NEGATIVE_INFINITY : Number(v)
    if (Number.isNaN(value) && v !== 'NaN') continue
    out.push({ name: m[1] as string, labels, value })
  }
  return out
}

export interface Scrape {
  readonly at: number
  readonly ok: boolean
  readonly status: number | null
  readonly samples: MetricSample[]
}

export async function scrapeMetrics(syncHttpUrl: string, internalSecret: string): Promise<Scrape> {
  const at = Date.now()
  try {
    const res = await fetch(`${syncHttpUrl}/internal/metrics`, {
      headers: { 'x-draftroom-internal': internalSecret },
      signal: AbortSignal.timeout(5_000),
    })
    if (res.status !== 200) {
      await res.body?.cancel()
      return { at, ok: false, status: res.status, samples: [] }
    }
    return { at, ok: true, status: 200, samples: parsePrometheus(await res.text()) }
  } catch {
    return { at, ok: false, status: null, samples: [] }
  }
}

/** Scrapes every `everyMs` until stopped; returns every scrape. */
export function startScraper(syncHttpUrl: string, internalSecret: string, everyMs: number) {
  const scrapes: Scrape[] = []
  let timer: ReturnType<typeof setInterval> | null = null
  if (everyMs > 0) {
    const tick = () => void scrapeMetrics(syncHttpUrl, internalSecret).then((s) => scrapes.push(s))
    tick()
    timer = setInterval(tick, everyMs)
  }
  return {
    scrapes,
    stop: async () => {
      if (timer) clearInterval(timer)
      scrapes.push(await scrapeMetrics(syncHttpUrl, internalSecret))
      return scrapes
    },
  }
}

/** One series (name + exact labels) over the scrapes: [ms since t0, value]. */
export function series(
  scrapes: readonly Scrape[],
  name: string,
  t0: number,
  labels: Record<string, string> = {},
) {
  const out: [number, number][] = []
  for (const s of scrapes) {
    const hit = s.samples.find(
      (m) => m.name === name && Object.entries(labels).every(([k, v]) => m.labels[k] === v),
    )
    if (hit) out.push([s.at - t0, hit.value])
  }
  return out
}
