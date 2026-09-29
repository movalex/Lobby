import { defineConfig } from 'vitest/config'

/**
 * Spike B (docs/EXCALIDRAW-MIGRATION.md §8.6.2): the C0 arrow acceptance tests run against O1's real room
 * and FAIL against the C0 stubs, so they are kept out of the default run until M1 and run on their own:
 * `pnpm test:arrows` (vitest.arrows.config.ts, project `sync-arrows-acceptance`). From M1 on the lead moves
 * that project into this list, and they are part of every gate.
 */
export const ARROWS_ACCEPTANCE = 'apps/sync/test/room/arrows/**'

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'canvas-schema',
          environment: 'node',
          include: ['packages/canvas-schema/src/**/*.test.ts'],
        },
      },
      {
        test: { name: 'dev-assets', environment: 'node', include: ['packages/dev-assets/src/**/*.test.ts'] },
      },
      {
        test: {
          name: 'sync',
          environment: 'node',
          include: ['apps/sync/src/**/*.test.ts', 'apps/sync/test/**/*.test.ts'],
          exclude: [ARROWS_ACCEPTANCE, '**/node_modules/**'],
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
      {
        test: {
          name: 'worker',
          environment: 'node',
          include: ['apps/worker/src/**/*.test.ts', 'apps/worker/test/**/*.test.ts'],
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
      { test: { name: 'web', environment: 'node', include: ['apps/web/src/**/*.test.ts'] } },
      // Excalidraw engine probe suite, Node part (docs/EXCALIDRAW-MIGRATION.md §6.5); the browser part runs from its own runner
      {
        test: {
          name: 'engine-probe',
          environment: 'node',
          include: ['apps/web/test/engine-probe/**/*.test.ts'],
          testTimeout: 60_000,
        },
      },
      {
        test: {
          name: 'packages',
          environment: 'node',
          include: [
            'packages/contracts/src/**/*.test.ts',
            'packages/db/src/**/*.test.ts',
            'packages/db/test/**/*.test.ts',
            'packages/permissions/src/**/*.test.ts',
            'packages/auth-tickets/src/**/*.test.ts',
            'packages/board-ops/src/**/*.test.ts',
            'packages/templates/src/**/*.test.ts',
            'packages/blob-store/src/**/*.test.ts',
            'packages/blob-store/test/**/*.test.ts',
            // spike B: O4's converter package
            'packages/tldraw-import/src/**/*.test.ts',
            'packages/tldraw-import/test/**/*.test.ts',
          ],
          testTimeout: 60_000,
        },
      },
      // spike B: O3's load generator's own unit tests (e2e/load/**; the runs themselves are Node scripts)
      { test: { name: 'e2e-load', environment: 'node', include: ['e2e/load/**/*.test.ts'] } },
      {
        test: {
          name: 'api',
          environment: 'node',
          include: ['apps/api/src/**/*.test.ts', 'apps/api/test/**/*.test.ts'],
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
})
