import { defineConfig } from 'vitest/config'
import { ARROWS_ACCEPTANCE } from './vitest.config.ts'

// Spike B C0 arrow acceptance tests (docs/EXCALIDRAW-MIGRATION.md §8.6.2; docs/research/excalidraw/spike-b/
// CONTRACTS.md "Arrow acceptance tests"): the recheck's scenarios against O1's real room, in-process.
// Run: pnpm test:arrows   (or: pnpm exec vitest run -c vitest.arrows.config.ts [file])
// They fail against the C0 stubs (the room throws "not implemented (O1)"); the client-side tests, which
// need only groups.ts and limits.ts, pass. O1's room must pass every one before M1.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'sync-arrows-acceptance',
          environment: 'node',
          include: [`${ARROWS_ACCEPTANCE}/*.test.ts`],
          testTimeout: 180_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
})
