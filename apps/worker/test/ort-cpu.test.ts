// Wave W foundation (docs/WAVE-W-CONTRACTS.md §4.3): onnxruntime-node runs a model on the CPU with its install script
// blocked (pnpm-workspace.yaml allowBuilds: onnxruntime-node false), using a tiny model encoded in the test. Never the
// real background-removal model.

import { describe, expect, it } from 'vitest'
import { BG_SESSION_OPTIONS, createOrtInference } from '../src/ops/bg-inference.ts'
import { tinyMaskModel, tinyMaskOf } from './tiny-onnx.ts'

describe('onnxruntime-node on the CPU, install script blocked', () => {
  it('runs the tiny mask model and matches its oracle', async () => {
    const size = 8
    const inference = await createOrtInference(tinyMaskModel(size), { size })
    try {
      const input = new Float32Array(3 * size * size)
      for (let i = 0; i < input.length; i++) input[i] = ((i * 37) % 23) / 11 - 1
      const mask = await inference.run(input)
      expect(mask.length).toBe(size * size)
      const plane = size * size
      for (let p = 0; p < plane; p++) {
        const want = tinyMaskOf(input[p] as number, input[plane + p] as number, input[2 * plane + p] as number)
        expect(Math.abs((mask[p] as number) - want)).toBeLessThan(1e-5)
      }
    } finally {
      await inference.close()
    }
  })

  it('refuses an input of the wrong size', async () => {
    const inference = await createOrtInference(tinyMaskModel(4), { size: 4 })
    try {
      await expect(inference.run(new Float32Array(10))).rejects.toThrow('input is not')
    } finally {
      await inference.close()
    }
  })

  it('runs on the CPU provider alone, two intra-op threads, no memory arena', () => {
    expect(BG_SESSION_OPTIONS).toEqual({
      executionProviders: ['cpu'],
      intraOpNumThreads: 2,
      interOpNumThreads: 1,
      enableCpuMemArena: false,
      graphOptimizationLevel: 'all',
    })
  })
})
