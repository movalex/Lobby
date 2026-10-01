// Dev-mode check of the excalidraw-assets plugin: spawns `vite` (dev) on 7742, drives /spike/engine headless,
// then kills the server. Run from anywhere: node dev-check.mjs <repo>
import { spawn } from 'node:child_process'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const repo = process.argv[2]
const { chromium } = await import(pathToFileURL(path.join(repo, 'e2e/node_modules/@playwright/test/index.mjs')).href)
const web = path.join(repo, 'apps/web')
const srv = spawn(process.execPath, [path.join(web, 'node_modules/vite/bin/vite.js')], {
  cwd: web,
  env: { ...process.env, WEB_PORT: '7742', VITE_LOBBY_ENGINE: 'excalidraw', DRAFTROOM_API_ORIGIN: 'http://127.0.0.1:7748', DRAFTROOM_SYNC_ORIGIN: 'http://127.0.0.1:7749' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let log = ''
srv.stdout.on('data', (d) => (log += d))
srv.stderr.on('data', (d) => (log += d))
const base = 'http://127.0.0.1:7742'
try {
  for (let i = 0; i < 60 && !log.includes('ready in'); i++) await new Promise((r) => setTimeout(r, 250))
  const lib = await fetch(`${base}/excalidraw-assets/fonts/Liberation/LiberationSans-Regular.woff2`)
  const bad = await fetch(`${base}/excalidraw-assets/fonts/%E0%A4%A`)
  console.log('liberation', lib.status, lib.headers.get('content-type'), '| malformed', bad.status)
  const b = await chromium.launch()
  const p = await b.newPage()
  // Never let a request leave the machine: foreign requests are aborted (the request event still fires).
  await p.route((u) => !/^(127.0.0.1|localhost)$/.test(u.hostname), (r) => r.abort('blockedbyclient'))
  const reqs = []
  const errs = []
  p.on('request', (r) => reqs.push(r.url()))
  p.on('console', (m) => m.type() === 'error' && errs.push(m.text().slice(0, 300)))
  p.on('pageerror', (e) => errs.push(String(e).slice(0, 300)))
  await p.goto(`${base}/spike/engine?role=editor`)
  await p.waitForFunction(() => window.__lobbySpike, undefined, { timeout: 60000 })
  await p.evaluate(() => window.__lobbySpike.ready)
  await p.evaluate(() => {
    const { api, lib } = window.__lobbySpike
    api.updateScene({ elements: lib.convertToExcalidrawElements([{ type: 'stickynote', id: 'n1', x: 100, y: 100, width: 250, height: 250, label: { text: 'Dev mode', fontFamily: 6 } }], { regenerateIds: false }), captureUpdate: lib.CaptureUpdateAction.NEVER })
  })
  await p.waitForTimeout(1500)
  const fonts = () => reqs.filter((u) => u.includes('.woff2')).map((u) => { const x = new URL(u); return x.host + x.pathname.replace(/-[A-Za-z0-9_-]{20,}\.woff2$/, '-*.woff2') })
  console.log('dev fonts (Nunito note):', JSON.stringify(fonts()))
  console.log('dev foreign:', JSON.stringify(reqs.filter((u) => !/^(data:|blob:|http:\/\/127\.0\.0\.1:7742\/)/.test(u))))
  console.log('dev console errors:', JSON.stringify(errs))
  // Engine fact for A12: a text element with fontFamily 9 (Liberation Sans, not self-hosted).
  reqs.length = 0
  errs.length = 0
  await p.evaluate(() => {
    const { api, lib } = window.__lobbySpike
    const [t] = lib.convertToExcalidrawElements([{ type: 'text', id: 't9', x: 500, y: 100, text: 'Liberation', fontFamily: 9 }], { regenerateIds: false })
    api.updateScene({ elements: [...api.getSceneElementsIncludingDeleted(), t], captureUpdate: lib.CaptureUpdateAction.NEVER })
  })
  await p.waitForTimeout(3000)
  console.log('fontFamily 9 requests:', JSON.stringify(reqs.filter((u) => !u.startsWith('data:')).map((u) => { const x = new URL(u); return x.host + x.pathname })))
  console.log('fontFamily 9 console errors:', JSON.stringify(errs))
  await b.close()
} finally {
  srv.kill()
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(srv.pid), '/T', '/F'], { stdio: 'ignore' })
}
