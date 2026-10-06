// The v1 conversion worker's entry (./convert-v1.ts starts ONE fresh `new Worker(this file, { workerData,
// resourceLimits })` per conversion and terminates it when it is done or over its time). It posts one answer
// and exits. It never logs, and its answer carries the converted elements and counts only.
import { parentPort, workerData } from 'node:worker_threads'
import { installedServerTextMetrics, installServerTextMetrics } from '@draftroom/canvas-schema/engine'
import { convertBoard, lossyCounts, migrateRecords, type TlRecord } from '@draftroom/tldraw-import'
import type { ConvertedV1, WorkerInput, WorkerOutput } from './convert-v1.ts'

function run({ json, now, maxResultBytes }: WorkerInput): WorkerOutput {
  const started = performance.now()
  const { records, schema } = JSON.parse(json) as { records: unknown[]; schema: unknown }
  const migrated = migrateRecords(records, schema)
  if (!migrated.ok) return { ok: false, reason: 'unreadable', detail: migrated.reason }
  const metrics = installedServerTextMetrics() ?? installServerTextMetrics()
  const conv = convertBoard(migrated.records as TlRecord[], { updatedAt: now, metrics })
  if (conv.failures.length)
    return { ok: false, reason: 'failed', detail: [...new Set(conv.failures.map((f) => f.code))].join(', ') }
  const converted: ConvertedV1 = {
    elements: conv.elements as unknown as Record<string, unknown>[],
    doc: {
      ...(conv.doc.startView ? { startView: conv.doc.startView } : {}),
      ...(conv.doc.workshop ? { workshop: conv.doc.workshop } : {}),
      tagDefs: conv.doc.tagDefs,
    },
    legacyPages: Object.fromEntries(
      Object.entries(conv.legacyPages).map(([id, p]) => [
        id,
        { dx: p.dx, dy: p.dy, index: p.index, name: p.name },
      ]),
    ),
    legacyIds: conv.legacyIds,
    lossy: lossyCounts(conv.lossy),
  }
  const out = JSON.stringify(converted)
  if (Buffer.byteLength(out) > maxResultBytes) return { ok: false, reason: 'result-too-large' }
  return { ok: true, json: out, conversionMs: Math.round(performance.now() - started) }
}

if (parentPort) {
  try {
    parentPort.postMessage(run(workerData as WorkerInput))
  } catch (e) {
    // a converter bug: no detail (nothing of the board in it), the caller answers as for any failure; the
    // error's NAME (never its message, which could quote the board) is the cause the caller may log
    const cause = typeof (e as Error | null)?.name === 'string' ? (e as Error).name.slice(0, 64) : undefined
    parentPort.postMessage({
      ok: false,
      reason: 'failed',
      ...(cause ? { cause } : {}),
    } satisfies WorkerOutput)
  }
}
