import { test as base, expect } from '@playwright/test'
import { boardIdFor, openSession, type Session } from './board.ts'
import { type Stack, startStack } from './stack.ts'

interface WorkerFixtures {
  /** Extra sync server env for this worker's stack. Override per file with test.use({ syncEnv }). */
  syncEnv: Record<string, string>
  stack: Stack
}

interface TestFixtures {
  /** A fresh board id for this test. */
  board: string
  /** Opens `board` as `user` in a new browser context (closed after the test). */
  session(user: string, opts?: { role?: 'viewer' }): Promise<Session>
  stackReady: undefined
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  syncEnv: [{}, { option: true, scope: 'worker' }],

  // One sync server + one worker per Playwright worker (workers: 1, so one per project/env).
  stack: [
    async ({ syncEnv }, use) => {
      const stack = await startStack({ syncEnv })
      await use(stack)
      await stack.stop()
    },
    { scope: 'worker', timeout: 90_000 },
  ],

  // A test that killed a process restarts it itself, but if it failed half-way the next test must
  // still start from a healthy stack.
  stackReady: [
    async ({ stack }, use, testInfo) => {
      await stack.ensureRunning()
      await use(undefined)
      if (testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach('sync.log', { body: stack.sync.logs(), contentType: 'text/plain' })
        await testInfo.attach('worker.log', { body: stack.worker.logs(), contentType: 'text/plain' })
      }
    },
    { auto: true },
  ],

  board: async ({ stackReady: _ }, use, testInfo) => {
    await use(boardIdFor(testInfo))
  },

  session: async ({ browser, board }, use) => {
    const opened: Session[] = []
    await use(async (user, opts) => {
      const s = await openSession(browser, board, user, opts)
      opened.push(s)
      return s
    })
    await Promise.all(opened.map((s) => s.context.close()))
  },
})

export { expect }
