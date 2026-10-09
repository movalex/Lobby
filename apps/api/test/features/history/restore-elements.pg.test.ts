// The selective restore (wave L, L7-2) on a real Postgres: two restore requests on one board at once both get
// their own 'before_restore' checkpoint first, and their writes reach the sync one after the other. Opt-in like
// apps/api/test/concurrency.pg.test.ts: set DRAFTROOM_TEST_DATABASE_URL (a database these tests may create and
// drop schemas in) to run it; skipped otherwise. The same scenario runs on PGlite in restore-elements.test.ts.

import { describe, it } from 'vitest'
import { createTestApi } from '../../helpers.ts'
import { RestoreSync, restoreWorld, twoRestoresAtOnce } from './restore-support.ts'

const PG_URL = process.env.DRAFTROOM_TEST_DATABASE_URL ?? ''

describe.skipIf(!PG_URL)('selective restore on real Postgres (DRAFTROOM_TEST_DATABASE_URL)', () => {
  it('two restores at once: both checkpointed first, writes serialized', async () => {
    const sync = new RestoreSync()
    const api = await createTestApi({ deps: { syncInternal: sync } })
    try {
      await twoRestoresAtOnce(await restoreWorld(api, sync))
    } finally {
      await api.close()
    }
  })
})
