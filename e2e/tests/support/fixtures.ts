import { test as base, expect } from '@playwright/test'
import type { BoardRole } from './api.ts'
import { openSession, type Session } from './board.ts'
import { type Stack, type StackEngine, startStack } from './stack.ts'
import { createUsers, type Users } from './users.ts'

interface WorkerFixtures {
  /**
   * The canvas engine of this worker's stack: tldraw (default, today's app) or excalidraw (set by
   * e2e/excalidraw/playwright.config.ts for the ported specs; sync then runs EXCALIDRAW_SYNC_ENV under
   * any `syncEnv`). The web build must match: each config builds its own.
   */
  engine: StackEngine
  /** Extra sync server env for this worker's stack. Override per file with test.use({ syncEnv }). */
  syncEnv: Record<string, string>
  /** Extra preview worker env for this worker's stack (test.use({ workerEnv })). */
  workerEnv: Record<string, string>
  /** Extra api env for this worker's stack (test.use({ apiEnv })). */
  apiEnv: Record<string, string>
  stack: Stack
  /** The stack's people (alice owns Dev Studio; see users.ts). */
  users: Users
}

interface TestFixtures {
  /** A fresh private board in Dev Studio for this test, owned by alice. */
  board: string
  /**
   * Opens `board` as `user` in a new browser context (closed after the test). Anyone but alice is
   * first given an explicit grant by alice (default: editor; `role: null` = no grant, for tests that
   * share through the UI).
   */
  session(user: string, opts?: { role?: BoardRole | null; via?: 'ui' | 'cookie' }): Promise<Session>
  stackReady: undefined
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  engine: ['tldraw', { option: true, scope: 'worker' }],
  syncEnv: [{}, { option: true, scope: 'worker' }],
  workerEnv: [{}, { option: true, scope: 'worker' }],
  apiEnv: [{}, { option: true, scope: 'worker' }],

  // One api + sync server + worker per Playwright worker (workers: 1, so one per project/env).
  stack: [
    async ({ engine, syncEnv, workerEnv, apiEnv }, use) => {
      const stack = await startStack({ engine, syncEnv, workerEnv, apiEnv })
      await use(stack)
      await stack.stop()
    },
    { scope: 'worker', timeout: 90_000 },
  ],

  users: [
    async ({ stack: _, playwright }, use) => {
      const users = await createUsers(playwright)
      await use(users)
      await users.dispose()
    },
    { scope: 'worker', timeout: 60_000 },
  ],

  // A test that killed a process restarts it itself, but if it failed half-way the next test must
  // still start from a healthy stack. It also creates `users` for every test, so alice is always the
  // first user to sign in (the Dev Studio owner) even in tests that sign other people in themselves.
  stackReady: [
    async ({ stack, users: _ }, use, testInfo) => {
      await stack.ensureRunning()
      await use(undefined)
      if (testInfo.status !== testInfo.expectedStatus) {
        for (const p of [stack.api, stack.sync, stack.worker]) {
          await testInfo.attach(`${p.name}.log`, { body: p.logs(), contentType: 'text/plain' })
        }
      }
    },
    { auto: true },
  ],

  board: async ({ stackReady: _, users }, use, testInfo) => {
    // A readable board title (it shows in the top bar and in screenshots): the test title up to ':'.
    const short = testInfo.title.split(':')[0]?.trim().slice(0, 60) || 'Board'
    await use(await users.createBoard(short.charAt(0).toUpperCase() + short.slice(1)))
  },

  session: async ({ browser, board, users }, use) => {
    const opened: Session[] = []
    await use(async (user, opts = {}) => {
      const who = opts.role === null ? await users.get(user) : await users.grant(board, user, opts.role)
      const s = await openSession(browser, board, who, { via: opts.via })
      opened.push(s)
      return s
    })
    await Promise.all(opened.map((s) => s.context.close()))
  },
})

export { expect }
