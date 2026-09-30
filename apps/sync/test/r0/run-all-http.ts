// POST /internal/backups/run-all as the runbook's CLI makes it (backup/run-all-cli.ts): the POST answers
// at once with 202 and the run's id, and GET /internal/backups/run-all/<runId> has the report once the
// run is done. For the tests that need a report from a real sync process.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect } from 'vitest'
import type { RunAllReport, RunAllRunView } from '../../src/backup/run-all.ts'
import { callInternal, TEST_INTERNAL_SECRET } from '../harness/tickets.ts'

const CLI = fileURLToPath(new URL('../../src/backup/run-all-cli.ts', import.meta.url))

/** Runs the runbook command (backup/run-all-cli.ts) with the test secret; its exit code and output. */
export function runCli(
  args: string[],
  env: Record<string, string | undefined> = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const { PORT: _port, DRAFTROOM_INTERNAL_SECRET: _secret, ...rest } = process.env
  const child = spawn(process.execPath, [CLI, ...args], {
    env: { ...rest, DRAFTROOM_INTERNAL_SECRET: TEST_INTERNAL_SECRET, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (d: string) => {
    stdout += d
  })
  child.stderr.setEncoding('utf8').on('data', (d: string) => {
    stderr += d
  })
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, stdout, stderr }))
  })
}

/** Starts a run (202) and returns its first view. */
export async function startRunAll(baseUrl: string): Promise<RunAllRunView> {
  const res = await callInternal(baseUrl, 'POST', '/internal/backups/run-all')
  expect(res.status).toBe(202)
  const view = (await res.json()) as RunAllRunView
  expect(res.headers.get('location')).toBe(`/internal/backups/run-all/${view.runId}`)
  expect(view).not.toHaveProperty('report')
  return view
}

/** Polls the run until it is done (or failed) and returns its last view. */
export async function waitForRun(baseUrl: string, runId: string, timeoutMs = 60_000): Promise<RunAllRunView> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const res = await callInternal(baseUrl, 'GET', `/internal/backups/run-all/${runId}`)
    expect(res.status).toBe(200)
    const view = (await res.json()) as RunAllRunView
    if (view.status === 'done' || view.status === 'failed') return view
    if (Date.now() > deadline) throw new Error(`run ${runId} still ${view.status} after ${timeoutMs} ms`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

/** A whole run over HTTP: its report (the run must end done). */
export async function runAllOverHttp(baseUrl: string): Promise<RunAllReport> {
  const started = await startRunAll(baseUrl)
  const view = await waitForRun(baseUrl, started.runId)
  expect(view.status, view.error).toBe('done')
  return view.report as RunAllReport
}
