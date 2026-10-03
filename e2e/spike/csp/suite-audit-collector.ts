// The whole-suite CSP audit's report collector (suite-audit.config.ts): a tiny HTTP server for the
// policy's `report-uri`. Every POST to /csp-report (application/csp-report from report-uri, or
// application/reports+json from the Reporting API) is appended as one JSON line to the output file:
// { t, iso, contentType, report }, the report as the browser sent it. GET /healthz answers 200 (the
// Playwright webServer probe), GET /count the number of reports so far. Nothing is logged to stdout but
// the start line: reports carry board URLs (ids only) and script samples.
//
//   node e2e/spike/csp/suite-audit-collector.ts --port 6535 --out <file.jsonl>
import { appendFileSync, mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const { values: args } = parseArgs({
  options: {
    port: { type: 'string', default: process.env.CSP_AUDIT_COLLECTOR_PORT ?? '6535' },
    host: { type: 'string', default: '127.0.0.1' },
    out: { type: 'string', default: process.env.CSP_AUDIT_REPORTS ?? 'csp-audit-reports.jsonl' },
  },
})
const out = resolve(args.out)
mkdirSync(dirname(out), { recursive: true })
const MAX_BODY = 256 * 1024
let count = 0

const server = createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0]
  if (req.method === 'GET' && path === '/healthz') return void res.writeHead(200).end('ok')
  if (req.method === 'GET' && path === '/count') return void res.writeHead(200).end(String(count))
  if (req.method !== 'POST' || path !== '/csp-report') return void res.writeHead(404).end()
  const chunks: Buffer[] = []
  let size = 0
  req.on('data', (d: Buffer) => {
    size += d.length
    if (size <= MAX_BODY) chunks.push(d)
  })
  req.on('end', () => {
    const t = Date.now()
    const text = Buffer.concat(chunks).toString('utf8')
    let body: unknown = text
    try {
      body = JSON.parse(text)
    } catch {}
    // The Reporting API batches several reports into one array; report-uri sends one object.
    for (const report of Array.isArray(body) ? body : [body]) {
      count++
      const line = {
        t,
        iso: new Date(t).toISOString(),
        contentType: req.headers['content-type'] ?? '',
        report,
      }
      appendFileSync(out, `${JSON.stringify(line)}\n`)
    }
    res.writeHead(204).end()
  })
})
server.listen(Number(args.port), args.host, () => {
  console.log(`csp-audit collector listening on ${args.host}:${args.port}, writing ${out}`)
})
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => server.close(() => process.exit(0)))
