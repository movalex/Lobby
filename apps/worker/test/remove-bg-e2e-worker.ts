// OWNER: WS2 (wave W, background removal). The e2e stand-in for a NAS worker that can remove backgrounds, started by
// e2e/excalidraw/w2-remove-bg.spec.ts as its own process (never part of `pnpm test`: no .test.ts suffix):
//
//   node apps/worker/test/remove-bg-e2e-worker.ts   (env: W2_API_URL, W2_WORKER_TOKEN, W2_TMP_DIR)
//
// It is the REAL worker side of the op (apps/worker: the ops client, runOneOp, the remove-bg runner and its child
// process, sharp, onnxruntime-node) with exactly one thing swapped: the model. The stack's own worker reports no
// remove-bg capability (BG_MODEL.sha256 pins the real u2netp file, which tests never use), so this process reports it
// with the tiny synthetic model of apps/worker/test/tiny-onnx.ts (sigmoid of the mean of the channels, the u2netp
// shape at 320 × 320), its hash passed to the runner as the pin. Never the real model; never any network but the
// stack's api. Logs `[w2-op-worker] <outcome>` lines the spec waits on; stops on SIGTERM or when stdin closes.

import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { WORKER_CAPABILITIES } from '@draftroom/contracts'
import { createApiCall, createWorkerApi } from '../src/api-client.ts'
import { createWorkerOpsApi } from '../src/ops/client.ts'
import { runOneOp } from '../src/ops/loop.ts'
import { createRemoveBgRunner } from '../src/ops/remove-bg.ts'
import { tinyMaskModel } from './tiny-onnx.ts'

const apiUrl = process.env.W2_API_URL ?? ''
const token = process.env.W2_WORKER_TOKEN ?? ''
const tmpDir = process.env.W2_TMP_DIR ?? ''
if (!apiUrl || token.length < 32 || !tmpDir) {
  process.stderr.write('[w2-op-worker] W2_API_URL, W2_WORKER_TOKEN and W2_TMP_DIR are required\n')
  process.exit(2)
}

const model = tinyMaskModel(320)
const modelPath = join(tmpDir, 'tiny-u2netp-shape.onnx')
writeFileSync(modelPath, model)
const modelSha256 = createHash('sha256').update(model).digest('hex')

const options = { baseUrl: apiUrl, token, workerId: 'e2e-w2-ops', requestTimeoutMs: 10_000 }
const api = createWorkerApi(options)
const ops = createWorkerOpsApi(createApiCall(options))
const runner = createRemoveBgRunner({ modelPath: () => modelPath, modelSha256 })
const stop = new AbortController()
const log = (line: string) => process.stdout.write(`[w2-op-worker] ${line}\n`)
process.on('SIGTERM', () => stop.abort())
process.stdin.on('end', () => stop.abort())
process.stdin.resume()

let asked = 0
while (!stop.signal.aborted) {
  try {
    const out = await runOneOp({
      ops,
      api,
      capabilities: [WORKER_CAPABILITIES['remove-bg']],
      runners: { 'remove-bg': runner },
      tmpDir,
      signal: stop.signal,
      log: () => {},
    })
    asked++
    if (asked === 1) log('asked')
    if (out.kind !== 'none') log(`${out.kind}${'code' in out ? ` ${out.code}` : ''}`)
  } catch (e) {
    log(`error ${(e as Error).name}`)
  }
  await new Promise((r) => setTimeout(r, 150))
}
log('stopped')
process.exit(0)
