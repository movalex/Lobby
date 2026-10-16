import { defineConfig } from 'vitest/config'

/**
 * Spike B (docs/EXCALIDRAW-MIGRATION.md §8.6.2): the C0 arrow acceptance tests run against O1's real room.
 * They stayed out of the default run until M1; since the M1 integration their project
 * `sync-arrows-acceptance` is in this list and in every gate. `pnpm test:arrows` still runs them alone.
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
      // spike B, from M1: the C0 arrow acceptance tests against O1's room (as in vitest.arrows.config.ts)
      {
        test: {
          name: 'sync-arrows-acceptance',
          environment: 'node',
          include: [`${ARROWS_ACCEPTANCE}/*.test.ts`],
          testTimeout: 180_000,
          hookTimeout: 60_000,
        },
      },
      { test: { name: 'web', environment: 'node', include: ['apps/web/src/**/*.test.ts'] } },
      // Excalidraw engine probe suite, Node part (docs/EXCALIDRAW-MIGRATION.md §6.5). The browser part (the A3 layout
      // corpus, A8's index collision, addFiles keeping the first entry, in a mounted <Excalidraw>) is
      // `pnpm probe:browser`. Both, and the engine-probe tsconfig inside `pnpm typecheck`, run on every @excalidraw
      // bump (the rule in pnpm-workspace.yaml) and in CI.
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
            // wave Q (the foundation): the pinned icon sets and, from WS1, their generator and converter
            'packages/icon-sets/src/**/*.test.ts',
            'packages/blob-store/src/**/*.test.ts',
            'packages/blob-store/test/**/*.test.ts',
            // wave R (WS4): the .lobby backup's zip writer and reader
            'packages/board-archive/src/**/*.test.ts',
            // spike B: O4's converter package
            'packages/tldraw-import/src/**/*.test.ts',
            'packages/tldraw-import/test/**/*.test.ts',
          ],
          testTimeout: 60_000,
        },
      },
      // spike B: O3's load generator's own unit tests (e2e/load/**; the runs themselves are Node scripts)
      // C5: and the e2e harness helpers (e2e/tests/support: the port guard)
      {
        test: {
          name: 'e2e-load',
          environment: 'node',
          include: [
            'e2e/load/**/*.test.ts',
            'e2e/tests/support/**/*.test.ts',
            // wave N (the foundation): the 10k big board fixture's own test
            'e2e/excalidraw/support/**/*.test.ts',
          ],
        },
      },
      // wave C4: the repo's own CI scripts (scripts/audit-check.mjs, the dependency audit and its allowlist)
      {
        test: {
          name: 'scripts',
          environment: 'node',
          include: ['scripts/**/*.test.ts'],
          testTimeout: 30_000,
        },
      },
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
