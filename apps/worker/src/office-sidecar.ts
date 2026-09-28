// Office sidecar process: `node apps/worker/src/office-sidecar.ts` (deploy/nas/worker/docker-compose.yml,
// service `office`). Converts Office documents to PDF for the worker (office-server.ts) from a container
// with no network, no secrets and its own memory limit.
//
// Environment:
//   OFFICE_SOCKET          Unix socket path in the shared volume (required, absolute)
//   OFFICE_JOBS_DIR        the shared volume; requests may only name files inside it (required, absolute)
//   OFFICE_WORK_DIR        scratch for each conversion's profile/HOME/TMPDIR (default: the OS temp dir)
//   SOFFICE_PATH           LibreOffice's soffice (default: `soffice` on PATH)
//   OFFICE_MAX_TIMEOUT_MS  cap on a request's timeout (default LIMITS.officeConvertTimeoutMs)
//   OFFICE_MAX_QUEUE       requests waiting behind the running one (default 4)
// It refuses to start with any credential in its environment, and (NODE_ENV=production) with any network
// interface but loopback: isolation is checked from the inside, not just assumed from the compose file.
import { mkdtemp, rm } from 'node:fs/promises'
import { networkInterfaces, tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { LIMITS } from '@draftroom/dev-assets'
import { sofficeCommand } from './office.ts'
import { isNamedPipe } from './office-protocol.ts'
import { type OfficeServerConfig, startOfficeServer } from './office-server.ts'
import { run } from './run.ts'
import { sofficeEnv } from './soffice.ts'

type Env = Record<string, string | undefined>

const SECRETS = [
  'DRAFTROOM_WORKER_TOKEN',
  'DATABASE_URL',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'DRAFTROOM_TICKET_SECRET',
  'DRAFTROOM_INTERNAL_SECRET',
  'CLERK_SECRET_KEY',
  'RENDER_API_KEY',
]

const read = (env: Env, name: string) => env[name]?.trim() || undefined

function int(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = read(env, name)
  if (raw === undefined) return fallback
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a non-negative integer`)
  const n = Number(raw)
  if (n < min || n > max) throw new Error(`${name} must be between ${min} and ${max}`)
  return n
}

/** Non-loopback network interfaces (names only). */
export function externalInterfaces(): string[] {
  return Object.entries(networkInterfaces())
    .filter(([, addrs]) => (addrs ?? []).some((a) => !a.internal))
    .map(([name]) => name)
}

export function loadOfficeSidecarEnv(
  env: Env = process.env,
  interfaces: () => string[] = externalInterfaces,
): Omit<OfficeServerConfig, 'log'> & { production: boolean } {
  const production = env.NODE_ENV === 'production'
  const present = SECRETS.filter((n) => read(env, n) !== undefined)
  if (present.length) {
    throw new Error(
      `the office sidecar must hold no secrets: remove ${present.join(', ')} from its environment`,
    )
  }
  const socketPath = read(env, 'OFFICE_SOCKET')
  if (!socketPath || !(isAbsolute(socketPath) || isNamedPipe(socketPath))) {
    throw new Error('OFFICE_SOCKET is required (an absolute path in the volume shared with the worker)')
  }
  const jobsDir = read(env, 'OFFICE_JOBS_DIR')
  if (!jobsDir || !isAbsolute(jobsDir)) throw new Error('OFFICE_JOBS_DIR is required (an absolute path)')
  const workDir = read(env, 'OFFICE_WORK_DIR') ?? tmpdir()
  if (!isAbsolute(workDir)) throw new Error('OFFICE_WORK_DIR must be an absolute path')
  const command = sofficeCommand(read(env, 'SOFFICE_PATH'))
  if (production && command.length > 1) {
    throw new Error(
      'SOFFICE_PATH must name LibreOffice itself when NODE_ENV=production (not a script stand-in)',
    )
  }
  if (production) {
    const ext = interfaces()
    if (ext.length) {
      throw new Error(
        `the office sidecar must run without network (docker: network_mode none); found ${ext.join(', ')}`,
      )
    }
  }
  return {
    production,
    socketPath,
    jobsDir,
    workDir,
    command,
    maxTimeoutMs: int(env, 'OFFICE_MAX_TIMEOUT_MS', LIMITS.officeConvertTimeoutMs, 1_000, 600_000),
    maxQueue: int(env, 'OFFICE_MAX_QUEUE', 4, 0, 32),
    // LibreOffice's IPC sockets always go to /tmp (office-server.ts sweepOfficePipes); a development
    // sidecar on a shared machine leaves /tmp alone, since a person's own LibreOffice may be running.
    pipeDir: production && process.platform !== 'win32' ? '/tmp' : null,
  }
}

/** "LibreOffice 24.8.7.2 …" from `soffice --version`, or null when it does not start. */
export async function sofficeVersion(command: string[], workDir: string): Promise<string | null> {
  const [cmd, ...prefix] = command
  if (!cmd) return null
  const scratch = await mkdtemp(join(workDir, 'lo-version-'))
  try {
    const r = await run(cmd, [...prefix, '--version'], {
      timeoutMs: 60_000,
      maxStdoutBytes: 8 * 1024,
      env: sofficeEnv(scratch),
      cwd: scratch,
      killTree: true,
    })
    if (r.spawnError || r.code !== 0) return null
    const line =
      r.stdout
        .toString('utf8')
        .split(/\r?\n/)
        .find((l) => l.trim()) ?? ''
    return (
      line
        .replace(/[^\w .()+-]/g, '')
        .trim()
        .slice(0, 120) || null
    )
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {})
  }
}

if (import.meta.main) {
  const log = (line: string) => console.log(line)
  let cfg: ReturnType<typeof loadOfficeSidecarEnv>
  try {
    cfg = loadOfficeSidecarEnv()
  } catch (e) {
    console.error(`[office] refusing to start: ${(e as Error).message}`)
    process.exit(1)
  }
  const version = await sofficeVersion(cfg.command, cfg.workDir)
  log(
    version
      ? `[office] ${version}`
      : '[office] LibreOffice did not start: every request will get OFFICE_UNAVAILABLE',
  )
  const server = await startOfficeServer({ ...cfg, log })
  const ext = externalInterfaces()
  log(
    `[office] listening (queue ${cfg.maxQueue}, timeout cap ${cfg.maxTimeoutMs} ms, network: ${ext.length ? ext.join(', ') : 'none'})`,
  )
  let stopping = false
  const stop = (why: string) => {
    if (stopping) return
    stopping = true
    log(`[office] ${why}: stopping`)
    void server.close().then(() => {
      log('[office] stopped')
      process.exit(0)
    })
  }
  process.on('SIGTERM', () => stop('SIGTERM'))
  process.on('SIGINT', () => stop('SIGINT'))
  if (process.send) process.on('message', (m) => m === 'shutdown' && stop('shutdown message'))
}
