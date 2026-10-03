/**
 * The browser probes (`pnpm probe:browser`, `probe:layout`) take a port inside the run's E2E_PORT_BASE range, at
 * PROBE_PORT_OFFSET (browser/browser.ts). Another kit on the same offset would collide when the probes and the e2e suite
 * run together on one base (the A3 probe used +10, which is the fake OpenAI server of e2e/excalidraw/ai-kit.ts). This
 * reads e2e/ for every `PORT_BASE + n` and `base + n` and fails when a probe offset is among them.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { PROBE_PORT_OFFSET } from './browser/browser.ts'

const E2E = fileURLToPath(new URL('../../../../e2e/', import.meta.url))

/** every offset an e2e source file adds to the port base, with the file that does */
function e2eOffsets(): Map<number, string[]> {
  const found = new Map<number, string[]>()
  for (const rel of readdirSync(E2E, { recursive: true, encoding: 'utf8' })) {
    const path = rel.split(sep).join('/')
    if (!/\.(ts|mts)$/.test(path) || /(^|\/)(node_modules|test-results)\//.test(path)) continue
    const text = readFileSync(join(E2E, path), 'utf8')
    for (const re of [/PORT_BASE[^\n]*?\+\s*(\d+)/g, /\bbase\s*\+\s*(\d+)/g]) {
      for (const m of text.matchAll(re)) {
        const n = Number(m[1])
        found.set(n, [...(found.get(n) ?? []), path])
      }
    }
  }
  return found
}

describe('engine probe ports', () => {
  const offsets = Object.entries(PROBE_PORT_OFFSET)

  it('sees the offsets the e2e kits take (so the scan below is not vacuous)', () => {
    const taken = [...e2eOffsets().keys()]
    for (const known of [1, 2, 3, 10, 23, 30]) expect(taken, `offset ${known}`).toContain(known)
  })

  it('takes offsets that differ from each other and fit a 40-port range', () => {
    expect(new Set(offsets.map(([, n]) => n)).size).toBe(offsets.length)
    for (const [name, n] of offsets) {
      expect(n, name).toBeGreaterThanOrEqual(0)
      expect(n, name).toBeLessThan(40)
    }
  })

  it('takes no offset that an e2e kit uses', () => {
    const taken = e2eOffsets()
    for (const [name, n] of offsets) expect(taken.get(n) ?? [], `${name} (+${n}) collides with`).toEqual([])
  })
})
