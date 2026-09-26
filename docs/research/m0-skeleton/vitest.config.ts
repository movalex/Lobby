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
      { test: { name: 'sync', environment: 'node', include: ['apps/sync/src/**/*.test.ts'] } },
      { test: { name: 'web', environment: 'node', include: ['apps/web/src/**/*.test.ts'] } },
    ],
  },
})
