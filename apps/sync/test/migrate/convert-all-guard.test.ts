// Security audit L6 (wave 4b, 2B): `POST /internal/migrate/convert-all` rewrites every tldraw board file,
// so the real Excalidraw sync refuses it while maintenance is off (409 MAINTENANCE_REQUIRED) unless the
// body says {"confirm": true}; inside the maintenance window (the runbook's C10) it runs as before. On
// 747d41d the route started a run on any POST.
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { boardFileState } from '../../src/room/migrate/service.ts'
import { newBoardId, useElementHarness } from '../element-room/support/stack.ts'
import { callInternal, errorCode } from '../harness/tickets.ts'
import { fixtureRecords, seedBoardRecords } from './board-files.ts'

const h = useElementHarness()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitIdle(url: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const res = await callInternal(url, 'GET', '/internal/migrate/status')
    const s = (await res.json()) as { convertAll: string; running: string | null; queued: string[] }
    if (s.convertAll === 'idle' && s.running === null && s.queued.length === 0) return s
    if (Date.now() > deadline) throw new Error(`convert-all still running after ${timeoutMs} ms`)
    await sleep(50)
  }
}

describe('POST /internal/migrate/convert-all needs maintenance on, or {"confirm": true}', () => {
  it('refuses while maintenance is off, takes a confirmation, runs inside the window', {
    timeout: 120_000,
  }, async () => {
    const dataDir = h.dataDir()
    const rooms = join(dataDir, 'rooms')
    const boardId = newBoardId()
    const path = seedBoardRecords(rooms, boardId, fixtureRecords('brainstorm'))
    const st = await h.stack({ dataDir })
    const url = st.server.url

    // maintenance off: refused, nothing converted
    const refused = await callInternal(url, 'POST', '/internal/migrate/convert-all')
    expect(refused.status).toBe(409)
    expect(await errorCode(refused)).toBe('MAINTENANCE_REQUIRED')
    expect(
      await errorCode(await callInternal(url, 'POST', '/internal/migrate/convert-all', { body: {} })),
    ).toBe('MAINTENANCE_REQUIRED')
    expect(
      await errorCode(
        await callInternal(url, 'POST', '/internal/migrate/convert-all', { body: { confirm: false } }),
      ),
    ).toBe('MAINTENANCE_REQUIRED')
    // a malformed body is a 400, not a run
    expect(
      await errorCode(
        await callInternal(url, 'POST', '/internal/migrate/convert-all', { body: { yes: true } }),
      ),
    ).toBe('BAD_REQUEST')
    expect(
      await errorCode(
        await callInternal(url, 'POST', '/internal/migrate/convert-all', { body: { confirm: 'yes' } }),
      ),
    ).toBe('BAD_REQUEST')
    await waitIdle(url)
    expect(boardFileState(path)).toBe('tldraw')

    // confirmed: runs with maintenance off
    const confirmed = await callInternal(url, 'POST', '/internal/migrate/convert-all', {
      body: { confirm: true },
    })
    expect(confirmed.status).toBe(202)
    await waitIdle(url)
    expect(boardFileState(path)).toBe('converted')

    // inside the maintenance window: the runbook's bare POST
    expect((await callInternal(url, 'POST', '/internal/maintenance', { body: { on: true } })).status).toBe(
      200,
    )
    const inWindow = await callInternal(url, 'POST', '/internal/migrate/convert-all')
    expect(inWindow.status).toBe(202)
    await waitIdle(url)
    // the runbook's `int` helper: a JSON content-type with an empty body is no body
    const helperShaped = await callInternal(url, 'POST', '/internal/migrate/convert-all', { rawBody: '' })
    expect(helperShaped.status).toBe(202)
    await waitIdle(url)
  })
})
