// The conversion worker's entry (docs/EXCALIDRAW-MIGRATION.md §5.3 "Where it runs", §2.13). The queue
// (queue.ts) starts ONE fresh `new Worker(this file, { workerData, resourceLimits })` per job, so a board
// that hits the heap cap is terminated by Node (`ERR_WORKER_OUT_OF_MEMORY`) with only its own worker;
// the sync process and its rooms keep running. The worker posts one result and exits.
//
// It never logs board content: its only output is the report (ids, counts, codes, timings, bytes).

import { parentPort, workerData } from 'node:worker_threads'
import { createTableTextMetrics, installServerTextMetrics } from '@draftroom/canvas-schema/engine'
import { type ConvertJob, convertBoardFile } from './convert-board.ts'
import { type DropLegacyJob, dropLegacyBoardFile } from './drop-legacy.ts'
import { type RollForwardJob, rollForwardBoardFile } from './rollforward.ts'

/** Test-only jobs (the queue's own tests; refused unless the queue allows them): exhaust the heap, spin, succeed. */
export interface TestJob {
  readonly kind: 'test-oom' | 'test-spin' | 'test-ok'
  readonly boardId: string
}

export type MigrateJob = ConvertJob | RollForwardJob | DropLegacyJob | TestJob

export interface WorkerInput {
  readonly job: MigrateJob
  readonly allowTestJobs: boolean
}

function runTest(job: TestJob): unknown {
  if (job.kind === 'test-ok') return { kind: 'test-ok', boardId: job.boardId, ok: true }
  if (job.kind === 'test-spin') for (;;) {}
  const hold: string[][] = []
  for (;;) hold.push(Array.from({ length: 100_000 }, (_, i) => `row-${i}-${hold.length}`))
}

function run({ job, allowTestJobs }: WorkerInput): unknown {
  if (job.kind === 'convert') return convertBoardFile(job, installServerTextMetrics(createTableTextMetrics()))
  if (job.kind === 'rollforward')
    return rollForwardBoardFile(job, installServerTextMetrics(createTableTextMetrics()))
  if (job.kind === 'drop-legacy') return dropLegacyBoardFile(job)
  if (!allowTestJobs) throw new Error('test jobs are not allowed')
  return runTest(job)
}

if (parentPort) parentPort.postMessage(run(workerData as WorkerInput))
