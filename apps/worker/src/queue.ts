// Worker-side queue operation missing from @draftroom/dev-assets: hand a claimed job back.
import { randomBytes } from 'node:crypto'
import { renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { ClaimedJob, DataLayout } from '@draftroom/dev-assets'

/**
 * Returns a claim to queued/ with the given attempt number. The queued file is written (tmp+rename)
 * BEFORE the claim is dropped, so a crash in between leaves a duplicate (harmless: the job is
 * idempotent) rather than losing the job.
 */
export function releaseJob(l: DataLayout, c: ClaimedJob, attempt: number) {
  const name = basename(c.path)
  const tmp = join(l.jobs.queued, `.${name}.${randomBytes(4).toString('hex')}.tmp`)
  writeFileSync(tmp, JSON.stringify({ ...c.job, attempt }))
  try {
    renameSync(tmp, join(l.jobs.queued, name))
  } catch (e) {
    rmSync(tmp, { force: true })
    throw e
  }
  rmSync(c.path, { force: true })
}
