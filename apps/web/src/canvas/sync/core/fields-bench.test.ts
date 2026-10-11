// N1-2 (wave N): the typed copy against structuredClone on a 10k-element board. A measurement for the PR, not a
// gate (N1_BENCH=1 runs it):  N1_BENCH=1 pnpm vitest run apps/web/src/canvas/sync/core/fields-bench.test.ts
import { describe, expect, it } from 'vitest'
import { SAMPLE_ELEMENTS } from '../../../../../../packages/canvas-schema/src/test-samples.ts'
import { clone, copyElement } from './fields.ts'

const kinds = Object.values(SAMPLE_ELEMENTS)
const board = Array.from({ length: 10_000 }, (_, i) => ({
  ...structuredClone(kinds[i % kinds.length] as unknown as Record<string, unknown>),
  id: `el-${i}`,
  x: i * 3,
}))

/** The median of `runs` timings of `fn` over the board (ms). */
function time(fn: (el: Record<string, unknown>) => unknown, runs = 15): number {
  const t: number[] = []
  for (let r = 0; r < runs; r++) {
    const t0 = performance.now()
    for (const el of board) fn(el)
    t.push(performance.now() - t0)
  }
  t.sort((a, b) => a - b)
  return t[Math.floor(t.length / 2)] as number
}

describe.skipIf(!process.env.N1_BENCH)('10k element copies (N1_BENCH=1)', () => {
  it('copyElement against structuredClone', () => {
    time(copyElement, 3)
    time(clone, 3)
    const typed = time(copyElement)
    const generic = time(clone)
    console.log(
      `[n1-bench] 10k elements: copyElement ${typed.toFixed(1)} ms, structuredClone ${generic.toFixed(1)} ms`,
    )
    expect(typed).toBeGreaterThan(0)
  })
})
