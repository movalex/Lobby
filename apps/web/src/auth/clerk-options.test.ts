// K6-2: the browser's Clerk loader is given telemetry: false, by every <ClerkProvider> of the app.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { clerkProviderOptions } from './clerk-options.ts'

const SRC = join(import.meta.dirname, '..')

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) yield* sources(p)
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) yield p
  }
}

describe('K6-2: Clerk in the browser', () => {
  it('the provider options turn telemetry off', () => {
    expect(clerkProviderOptions('pk_test_abc')).toEqual({ publishableKey: 'pk_test_abc', telemetry: false })
  })

  it('every <ClerkProvider> in apps/web/src is given those options (none sets a key of its own)', () => {
    const providers: { file: string; opening: string }[] = []
    for (const file of sources(SRC)) {
      // the code only: comments name the provider too
      const text = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
      for (const m of text.matchAll(/<ClerkProvider\b[^>]*>/gs))
        providers.push({ file: relative(SRC, file), opening: m[0] })
    }
    // positive control: the sign-in page and the sign-out root
    expect(providers.map((p) => p.file.replaceAll('\\', '/')).sort()).toEqual([
      'auth/ClerkSignIn.tsx',
      'auth/clerkSession.tsx',
    ])
    for (const p of providers) {
      expect(p.opening, p.file).toContain('{...clerkProviderOptions(')
      expect(p.opening, p.file).not.toMatch(/\bpublishableKey=|\btelemetry=/)
    }
  })
})
