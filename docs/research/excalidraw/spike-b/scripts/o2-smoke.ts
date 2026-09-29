// O2's end-to-end smoke of the spike board page before O1's room lands: the REAL api (dev auth, PGlite in
// a temp dir, fs blobs), O2's fake sync (./o2-fake-sync.ts: the protocol fake behind a WebSocket, real
// tickets), the spike web build served by vite preview, and two separate headless Chromium processes
// signed in as different dev users. It checks the page's wiring (ticket, socket, welcome, the engine core,
// the port's transact, the lease, Saved, the typing badge, convergence), NOT any spike B check.
//
//   node docs/research/excalidraw/spike-b/scripts/o2-smoke.ts [--no-build]
//
// Ports: 7870 (fake sync), 7871 (api), 7872 (web): O2's range. DRAFTROOM_BACKUP_STORE=off; no R2.
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../../..')
const HOST = '127.0.0.1'
const SYNC = 7870
const API = 7871
const WEB = 7872
const WEB_URL = `http://${HOST}:${WEB}`
const build = !process.argv.includes('--no-build')
const { chromium } = await import(pathToFileURL(join(ROOT, 'e2e/node_modules/@playwright/test/index.mjs')).href)

const children: ChildProcess[] = []
const kill = () => {
  for (const c of children) if (c.pid) spawnSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' })
}
process.on('exit', kill)
const dataDir = mkdtempSync(join(tmpdir(), 'dr-o2-smoke-'))
const secrets = {
  DRAFTROOM_TICKET_SECRET: randomBytes(32).toString('base64url'),
  DRAFTROOM_INTERNAL_SECRET: randomBytes(32).toString('base64url'),
}
const cleanEnv = () => {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const k of Object.keys(env)) if (/^(DRAFTROOM_|R2_|CLERK_|OPENAI_|VITE_)/.test(k)) delete env[k]
  return env
}

function start(name: string, cmd: string, args: string[], env: NodeJS.ProcessEnv, ready: RegExp): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args, { cwd: ROOT, env, shell: cmd !== process.execPath, windowsHide: true })
    children.push(c)
    let out = ''
    const on = (d: Buffer) => {
      out += d.toString()
      if (ready.test(out)) resolve()
    }
    c.stdout?.on('data', on)
    c.stderr?.on('data', on)
    c.on('exit', (code) => reject(new Error(`${name} exited ${code}\n${out.slice(-2000)}`)))
  })
}

const log = (...a: unknown[]) => console.log('[o2-smoke]', ...a)
try {
  await start(
    'api',
    process.execPath,
    ['apps/api/src/server.ts'],
    {
      ...cleanEnv(),
      ...secrets,
      PORT: String(API),
      HOST,
      DRAFTROOM_DATA_DIR: dataDir,
      DRAFTROOM_DEV_AUTH: '1',
      AUTH_PROVIDER: 'dev',
      PUBLIC_ORIGIN: WEB_URL,
      DRAFTROOM_SYNC_INTERNAL_URL: `http://${HOST}:${SYNC}`,
      DRAFTROOM_WORKER_TOKEN: randomBytes(16).toString('hex'),
      DRAFTROOM_BLOB_STORE: 'fs',
      DRAFTROOM_BACKUP_STORE: 'off',
    },
    /api listening on/,
  )
  log('api up')
  await start(
    'fake-sync',
    process.execPath,
    ['docs/research/excalidraw/spike-b/scripts/o2-fake-sync.ts', String(SYNC)],
    { ...cleanEnv(), ...secrets },
    /fake sync listening/,
  )
  log('fake sync up')
  const webEnv = {
    ...cleanEnv(),
    VITE_LOBBY_ENGINE: 'excalidraw',
    VITE_DRAFTROOM_DEV_AUTH: '1',
    DRAFTROOM_API_ORIGIN: `http://${HOST}:${API}`,
    DRAFTROOM_SYNC_ORIGIN: `http://${HOST}:${SYNC}`,
  }
  if (build) {
    const b = spawnSync('pnpm', ['--filter', '@draftroom/web', 'exec', 'vite', 'build', '--outDir', `dist/spike-b-${WEB}`], {
      cwd: ROOT,
      env: webEnv,
      shell: true,
      encoding: 'utf8',
    })
    if (b.status !== 0) throw new Error(`web build failed\n${(b.stdout ?? '').slice(-3000)}${(b.stderr ?? '').slice(-3000)}`)
    log('web built')
  }
  await start(
    'web',
    'pnpm',
    ['--filter', '@draftroom/web', 'exec', 'vite', 'preview', '--outDir', `dist/spike-b-${WEB}`, '--port', String(WEB), '--strictPort'],
    webEnv,
    new RegExp(`${WEB}`),
  )
  log('web up')

  const people = [
    { handle: 'alice', name: 'Alice Park' },
    { handle: 'bob', name: 'Bob Chen' },
  ]
  const browsers = await Promise.all(people.map(() => chromium.launch()))
  const ctx = await Promise.all(browsers.map((b: { newContext(o: unknown): Promise<unknown> }) => b.newContext({ baseURL: WEB_URL })))
  // biome-ignore lint/suspicious/noExplicitAny: Playwright's objects through a dynamic import
  const ctxs = ctx as any[]
  const me = []
  for (let i = 0; i < people.length; i++) {
    const r = await ctxs[i].request.post(`${WEB_URL}/api/auth/dev/login`, { headers: { origin: WEB_URL }, data: people[i] })
    if (r.status() !== 200) throw new Error(`login ${r.status()} ${await r.text()}`)
    me.push(await r.json())
  }
  const ws = (me[0].workspaces.find((w: { name: string }) => w.name === 'Dev Studio') ?? me[0].workspaces[0]).id
  const created = await ctxs[0].request.post(`${WEB_URL}/api/workspaces/${ws}/boards`, {
    headers: { origin: WEB_URL },
    data: { title: 'o2 smoke' },
  })
  const board = (await created.json()).id as string
  const share = await ctxs[0].request.put(`${WEB_URL}/api/boards/${board}/members/${me[1].user.id}`, {
    headers: { origin: WEB_URL },
    data: { role: 'editor' },
  })
  if (share.status() >= 300) throw new Error(`share ${share.status()} ${await share.text()}`)
  log('board', board)
  const pages = await Promise.all(ctxs.map((c) => c.newPage()))
  for (const p of pages) {
    p.on('console', (m: { type(): string; text(): string }) => {
      if (m.type() === 'error' || m.type() === 'warning') console.log('[page]', m.type(), m.text().slice(0, 300))
    })
    await p.addInitScript(() => {
      ;(window as unknown as { __lobbyBoardLog: unknown[] }).__lobbyBoardLog = []
    })
    p.on('pageerror', (e: Error) => console.log('[pageerror]', String(e).slice(0, 500)))
    await p.goto(`/b/${board}`)
    try {
      await p.waitForSelector('[data-testid="spike-board"][data-phase="ready"]', { timeout: 30_000 })
    } catch (e) {
      const diag = await p.evaluate(() => {
        const w = window as unknown as {
          __lobbyBoard?: { core: { saveStatus: unknown; welcome: unknown }; session: { transport: { state: string; attempts: number } } }
          __lobbyBoardLog?: unknown[]
        }
        return {
          testids: [...document.querySelectorAll('[data-testid]')].map((x) => `${x.getAttribute('data-testid')}:${x.getAttribute('data-phase') ?? ''}`).slice(0, 20),
          board: !!w.__lobbyBoard,
          transport: w.__lobbyBoard?.session.transport.state,
          attempts: w.__lobbyBoard?.session.transport.attempts,
          save: w.__lobbyBoard?.core.saveStatus,
          welcome: !!w.__lobbyBoard?.core.welcome,
          log: (w.__lobbyBoardLog ?? []).slice(-15),
        }
      })
      console.log('[diag]', JSON.stringify(diag, null, 1))
      throw e
    }
  }
  log('both pages ready')
  const [A, B] = pages
  const id = await A.evaluate(() => {
    const b = (window as unknown as { __lobbyBoard: { port: { transact(l: string, f: (tx: { create(k: string, p: object): string }) => string): string } } }).__lobbyBoard
    return b.port.transact('smoke', (tx) => tx.create('rectangle', { x: 100, y: 100, width: 120, height: 80 }))
  })
  await B.waitForFunction((rid: string) => {
    const b = (window as unknown as { __lobbyBoard: { core: { elements(): Map<string, unknown> } } }).__lobbyBoard
    return b.core.elements().has(rid)
  }, id)
  await A.waitForSelector('[data-testid="save-state"][data-state="saved"]')
  log('rectangle created on A, seen on B, A saved')
  // a note through the port, then A types in it through the lease (Enter = P1)
  const noteId = await A.evaluate(() => {
    const b = (window as unknown as { __lobbyBoard: { port: { transact(l: string, f: (tx: { create(k: string, p: object): string }) => string): string; select(ids: string[]): void } } }).__lobbyBoard
    const nid = b.port.transact('note', (tx) => tx.create('note', { x: 300, y: 100, text: 'memo' }))
    b.port.select([nid])
    return nid
  })
  await A.waitForTimeout(300)
  await A.locator('.excalidraw').first().focus()
  await A.keyboard.press('Enter')
  await A.waitForFunction(() => {
    const b = (window as unknown as { __lobbyBoard: { input: { editorLease: { phase: string } } } }).__lobbyBoard
    return b.input.editorLease.phase === 'open'
  })
  await A.keyboard.type(' by alice')
  await B.waitForSelector(`[data-testid="typing-badge"][data-lease="${noteId}"]`, { timeout: 5000 })
  log('B shows the typing badge')
  await A.keyboard.press('Escape')
  await A.waitForSelector('[data-testid="save-state"][data-state="saved"]')
  await B.waitForFunction((nid: string) => {
    const b = (window as unknown as { __lobbyBoard: { core: { elements(): Map<string, { containerId?: string; originalText?: string }> } } }).__lobbyBoard
    return [...b.core.elements().values()].some((e) => e.containerId === nid && e.originalText === 'memo by alice')
  }, noteId)
  log("B has A's text")
  const hashOf = (p: typeof A) =>
    p.evaluate(async () => {
      const b = (window as unknown as { __lobbyBoard: { core: { elements(): Map<string, Record<string, unknown>> } } }).__lobbyBoard
      const els = [...b.core.elements().values()].sort((x, y) => (String(x.id) < String(y.id) ? -1 : 1))
      return JSON.stringify(els.map((e) => [e.id, e.version, e.versionNonce, e.isDeleted]))
    })
  await B.waitForSelector('[data-testid="save-state"][data-state="saved"]')
  const [ha, hb] = [await hashOf(A), await hashOf(B)]
  const pushedB = await B.evaluate(() => (window as unknown as { __lobbyBoard: { core: { pushLog(): unknown[] } } }).__lobbyBoard.core.pushLog().length)
  log('maps equal:', ha === hb, 'B pushes:', pushedB)
  if (ha !== hb) throw new Error(`maps differ\nA ${ha}\nB ${hb}`)
  if (pushedB !== 0) throw new Error(`B (receiving only) pushed ${pushedB}`)
  for (const b of browsers) await b.close()
  log('SMOKE OK')
} finally {
  kill()
  rmSync(dataDir, { recursive: true, force: true })
}
