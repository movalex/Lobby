// Shared pieces of the Miro import tests (wave R, WS1): the api over PGlite with the fake Miro behind the local-dev
// seam (DRAFTROOM_MIRO_TEST_ORIGINS: the fake's API origin, and its files origin when files are on), a sync fake on
// the new canvas whose `miro-v2` seed runs the real converter (packages/miro-import) in this process, and the
// helpers to start, watch and steer a job. Never the real Miro.

import { installedServerTextMetrics, installServerTextMetrics } from '@draftroom/canvas-schema/engine'
import {
  type ImportJobView,
  importJobPath,
  type LobbyElementsSnapshot,
  miroBoardsPath,
  miroImportPath,
} from '@draftroom/contracts'
import { convertMiroBoard, type MiroSeedBody } from '@draftroom/miro-import'
import { type FakeMiro, startFakeMiro } from '@draftroom/miro-import/fake-miro'
import type { LightMyRequestResponse } from 'fastify'
import { importRunnerOf } from '../../../src/features/imports/index.ts'
import type { ImportRunner } from '../../../src/features/imports/runner.ts'
import {
  type LobbySeed,
  type RoomSnapshotJson,
  type SyncInternalClient,
  SyncSeedConflict,
  SyncUnavailable,
} from '../../../src/sync-internal.ts'
import { type Client, createTestApi, DEV_STUDIO, type TestApi } from '../../helpers.ts'

/** A sync on the new canvas: lobby-elements seeds, and `miro-v2` seeds converted with the real converter. */
export class MiroSync implements SyncInternalClient {
  boards = new Map<string, LobbyElementsSnapshot>()
  miroSeeds: { boardId: string; body: MiroSeedBody }[] = []
  /** the next seeds answer this status (503 busy, 413 too large, …) */
  failNext: number[] = []
  async engine() {
    return 'excalidraw' as const
  }
  async snapshot(boardId: string) {
    return structuredClone(
      this.boards.get(boardId) ?? {
        format: 'lobby-elements' as const,
        schema: 1,
        clock: 0,
        elements: [],
        doc: {},
      },
    )
  }
  async seed(boardId: string, body: RoomSnapshotJson | LobbySeed) {
    if (this.boards.has(boardId)) throw new SyncSeedConflict()
    const lobby = body as LobbySeed
    this.boards.set(boardId, {
      format: 'lobby-elements',
      schema: 1,
      clock: 1,
      elements: lobby.elements as never,
      doc: lobby.doc,
    })
    return { records: lobby.elements.length }
  }
  async seedMiro(boardId: string, body: unknown) {
    const status = this.failNext.shift()
    if (status) throw new SyncUnavailable(`seed failed with ${status}`, status)
    if (this.boards.has(boardId)) throw new SyncSeedConflict()
    const seed = structuredClone(body) as MiroSeedBody
    this.miroSeeds.push({ boardId, body: seed })
    if (!installedServerTextMetrics()) installServerTextMetrics()
    const out = convertMiroBoard(seed, { now: Date.now() })
    this.boards.set(boardId, {
      format: 'lobby-elements',
      schema: 1,
      clock: 1,
      elements: out.elements as never,
      doc: out.doc,
    })
    return { records: out.elements.length, report: out.report }
  }
}

export interface MiroWorld {
  api: TestApi
  miro: FakeMiro
  sync: MiroSync
  runner: ImportRunner
  logs: string[]
  /** every response body the test saw (the token scan reads them) */
  bodies: string[]
  alice: Client
  bob: Client
  /** a request that keeps its answer's body for the scan */
  call(c: Client, method: 'GET' | 'POST', url: string, body?: unknown): Promise<LightMyRequestResponse>
  listBoards(c: Client, body?: Record<string, unknown>): Promise<LightMyRequestResponse>
  start(
    c: Client,
    boards: { miroBoardId: string; title?: string }[],
    extra?: Record<string, unknown>,
  ): Promise<string>
  view(c: Client, importId: string): Promise<ImportJobView>
  /** waits until the job's view satisfies `done` (polling as the dialog does, but fast) */
  until(c: Client, importId: string, done: (v: ImportJobView) => boolean, ms?: number): Promise<ImportJobView>
  /** holds the fake's file downloads until `open()` (closing the world opens every hold) */
  hold(): { open(): void }
  close(): Promise<void>
}

export async function miroWorld(
  opts: { files?: boolean; env?: Record<string, string>; db?: TestApi['db']; miro?: FakeMiro } = {},
): Promise<MiroWorld> {
  const miro = opts.miro ?? (await startFakeMiro())
  const sync = new MiroSync()
  const logs: string[] = []
  const bodies: string[] = []
  const holds: (() => void)[] = []
  const api = await createTestApi({
    ...(opts.db ? { db: opts.db } : {}),
    env: {
      DRAFTROOM_MIRO_TEST_ORIGINS: opts.files === false ? miro.api : `${miro.api},${miro.files}`,
      ...opts.env,
    },
    deps: {
      syncInternal: sync,
      logger: { level: 'info', stream: { write: (l: string) => void logs.push(l) } },
    },
  })
  const runner = importRunnerOf(api.app)
  if (!runner) throw new Error('no import runner')
  const alice = await api.login('alice')
  const bob = await api.login('bob')
  const w: MiroWorld = {
    api,
    miro,
    sync,
    runner,
    logs,
    bodies,
    alice,
    bob,
    async call(c, method, url, body) {
      const res = await c.req(method, url, body)
      bodies.push(res.body)
      return res
    },
    listBoards: (c, body = {}) =>
      w.call(c, 'POST', miroBoardsPath(DEV_STUDIO), { token: miro.token, ...body }),
    async start(c, boards, extra = {}) {
      const res = await w.call(c, 'POST', miroImportPath(DEV_STUDIO), { token: miro.token, boards, ...extra })
      if (res.statusCode !== 202) throw new Error(`start: ${res.statusCode} ${res.body}`)
      return (res.json() as { importId: string }).importId
    },
    async view(c, importId) {
      const res = await w.call(c, 'GET', importJobPath(importId))
      if (res.statusCode !== 200) throw new Error(`view: ${res.statusCode} ${res.body}`)
      return res.json() as ImportJobView
    },
    async until(c, importId, done, ms = 30_000) {
      const deadline = Date.now() + ms
      for (;;) {
        const v = await w.view(c, importId)
        if (done(v)) return v
        if (Date.now() > deadline)
          throw new Error(`until: still ${v.status} ${JSON.stringify(v.boards.map((b) => b.progress))}`)
        await new Promise((r) => setTimeout(r, 20))
      }
    },
    hold() {
      const g = gate()
      holds.push(g.open)
      miro.behaviour.holdFiles = g.opened
      return g
    },
    async close() {
      for (const open of holds) open()
      miro.behaviour.holdFiles = null
      await api.close()
      if (!opts.miro) await miro.close()
    },
  }
  return w
}

/** A gate a test opens later (the fake Miro's `holdFiles`). */
export function gate() {
  let open = () => {}
  const opened = new Promise<void>((r) => {
    open = r
  })
  return { open, opened }
}
