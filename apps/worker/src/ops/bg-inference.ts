// Wave W (docs/WAVE-W-CONTRACTS.md §4.3, §4.4): the background-removal model behind ONE interface, so the runner and
// every test can swap the engine. OWNER: the wave W lead (the interface and the ORT factory); WS2 owns the runner
// (remove-bg.ts) and the child (bg-child.ts) that call it.
//
// Rules:
//   - `onnxruntime-node` is imported ONLY here, and only dynamically inside `createOrtInference`, which only the
//     child process (bg-child.ts) calls: the worker's parent process never creates a session (a crash or an OOM in
//     native code then takes the child down, not the worker). Test: apps/worker/test/ort-cpu.test.ts.
//   - CPU execution provider only. Its install script (which would fetch GPU binaries) is blocked by allowBuilds in
//     pnpm-workspace.yaml; the CPU binaries ship in the package.
//   - The model's bytes come from bg-model.ts `loadBgModel` (a configured path, sha256-checked): never a download.

/** One mask inference: `input` is NCHW float32 [1, 3, size, size]; the answer is [1, 1, size, size] in 0..1. */
export interface BgInference {
  readonly size: number
  run(input: Float32Array): Promise<Float32Array>
  close(): Promise<void>
}

/** The session options of every background-removal session (§4.5's CPU budget). */
export const BG_SESSION_OPTIONS = {
  executionProviders: ['cpu'],
  intraOpNumThreads: 2,
  interOpNumThreads: 1,
  enableCpuMemArena: false,
  graphOptimizationLevel: 'all',
} as const

export interface OrtInferenceOptions {
  /** the model's input and output tensor names (u2netp: `input.1` and its first output; the tiny test model differs) */
  inputName?: string
  outputName?: string
  size: number
}

/** An ORT CPU session over `model` (the bytes `loadBgModel` returned). Child process only. */
export async function createOrtInference(model: Uint8Array, opts: OrtInferenceOptions): Promise<BgInference> {
  const ort = await import('onnxruntime-node')
  const session = await ort.InferenceSession.create(model, { ...BG_SESSION_OPTIONS, executionProviders: ['cpu'] })
  const inputName = opts.inputName ?? session.inputNames[0]
  const outputName = opts.outputName ?? session.outputNames[0]
  if (!inputName || !outputName) throw new Error('the model has no input or output')
  const { size } = opts
  return {
    size,
    async run(input) {
      if (input.length !== 3 * size * size) throw new Error('input is not [1, 3, size, size]')
      const out = await session.run({ [inputName]: new ort.Tensor('float32', input, [1, 3, size, size]) })
      const t = out[outputName]
      if (!t || t.type !== 'float32' || t.data.length !== size * size) throw new Error('unexpected model output')
      return t.data as Float32Array
    },
    async close() {
      await session.release()
    },
  }
}
