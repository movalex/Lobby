// The spike B stack launcher (docs/EXCALIDRAW-MIGRATION.md §8.6.2, §8.6.5, §8.6.7): the REAL api, sync
// and preview worker, started by e2e/tests/support/stack.ts (reused by import, unchanged) on the spike B
// port base, with the engine flags in sync's environment:
//
//  - DRAFTROOM_ENGINE=excalidraw (O1's ElementRoom) or tldraw (the R0 stand-in, O4);
//  - DRAFTROOM_TEST_HOOKS=1 unless `testHooks: false` (the test snapshot, lease and COMMIT hooks);
//  - DRAFTROOM_BACKUP_STORE=off, always: no stack of spike B ever uploads a backup. The launcher strips
//    every DRAFTROOM_*/R2_* variable of this process from the children, and this module refuses any R2
//    variable or another backup store in `syncEnv`, and the opt-in R2 blob store (B7 runs on fs).
//
// The web build is served by playwright.config.ts on the same base (SPIKE_B_PORT_BASE), so a stack on
// another base is refused: the browsers would reach another stack's api through the preview proxy.
import './env.ts'
import { mkdirSync } from 'node:fs'
import { request } from '@playwright/test'
import { Api, type Me } from '../../tests/support/api.ts'
import { API_PORT, SYNC_PORT, WEB_PORT } from '../../tests/support/ports.ts'
import {
  type Stack as E2eStack,
  type ManagedProcess,
  startStack as startE2eStack,
} from '../../tests/support/stack.ts'
import { SPIKE_B_STACK } from './env.ts'
import { ownerOf, type StackPorts, stackPorts } from './ports.ts'
import type { DevUser, SpikeBStack, StackOptions } from './types.ts'

/** The Dev Studio workspace every dev user joins (apps/api/src/auth/dev.ts). */
export const DEV_STUDIO_NAME = 'Dev Studio'

if (SYNC_PORT !== SPIKE_B_STACK.sync || API_PORT !== SPIKE_B_STACK.api || WEB_PORT !== SPIKE_B_STACK.web)
  throw new Error(
    `e2e/tests/support/ports.ts loaded before e2e/spike-b/support/env.ts (sync ${SYNC_PORT}, expected ${SPIKE_B_STACK.sync}): import the spike B harness before any e2e/tests support module`,
  )

/** O3's stack: the frozen SpikeBStack plus what the harness itself needs. */
export interface O3Stack extends SpikeBStack {
  /** the underlying e2e stack (api, sync, worker processes and their logs) */
  readonly e2e: E2eStack
  readonly sync: ManagedProcess
  /** whether sync serves the test routes */
  readonly testHooks: boolean
  /** an api client signed in as `user` (cached per handle; disposed by `stop`) */
  api(user: DevUser): Promise<{ api: Api; me: Me }>
  /** everything sync printed (for evidence; it never prints tickets or secrets) */
  syncLogs(): string
}

const FORBIDDEN_SYNC_ENV = /^(R2_|DRAFTROOM_BACKUP_R2_|DRAFTROOM_BACKUP_OFFSITE)/

/** Checks `syncEnv` against §8.6.7 (no R2, backups off) and returns the sync environment to use. */
export function spikeSyncEnv(opts: StackOptions): Record<string, string> {
  const extra = { ...opts.syncEnv }
  for (const key of Object.keys(extra)) {
    if (FORBIDDEN_SYNC_ENV.test(key)) throw new Error(`spike B stacks never pass ${key} to sync (§8.6.7)`)
  }
  if (extra.DRAFTROOM_BACKUP_STORE !== undefined && extra.DRAFTROOM_BACKUP_STORE !== 'off')
    throw new Error('spike B stacks run with DRAFTROOM_BACKUP_STORE=off (§8.6.7)')
  const engine = opts.engine ?? 'excalidraw'
  const testHooks = opts.testHooks ?? true
  return {
    ...extra,
    DRAFTROOM_ENGINE: engine,
    ...(testHooks ? { DRAFTROOM_TEST_HOOKS: '1' } : {}),
    DRAFTROOM_BACKUP_STORE: 'off',
  }
}

/** The stack's base: SPIKE_B_PORT_BASE (what the web build proxies to); another base is refused. */
export function resolveStackPorts(opts: StackOptions): StackPorts {
  const ports = stackPorts(opts.base ?? SPIKE_B_STACK.base)
  if (ports.base !== SPIKE_B_STACK.base)
    throw new Error(
      `startStack({ base: ${ports.base} }) but the web build serves SPIKE_B_PORT_BASE=${SPIKE_B_STACK.base}: run the spec with SPIKE_B_PORT_BASE=${ports.base}`,
    )
  if (ownerOf(ports.base) === null) throw new Error(`port base ${ports.base} is outside spike B's 7850-7999`)
  return ports
}

/** Runs `fn` with the temp directory pointed at `dir` (the launcher makes its data dir in tmpdir()). */
async function withTempDir<T>(dir: string | undefined, fn: () => Promise<T>): Promise<T> {
  if (!dir) return fn()
  // the launcher's mkdtemp needs the folder to exist (B8's specs pass a fresh path; lead, M1/M2)
  mkdirSync(dir, { recursive: true })
  const keys = ['TEMP', 'TMP', 'TMPDIR'] as const
  const saved = keys.map((k) => [k, process.env[k]] as const)
  for (const k of keys) process.env[k] = dir
  try {
    return await fn()
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

export async function startSpikeStack(opts: StackOptions = {}): Promise<O3Stack> {
  const ports = resolveStackPorts(opts)
  if ((process.env.E2E_BLOB_STORE ?? 'fs').trim() !== 'fs')
    throw new Error('spike B runs on the fs blob store only (§8.3 B7): unset E2E_BLOB_STORE')
  const engine = opts.engine ?? 'excalidraw'
  const testHooks = opts.testHooks ?? true
  const syncEnv = spikeSyncEnv(opts)
  // With `dataDir`, the launcher's mkdtemp (tmpdir()/dr-e2e-*) lands inside it: B8's staging runs keep
  // every file under spike-b8/ (§8.6.7).
  const e2e = await withTempDir(opts.dataDir, () => startE2eStack({ syncEnv }))
  const apis = new Map<string, Promise<{ api: Api; me: Me }>>()

  const api = (user: DevUser) => {
    let entry = apis.get(user.handle)
    if (!entry) {
      entry = Api.signIn({ request }, user.handle, user.name)
      apis.set(user.handle, entry)
      entry.catch(() => apis.delete(user.handle))
    }
    return entry
  }

  const stack: O3Stack = {
    ports,
    dataDir: e2e.dataDir,
    internalSecret: e2e.internalSecret,
    engine,
    e2e,
    sync: e2e.sync,
    testHooks,
    api,
    syncLogs: () => e2e.sync.logs(),
    async createBoard({ owner, members = [], title }) {
      const { api: ownerApi, me } = await api(owner)
      const studio = me.workspaces.find((w) => w.name === DEV_STUDIO_NAME)
      if (!studio) throw new Error(`dev user ${owner.handle} is not in ${DEV_STUDIO_NAME}`)
      const board = await ownerApi.createBoard(studio.id, title ?? `spike-b ${new Date().toISOString()}`)
      for (const m of members) {
        const { me: memberMe } = await api(m.user)
        await ownerApi.putMember(board.id, memberMe.user.id, m.role)
      }
      return { boardId: board.id }
    },
    async killSync(signal = 'SIGKILL') {
      if (signal === 'SIGKILL') return e2e.sync.kill()
      // SIGINT: on Windows Node cannot deliver it and terminates the process as hard as SIGKILL
      // (child_process docs); the evidence of any check that asks for SIGINT says so.
      const pid = e2e.sync.pid()
      if (pid === undefined) return
      process.kill(pid, 'SIGINT')
      const deadline = Date.now() + 15_000
      while (e2e.sync.running() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
      if (e2e.sync.running()) await e2e.sync.kill()
    },
    async restartSync() {
      if (e2e.sync.running()) await e2e.sync.restart()
      else await e2e.sync.start()
    },
    async stop() {
      const all = await Promise.allSettled(apis.values())
      await Promise.all(all.map((r) => (r.status === 'fulfilled' ? r.value.api.dispose() : undefined)))
      apis.clear()
      await e2e.stop()
    },
  }
  return stack
}
