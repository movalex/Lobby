import { defineConfig } from 'vitest/config'

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
    ],
  },
})
