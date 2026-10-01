// A rehearsal-local copy of scripts/smoke/live-smoke.mjs (origin/engine/smoke): two switches the self-signed
// LAN edge needs, both off by default. LOBBY_SMOKE_REPO_ROOT names the checkout whose e2e/ holds Playwright;
// LOBBY_SMOKE_INSECURE_TLS=1 accepts the edge's self-signed certificate in Chromium and on the raw socket
// (Node's fetch takes NODE_TLS_REJECT_UNAUTHORIZED=0 or NODE_EXTRA_CA_CERTS). Nothing else changes.
const fs = require('node:fs')
let s = fs.readFileSync('live-smoke.mjs', 'utf8')
const n0 = s.length
const rep = (from, to) => {
  if (!s.includes(from)) throw new Error('anchor not found: ' + from.slice(0, 60))
  s = s.replace(from, to)
}
rep(
  "const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))",
  "const REPO_ROOT = process.env.LOBBY_SMOKE_REPO_ROOT ?? fileURLToPath(new URL('../..', import.meta.url))\nconst INSECURE_TLS = process.env.LOBBY_SMOKE_INSECURE_TLS === '1'",
)
rep(
  'const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })',
  'const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: INSECURE_TLS })',
)
rep(
  '? tlsConnect({ host: u.hostname, port, servername: u.hostname }, onConnect)',
  '? tlsConnect({ host: u.hostname, port, servername: u.hostname, rejectUnauthorized: !INSECURE_TLS }, onConnect)',
)
fs.writeFileSync('live-smoke.rehearsal.mjs', s)
console.log('live-smoke.rehearsal.mjs written', n0, '->', s.length)
