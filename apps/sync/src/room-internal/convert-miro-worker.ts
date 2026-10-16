// The Miro seed conversion worker's entry (./convert-miro.ts starts ONE fresh `new Worker(this file, { workerData,
// resourceLimits })` per conversion and terminates it when it is done or over its time). It posts one answer and
// exits. It never logs, and its answer carries the converted elements, the board document's values and the report
// (ids, counts and codes) only.
import { parentPort, workerData } from 'node:worker_threads'
import { installedServerTextMetrics, installServerTextMetrics } from '@draftroom/canvas-schema/engine'
import { convertMiroBoard, type MiroSeedBody } from '@draftroom/miro-import'
import type { ConvertedMiroSeed, MiroWorkerInput, MiroWorkerOutput } from './convert-miro.ts'

function run({ json, now, maxResultBytes }: MiroWorkerInput): MiroWorkerOutput {
  const started = performance.now()
  const body = JSON.parse(json) as MiroSeedBody
  if (!installedServerTextMetrics()) installServerTextMetrics()
  const out = convertMiroBoard(body, { now })
  const converted: ConvertedMiroSeed = {
    elements: out.elements as unknown as Record<string, unknown>[],
    doc: out.doc,
    report: out.report,
  }
  const text = JSON.stringify(converted)
  if (Buffer.byteLength(text) > maxResultBytes) return { ok: false, reason: 'result-too-large' }
  return { ok: true, json: text, conversionMs: Math.round(performance.now() - started) }
}

if (parentPort) {
  try {
    parentPort.postMessage(run(workerData as MiroWorkerInput))
  } catch (e) {
    // a converter bug: the error's NAME only (never its message, which could quote the board)
    const cause = typeof (e as Error | null)?.name === 'string' ? (e as Error).name.slice(0, 64) : undefined
    parentPort.postMessage({
      ok: false,
      reason: 'failed',
      ...(cause ? { cause } : {}),
    } satisfies MiroWorkerOutput)
  }
}
