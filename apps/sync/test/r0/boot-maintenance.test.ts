// Open item 11 (docs/EXCALIDRAW-MIGRATION.md, §7.5 step 6 and rollback step 2; wave 5, 2A): a sync server
// started with DRAFTROOM_BOOT_MAINTENANCE=1 is in maintenance from its first second (every socket refused
// 4099 MAINTENANCE, internal reads working), and POST /internal/maintenance {on: false} ends it. R0's
// switch alone is a runtime POST, so a build deployed into the window started serving. Also R0's
// contracts: GET /internal/canvas tells the api which canvas this server runs. Both engines. Failed on
// f336ae4 (the server started with maintenance off; /internal/canvas was 404).
import { describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { loadConfig } from '../../src/config.ts'
import { ticketFor } from '../element-room/support/client.ts'
import { note } from '../element-room/support/elements.ts'
import { newBoardId, useElementHarness } from '../element-room/support/stack.ts'
import { boardSocketTarget, callInternal } from '../harness/tickets.ts'

const T = 120_000

/** Opens a socket and reports how it closed (or `open` when it is still open after 1.5 s). */
/** Opens a board socket at `url` with `ticket` in the offered subprotocol (as browsers send it, L7). */
const tryConnect = (wsUrl: string, url: string, ticket: string) =>
  new Promise<{ code: number; reason: string } | 'open'>((resolve, reject) => {
    const target = boardSocketTarget(`${wsUrl}${url}`, ticket)
    const ws = new WebSocket(target.url, target.protocols)
    const timer = setTimeout(() => {
      ws.terminate()
      resolve('open')
    }, 1_500)
    ws.on('close', (code, reason) => {
      clearTimeout(timer)
      resolve({ code, reason: String(reason) })
    })
    ws.on('error', reject)
  })

const json = async (res: Response) => (await res.json()) as Record<string, unknown>

describe('DRAFTROOM_BOOT_MAINTENANCE', () => {
  it('is 1 or 0', () => {
    const base = {
      DRAFTROOM_TICKET_SECRET: 'a'.repeat(40),
      DRAFTROOM_INTERNAL_SECRET: 'b'.repeat(40),
      DRAFTROOM_DATA_DIR: './.data-config-test',
    }
    expect(loadConfig(base).bootMaintenance).toBe(false)
    expect(loadConfig({ ...base, DRAFTROOM_BOOT_MAINTENANCE: '0' }).bootMaintenance).toBe(false)
    expect(loadConfig({ ...base, DRAFTROOM_BOOT_MAINTENANCE: '1' }).bootMaintenance).toBe(true)
    expect(() => loadConfig({ ...base, DRAFTROOM_BOOT_MAINTENANCE: 'yes' })).toThrow(/BOOT_MAINTENANCE/)
  })

  const eh = useElementHarness()
  it(
    'the Excalidraw build starts in maintenance, reads keep working, and the POST ends it',
    async () => {
      const st = await eh.stack({ env: { DRAFTROOM_BOOT_MAINTENANCE: '1' } })
      expect(await json(await callInternal(st.server.url, 'GET', '/internal/maintenance'))).toEqual({
        maintenance: true,
      })
      expect(await json(await callInternal(st.server.url, 'GET', '/internal/canvas'))).toEqual({
        engine: 'excalidraw',
      })
      const b = newBoardId()
      expect(await tryConnect(st.server.wsUrl, `/connect/${b}?sessionId=t1`, ticketFor(b, 'alice'))).toEqual({
        code: 4099,
        reason: 'MAINTENANCE',
      })
      const off = await callInternal(st.server.url, 'POST', '/internal/maintenance', { body: { on: false } })
      expect(await json(off)).toEqual({ maintenance: false, closedSockets: 0 })
      const a = await st.client({ boardId: b, user: 'alice' })
      expect((await a.create([note('n1')])).r[0]).toMatchObject({ ok: true })
    },
    T,
  )
})
