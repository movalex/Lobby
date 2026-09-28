// AIPV-05 on a real Postgres: PUT /api/workspaces/:wid/ai/settings reads the previous default, writes
// the new one and publishes a hint only when it flipped. Outside one serialized transaction, admins
// changing it at once all read the old value before any of them commits, and all publish. Opt-in like
// apps/api/test/concurrency.pg.test.ts: set DRAFTROOM_TEST_DATABASE_URL (a database these tests may
// create and drop schemas in) to run it; skipped otherwise. DRAFTROOM_PG_STRESS_ITER sets the rounds.

import { AI_SETTINGS_EVENT } from '@draftroom/contracts'
import { describe, expect, it } from 'vitest'
import { EventHub } from '../../../src/events/hub.ts'
import { createBoard, createTestApi, DEV_STUDIO } from '../../helpers.ts'

const PG_URL = process.env.DRAFTROOM_TEST_DATABASE_URL ?? ''
const ITER = Number(process.env.DRAFTROOM_PG_STRESS_ITER ?? 5)
const url = `/api/workspaces/${DEV_STUDIO}/ai/settings`

describe.skipIf(!PG_URL)('AI workspace default on real Postgres (DRAFTROOM_TEST_DATABASE_URL)', () => {
  it('simultaneous identical changes: exactly one flips the default and publishes', async () => {
    const hub = new EventHub()
    const api = await createTestApi({ deps: { events: hub } })
    try {
      const alice = await api.login('alice')
      const board = await createBoard(alice, DEV_STUDIO, 'Follows the default')
      let hints = 0
      hub.subscribe(board, (e) => {
        if (e.type === AI_SETTINGS_EVENT) hints++
      })
      for (let i = 0; i < ITER; i++) {
        const enabled = i % 2 === 1 // flips every round: the first PUT of a round changes it
        hints = 0
        const res = await Promise.all(Array.from({ length: 8 }, () => alice.req('PUT', url, { enabled })))
        for (const r of res) expect(r.statusCode, r.body).toBe(200)
        expect(hints, `round ${i}`).toBe(1)
      }
    } finally {
      await api.close()
    }
  })
})
