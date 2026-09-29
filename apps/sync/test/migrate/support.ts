// Test support for O4's conversion, roll-forward and R0 stand-in suites (apps/sync/test/migrate/**).
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach } from 'vitest'

export * from './board-files.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

/** A temp dir removed after the test. */
export function tempDir(prefix = 'dr-migrate-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}
