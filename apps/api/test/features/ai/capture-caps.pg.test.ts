// Wave N (WS5, N5-1) on a real Postgres: the per-day photo cap holds when one person sends 12 photos at once (the
// reservations run on separate pool connections, decided one at a time under the ledger's advisory lock): exactly 10
// are accepted, 2 get 429 AI_CAPTURE_DAILY_CAP, and the ledger holds 10 rows. PGlite serializes every statement, so
// capture.test.ts cannot show that; this can. Opt-in like apps/api/test/concurrency.pg.test.ts: set
// DRAFTROOM_TEST_DATABASE_URL (a database these tests may create and drop schemas in) to run it; skipped otherwise.

import { CAPTURE_ERROR_CODES } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import { captureRows, captureWorld, postPhoto } from './capture-support.ts'
import { expectError } from './support.ts'

const PG_URL = process.env.DRAFTROOM_TEST_DATABASE_URL ?? ''
const ITER = Number(process.env.DRAFTROOM_PG_STRESS_ITER ?? 3)

describe.skipIf(!PG_URL)('Capture the room caps on real Postgres (DRAFTROOM_TEST_DATABASE_URL)', () => {
  it('12 parallel photos from one person: 10 accepted, 2 refused by the day’s cap', async () => {
    for (let round = 0; round < ITER; round++) {
      const w = await captureWorld({ inFlight: { user: 20, workspace: 20, total: 20 } })
      try {
        const res = await Promise.all(Array.from({ length: 12 }, () => postPhoto(w, w.alice.cookie, w.board)))
        const ok = res.filter((r) => r.statusCode === 200)
        const refused = res.filter((r) => r.statusCode !== 200)
        expect(ok, `round ${round}`).toHaveLength(10)
        expect(refused).toHaveLength(2)
        for (const r of refused) expectError(r, 429, CAPTURE_ERROR_CODES.dailyCap)
        expect(await captureRows(w.api)).toHaveLength(10)
        expect(w.openai.requests).toHaveLength(10)
      } finally {
        await w.close()
      }
    }
  })
})
