// Bridge release R0 (docs/EXCALIDRAW-MIGRATION.md §7.5 step 4): every POST /internal/backups/run-all answer
// comes from a run that started after the call. A call made while an earlier run is still going (an
// operator's check started before maintenance went on) used to get that run's report: ok:true, with
// backups taken before the last edits (verifier, runall-coalesce). It now waits and gets the next run,
// shared by every call made meanwhile, and the report says whether maintenance was on throughout.
import { describe, expect, it } from 'vitest'
import type { BackupEntry } from '../../src/backup/backup.ts'
import { offsiteOffStatus } from '../../src/backup/offsite.ts'
import { createRunAll, type RunAllReport } from '../../src/backup/run-all.ts'

const tick = () => new Promise((r) => setTimeout(r, 0))

function harness() {
  let t = Date.UTC(2026, 9, 5, 12)
  const now = () => {
    t += 1000
    return new Date(t)
  }
  const gates: Array<() => void> = []
  const calls: Array<{ boardId: string; at: number; holdUntil: string | null }> = []
  let maintenance = false
  const runAll = createRunAll({
    registry: {
      boardFileIds: () => ['b-one', 'b-two'],
      async backupFresh(boardId, opts) {
        const at = now().getTime()
        calls.push({ boardId, at, holdUntil: opts?.holdUntil?.toISOString() ?? null })
        await new Promise<void>((r) => gates.push(r))
        const entry: BackupEntry = {
          file: `2026-10-05T12-00-00-000Z-c${calls.length}.sqlite`,
          boardId,
          createdAt: new Date(at).toISOString(),
          documentClock: calls.length,
          schema: {},
          recordCount: 1,
          recordsSha256: 'a'.repeat(64),
          sha256: 'b'.repeat(64),
          sizeBytes: 1,
          ...(opts?.holdUntil ? { holdUntil: opts.holdUntil.toISOString() } : {}),
        }
        return entry
      },
    },
    backups: { status: offsiteOffStatus, copyOffsite: async () => null },
    maintenance: () => maintenance,
    now,
  })
  /** Lets every backup through until all of `runs` settled. */
  async function drain(...runs: Promise<RunAllReport>[]) {
    let done = false
    void Promise.allSettled(runs).then(() => {
      done = true
    })
    while (!done) {
      await tick()
      gates.shift()?.()
    }
    return Promise.all(runs)
  }
  return {
    runAll,
    calls,
    drain,
    setMaintenance(on: boolean) {
      maintenance = on
    },
  }
}

describe('run-all answers only with a run that started after the call', () => {
  it('a call during a run waits for it and gets the next one, shared by every call meanwhile', async () => {
    const h = harness()
    const first = h.runAll.run()
    await tick() // the first run is backing up b-one
    expect(h.calls.map((c) => c.boardId)).toEqual(['b-one'])
    h.setMaintenance(true)
    const second = h.runAll.run()
    const third = h.runAll.run()
    expect(third).toBe(second)
    expect(h.runAll.running()).toBe(true)
    const [a, b] = (await h.drain(first, second)) as [RunAllReport, RunAllReport]
    // two runs, one after the other, each backing up every board
    expect(h.calls.map((c) => c.boardId)).toEqual(['b-one', 'b-two', 'b-one', 'b-two'])
    expect(Date.parse(b.startedAt)).toBeGreaterThan(Date.parse(a.finishedAt))
    expect(a.inMaintenance).toBe(false)
    expect(b.inMaintenance).toBe(true)
    expect(a.boards.map((r) => r.documentClock)).toEqual([1, 2])
    expect(b.boards.map((r) => r.documentClock)).toEqual([3, 4])
    expect(h.runAll.running()).toBe(false)
    // idle again: a call starts a run at once
    const fourth = h.runAll.run()
    await tick()
    expect(h.calls).toHaveLength(5)
    await h.drain(fourth)
  })

  it('every backup is held 90 days; inMaintenance needs maintenance from start to end', async () => {
    const h = harness()
    h.setMaintenance(true)
    const run = h.runAll.run()
    await tick()
    h.setMaintenance(false) // switched off while the run goes on
    const [report] = (await h.drain(run)) as [RunAllReport]
    expect(report.inMaintenance).toBe(false)
    for (const [i, c] of h.calls.entries()) {
      expect(c.holdUntil).toBe(new Date(Date.parse(report.startedAt) + 90 * 86_400_000).toISOString())
      expect(report.boards[i]?.holdUntil).toBe(c.holdUntil)
    }
  })
})
