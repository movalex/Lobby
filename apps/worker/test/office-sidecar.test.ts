// The office sidecar (office-server.ts / office-sidecar.ts) and the worker's socket client
// (office-client.ts): the production topology, where LibreOffice runs in its own container with no
// network and no secrets. Here both ends run on the dev PC (a Windows named pipe or a Unix socket) with
// the soffice stand-in; the container settings themselves are checked on the NAS.
import { type ChildProcess, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OFFICE_FORMATS } from '@draftroom/dev-assets'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { loadOfficeEnv, loadWorkerEnv } from '../src/env.ts'
import { socketOfficeConverter } from '../src/office-client.ts'
import { OFFICE_PROTOCOL_VERSION, type OfficeResponse, readLine } from '../src/office-protocol.ts'
import { type OfficeServer, startOfficeServer, sweepOfficePipes } from '../src/office-server.ts'
import { loadOfficeSidecarEnv, sofficeVersion } from '../src/office-sidecar.ts'
import { type FakeApi, startFakeApi } from './fake-api.ts'
import { ensureFixtures, fixturePath } from './helpers.ts'
import { cleanupRoots, runWorker, tmpRoot, waitFor } from './remote-helpers.ts'

const FAKE_SOFFICE = fileURLToPath(new URL('./children/fake-soffice.ts', import.meta.url))
const SIDECAR = fileURLToPath(new URL('../src/office-sidecar.ts', import.meta.url))
const WORKER = fileURLToPath(new URL('../src/worker.ts', import.meta.url))
const DOCX = OFFICE_FORMATS.find((f) => f.ext === 'docx')
if (!DOCX) throw new Error('docx format missing')

const socketPath = (dir: string) =>
  process.platform === 'win32'
    ? `\\\\.\\pipe\\drw-office-${randomBytes(6).toString('hex')}`
    : join(dir, 'office.sock')

const dirs: string[] = []
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'drw-sc-'))
  dirs.push(d)
  return d
}
const servers: OfficeServer[] = []
const children: ChildProcess[] = []

async function sidecar(mode?: string, maxQueue = 4) {
  const jobsDir = temp()
  const logs: string[] = []
  const cfg = {
    socketPath: socketPath(temp()),
    jobsDir,
    workDir: temp(),
    command: [process.execPath, FAKE_SOFFICE, ...(mode ? [`--fake-mode=${mode}`] : [])],
    maxTimeoutMs: 60_000,
    maxQueue,
    log: (s: string) => logs.push(s),
  }
  const server = await startOfficeServer(cfg)
  servers.push(server)
  return { server, cfg, logs, client: socketOfficeConverter({ socketPath: cfg.socketPath, jobsDir }) }
}

/** One raw request line → the sidecar's answer. */
function raw(path: string, body: unknown): Promise<OfficeResponse> {
  return new Promise((resolve, reject) => {
    const s = connect(path, () => {
      s.write(`${JSON.stringify(body)}\n`)
      readLine(s).then((l) => {
        s.destroy()
        resolve(JSON.parse(l) as OfficeResponse)
      }, reject)
    })
    s.on('error', reject)
  })
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

beforeAll(async () => {
  await ensureFixtures()
})
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL')
})
afterAll(() => {
  cleanupRoots()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5 })
})

describe('sidecar and client', () => {
  it('converts through the shared directory and leaves nothing behind', async () => {
    const { client, cfg, logs } = await sidecar()
    const out = temp()
    const pdf = await client.convert(fixturePath('document.docx'), DOCX, out, { timeoutMs: 30_000 })
    expect(pdf).toBe(join(out, 'converted.pdf'))
    expect(readFileSync(pdf).subarray(0, 5).toString()).toBe('%PDF-')
    expect(readdirSync(cfg.jobsDir)).toEqual([]) // the staging directory is removed
    expect(readdirSync(cfg.workDir)).toEqual([]) // and the sidecar's profile scratch
    expect(logs.some((l) => /^\[office\] docx converted in \d+ ms$/.test(l))).toBe(true)
  })

  it('refuses requests that name anything outside its jobs directory, or anything but document.<ext>', async () => {
    const { cfg } = await sidecar()
    const stage = join(cfg.jobsDir, 'job-x')
    mkdirSync(join(stage, 'out'), { recursive: true })
    writeFileSync(join(stage, 'document.docx'), readFileSync(fixturePath('document.docx')))
    writeFileSync(join(stage, 'notes.docx'), 'x')
    const outside = temp()
    writeFileSync(join(outside, 'document.docx'), readFileSync(fixturePath('document.docx')))
    const ok = {
      v: OFFICE_PROTOCOL_VERSION,
      input: join(stage, 'document.docx'),
      outDir: join(stage, 'out'),
      ext: 'docx',
      timeoutMs: 20_000,
    }
    for (const bad of [
      { ...ok, input: join(outside, 'document.docx') },
      { ...ok, outDir: outside },
      { ...ok, input: join(stage, '..', '..', 'etc', 'passwd') },
      { ...ok, input: join(stage, 'notes.docx') },
      { ...ok, ext: 'docm' },
      { ...ok, v: 2 },
      { ...ok, input: 'document.docx' },
    ]) {
      expect(await raw(cfg.socketPath, bad), JSON.stringify(bad)).toMatchObject({
        ok: false,
        code: 'BAD_REQUEST',
      })
    }
    expect(await raw(cfg.socketPath, ok)).toMatchObject({ ok: true, pdf: join(stage, 'out', 'document.pdf') })
  })

  it.skipIf(process.platform === 'win32')(
    'refuses a symlinked input (a link out of the shared volume)',
    async () => {
      const { cfg } = await sidecar()
      const { symlinkSync } = await import('node:fs')
      const stage = join(cfg.jobsDir, 'job-link')
      mkdirSync(join(stage, 'out'), { recursive: true })
      const outside = temp()
      writeFileSync(join(outside, 'secret.docx'), readFileSync(fixturePath('document.docx')))
      symlinkSync(join(outside, 'secret.docx'), join(stage, 'document.docx'))
      expect(
        await raw(cfg.socketPath, {
          v: 1,
          input: join(stage, 'document.docx'),
          outDir: join(stage, 'out'),
          ext: 'docx',
          timeoutMs: 20_000,
        }),
      ).toMatchObject({ ok: false, code: 'BAD_REQUEST' })
    },
  )

  it('a conversion over its timeout answers TIMEOUT and kills soffice with its helpers', async () => {
    const { client, cfg } = await sidecar('hang')
    const t0 = Date.now()
    await expect(
      client.convert(fixturePath('document.docx'), DOCX, temp(), { timeoutMs: 1_500 }),
    ).rejects.toMatchObject({
      code: 'TIMEOUT',
    })
    expect(Date.now() - t0).toBeLessThan(10_000)
    expect(readdirSync(cfg.jobsDir)).toEqual([])
  })

  it('a worker that gives up (abort, lost lease, shutdown) cancels the conversion in the sidecar', async () => {
    const { client, logs, cfg } = await sidecar('hang')
    const ctl = new AbortController()
    const p = client.convert(fixturePath('document.docx'), DOCX, temp(), {
      timeoutMs: 30_000,
      signal: ctl.signal,
    })
    // The stand-in records its pids in the staging dir's out/ before it hangs.
    let pids: { soffice: number; helper: number } | null = null
    await waitFor(
      () => {
        for (const d of readdirSync(cfg.jobsDir)) {
          try {
            pids = JSON.parse(readFileSync(join(cfg.jobsDir, d, 'out', 'fake-pids.json'), 'utf8'))
          } catch {}
        }
        return pids !== null
      },
      10_000,
      'soffice started',
    )
    ctl.abort('lease lost')
    await expect(p).rejects.toMatchObject({ name: 'AbortedError' })
    await waitFor(() => logs.some((l) => l.includes('cancelled')), 10_000, 'sidecar cancelled')
    const got = pids as unknown as { soffice: number; helper: number }
    await waitFor(() => !alive(got.soffice) && !alive(got.helper), 5_000, 'soffice tree killed')
  })

  it('answers BUSY beyond its queue, which the worker treats as transient (retried later)', async () => {
    const { client } = await sidecar('hang', 0)
    const ctl = new AbortController()
    const first = client.convert(fixturePath('document.docx'), DOCX, temp(), {
      timeoutMs: 30_000,
      signal: ctl.signal,
    })
    first.catch(() => {})
    await new Promise((r) => setTimeout(r, 300))
    await expect(
      client.convert(fixturePath('document.docx'), DOCX, temp(), { timeoutMs: 30_000 }),
    ).rejects.toMatchObject({
      name: 'TransientError',
    })
    ctl.abort()
  })

  it('a sidecar that is not running is transient trouble, not the document’s fault', async () => {
    const jobsDir = temp()
    const client = socketOfficeConverter({ socketPath: socketPath(temp()), jobsDir })
    await expect(
      client.convert(fixturePath('document.docx'), DOCX, temp(), { timeoutMs: 5_000 }),
    ).rejects.toMatchObject({
      name: 'TransientError',
    })
    expect(readdirSync(jobsDir)).toEqual([])
  })

  it('passes the converter’s verdict on unchanged (a document LibreOffice cannot load)', async () => {
    const { client } = await sidecar('noop')
    await expect(
      client.convert(fixturePath('document.docx'), DOCX, temp(), { timeoutMs: 10_000 }),
    ).rejects.toMatchObject({
      code: 'OFFICE_INVALID',
    })
  })
})

describe('configuration', () => {
  const base = { OFFICE_SOCKET: '/office-jobs/office.sock', OFFICE_JOBS_DIR: '/office-jobs' }

  it('the sidecar refuses to hold any secret, a script stand-in in production, or a network', () => {
    expect(() => loadOfficeSidecarEnv({ ...base, DRAFTROOM_WORKER_TOKEN: 'x'.repeat(40) }, () => [])).toThrow(
      /no secrets: remove DRAFTROOM_WORKER_TOKEN/,
    )
    expect(() =>
      loadOfficeSidecarEnv({ ...base, NODE_ENV: 'production', SOFFICE_PATH: '/x/fake-soffice.ts' }, () => []),
    ).toThrow(/not a script stand-in/)
    expect(() => loadOfficeSidecarEnv({ ...base, NODE_ENV: 'production' }, () => ['eth0'])).toThrow(
      /without network .* found eth0/,
    )
    expect(() => loadOfficeSidecarEnv({ OFFICE_JOBS_DIR: '/j' }, () => [])).toThrow(
      /OFFICE_SOCKET is required/,
    )
    expect(loadOfficeSidecarEnv({ ...base, NODE_ENV: 'production' }, () => [])).toMatchObject({
      production: true,
      command: ['soffice'],
      maxQueue: 4,
      pipeDir: process.platform === 'win32' ? null : '/tmp',
    })
    expect(loadOfficeSidecarEnv(base, () => ['eth0']).pipeDir).toBeNull() // development: /tmp is shared
  })

  it('removes the IPC sockets a killed LibreOffice leaves behind, and nothing else', async () => {
    const dir = temp()
    writeFileSync(join(dir, 'OSL_PIPE_1000_SingleOfficeIPC_not-a-socket'), 'x')
    writeFileSync(join(dir, 'unrelated.txt'), 'x')
    expect(await sweepOfficePipes(dir)).toBe(0)
    expect(readdirSync(dir).sort()).toEqual(['OSL_PIPE_1000_SingleOfficeIPC_not-a-socket', 'unrelated.txt'])
    expect(await sweepOfficePipes(join(dir, 'missing'))).toBe(0)
  })

  it.skipIf(process.platform === 'win32')(
    'sweeps a stale LibreOffice socket after each conversion',
    async () => {
      const pipeDir = temp()
      const name = 'OSL_PIPE_1000_SingleOfficeIPC_e752937e36871dfb0c5c92411c75f98'
      // A listener killed with SIGKILL never unlinks its socket file: exactly what a killed soffice leaves.
      const holder = spawn(
        process.execPath,
        [
          '-e',
          "require('net').createServer().listen(process.argv[1], () => console.log('up'))",
          join(pipeDir, name),
        ],
        { stdio: ['ignore', 'pipe', 'ignore'] },
      )
      children.push(holder)
      await new Promise<void>((r) => holder.stdout?.once('data', () => r()))
      holder.kill('SIGKILL')
      await new Promise((r) => holder.once('exit', r))
      expect(readdirSync(pipeDir)).toEqual([name])
      writeFileSync(join(pipeDir, 'keep.txt'), 'x')
      const jobsDir = temp()
      const socket = join(temp(), 'office.sock')
      servers.push(
        await startOfficeServer({
          socketPath: socket,
          jobsDir,
          workDir: temp(),
          command: [process.execPath, FAKE_SOFFICE],
          maxTimeoutMs: 30_000,
          maxQueue: 1,
          pipeDir,
          log: () => {},
        }),
      )
      const client = socketOfficeConverter({ socketPath: socket, jobsDir })
      await client.convert(fixturePath('document.docx'), DOCX, temp(), { timeoutMs: 20_000 })
      await waitFor(() => !readdirSync(pipeDir).includes(name), 5_000, 'swept')
      expect(readdirSync(pipeDir)).toEqual(['keep.txt'])
    },
  )

  it('the worker: sidecar in production, local LibreOffice only in development, off otherwise', () => {
    expect(loadOfficeEnv(base, true)).toMatchObject({
      mode: 'socket',
      socketPath: '/office-jobs/office.sock',
    })
    expect(loadOfficeEnv({}, true)).toMatchObject({ mode: 'off' })
    expect(loadOfficeEnv({}, false)).toMatchObject({ mode: 'local', sofficePath: undefined })
    expect(() => loadOfficeEnv({ WORKER_OFFICE: 'local' }, true)).toThrow(/for development/)
    expect(() => loadOfficeEnv({ WORKER_OFFICE: 'socket' }, false)).toThrow(/OFFICE_SOCKET/)
    expect(() => loadOfficeEnv({ WORKER_OFFICE: 'socket', OFFICE_SOCKET: '/s' }, false)).toThrow(
      /OFFICE_JOBS_DIR/,
    )
    expect(() => loadOfficeEnv({ WORKER_OFFICE: 'yes' }, false)).toThrow(/off, local or socket/)
    expect(loadOfficeEnv({ WORKER_OFFICE_TIMEOUT_MS: '45000' }, false).timeoutMs).toBe(45_000)
    const w = loadWorkerEnv({
      NODE_ENV: 'production',
      DRAFTROOM_API_URL: 'https://api.example.com',
      DRAFTROOM_WORKER_TOKEN: 'k'.repeat(40),
      ...base,
    })
    expect(w.office).toMatchObject({ mode: 'socket', jobsDir: resolvePath('/office-jobs') })
  })

  it('reads the LibreOffice version line (and null when it does not start)', async () => {
    expect(await sofficeVersion([process.execPath, FAKE_SOFFICE], temp())).toBe(
      'LibreOffice 0.0.0.0 fake-soffice (test stand-in)',
    )
    expect(await sofficeVersion([join(temp(), 'nope')], temp())).toBeNull()
  })
})

describe('the remote worker with the sidecar', () => {
  let fake: FakeApi | null = null
  afterEach(async () => {
    await fake?.close()
    fake = null
  })

  it('a DOCX claimed from the api is converted by the sidecar and completes with its pages and its real type', async () => {
    const f = await startFakeApi()
    fake = f
    const { client, cfg } = await sidecar()
    const w = runWorker(f, { process: { office: client } })
    const job = f.add({ fixture: 'document.docx', name: 'Q3 plan.docx', declaredMimeType: '' })
    expect(job.kind).toBe('pdf')
    await waitFor(() => job.status === 'done', 60_000, 'office job done')
    await w.handle.stop(1_000)
    expect(job.result).toMatchObject({ status: 'ready', mimeType: DOCX.mime })
    expect(job.result?.probe.pageCount).toBe(3)
    const roles = job.derivatives.map((d) => `${d.role}${d.page ?? ''}`).sort()
    expect(roles).toEqual(['page1', 'page2', 'page3', 'thumb1'])
    expect(readdirSync(cfg.jobsDir)).toEqual([])
    expect(readdirSync(w.tmpDir)).toEqual([])
    expect(w.logs.join('\n')).not.toContain('Q3 plan')
  })
})

describe('the two processes, as deployed (worker.ts + office-sidecar.ts)', () => {
  let fake: FakeApi | null = null
  afterEach(async () => {
    await fake?.close()
    fake = null
  })

  function start(entry: string, env: Record<string, string>) {
    const clean: NodeJS.ProcessEnv = { ...process.env }
    for (const k of Object.keys(clean)) {
      if (/^(DRAFTROOM_|WORKER_|R2_|OFFICE_|SOFFICE_)/.test(k) || ['NODE_ENV', 'NODE_OPTIONS'].includes(k))
        delete clean[k]
    }
    const c = spawn(process.execPath, [entry], {
      env: { ...clean, ...env },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    })
    children.push(c)
    const out = { text: '' }
    c.stdout?.on('data', (b) => {
      out.text += String(b)
    })
    c.stderr?.on('data', (b) => {
      out.text += String(b)
    })
    const exited = new Promise<number | null>((r) => c.on('exit', (code) => r(code)))
    return { c, out, exited }
  }

  it('the worker hands an ODP to the sidecar over OFFICE_SOCKET; both stop cleanly and leave no files', async () => {
    const f = await startFakeApi()
    fake = f
    const jobsDir = tmpRoot()
    const sock = socketPath(temp())
    const sc = start(SIDECAR, { OFFICE_SOCKET: sock, OFFICE_JOBS_DIR: jobsDir, SOFFICE_PATH: FAKE_SOFFICE })
    await waitFor(() => sc.out.text.includes('[office] listening'), 15_000, 'sidecar listening')
    expect(sc.out.text).toContain('[office] LibreOffice 0.0.0.0 fake-soffice (test stand-in)')
    const tmp = tmpRoot()
    const w = start(WORKER, {
      DRAFTROOM_API_URL: f.api,
      DRAFTROOM_WORKER_TOKEN: f.token,
      WORKER_POLL_MS: '50',
      WORKER_TMP_DIR: tmp,
      OFFICE_SOCKET: sock,
      OFFICE_JOBS_DIR: jobsDir,
    })
    await waitFor(
      () => w.out.text.includes('[worker] office previews: LibreOffice sidecar'),
      15_000,
      'worker start',
    )
    const job = f.add({ fixture: 'slides.odp', name: 'Board offsite.odp', declaredMimeType: '' })
    await waitFor(() => job.status === 'done', 60_000, 'odp done')
    expect(job.result).toMatchObject({
      status: 'ready',
      mimeType: 'application/vnd.oasis.opendocument.presentation',
    })
    expect(job.result?.probe.pageCount).toBe(3)
    for (const p of [w, sc]) {
      if (process.platform === 'win32') p.c.send('shutdown')
      else p.c.kill('SIGTERM')
      expect(await p.exited).toBe(0)
    }
    expect(sc.out.text).toMatch(/\[office\] odp converted in \d+ ms/)
    expect(w.out.text + sc.out.text).not.toContain('Board offsite')
    expect(w.out.text + sc.out.text).not.toContain(f.token)
    expect(readdirSync(jobsDir)).toEqual([])
    expect(readdirSync(tmp)).toEqual([])
  })
})
