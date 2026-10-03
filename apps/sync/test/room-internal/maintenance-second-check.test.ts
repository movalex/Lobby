// OPEN16 (CR-W5-FIX-1): the router refuses a board-writing internal POST on entry while maintenance is on,
// but a POST whose body is still arriving when maintenance goes on passed that check. The room's write
// paths now ask again once the body is read (ElementRoomDeps.maintenance, wired in app.ts): the seed's
// direct write (no room yet) and the room's queued server write (place-notes, restore, the test hook) both
// answer 503 MAINTENANCE and write nothing. Against the REAL sync server process, a slow body by hand.
import { existsSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'
import { INTERNAL_SECRET_HEADER } from '@draftroom/auth-tickets'
import { describe, expect, it } from 'vitest'
import { boardDbPath } from '../../src/rooms.ts'
import { rect } from '../element-room/support/elements.ts'
import { type ElementStack, newBoardId, useElementHarness } from '../element-room/support/stack.ts'
import { TEST_INTERNAL_SECRET } from '../harness/tickets.ts'
import { call, seed } from './support.ts'

const h = useElementHarness()
const T = 60_000

/**
 * A POST whose body arrives in two halves: the first one now, the second once `between` resolved. Resolves
 * with the status and the error code of the answer.
 */
function slowPost(
  st: ElementStack,
  path: string,
  body: unknown,
  between: () => Promise<unknown>,
): Promise<{ status: number; code: string | null }> {
  const text = Buffer.from(JSON.stringify(body), 'utf8')
  const half = Math.floor(text.length / 2)
  const url = new URL(path, st.server.url)
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          [INTERNAL_SECRET_HEADER]: TEST_INTERNAL_SECRET,
          'content-type': 'application/json',
          'content-length': String(text.length),
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          let code: string | null = null
          try {
            code = (JSON.parse(raw) as { error?: { code?: string } }).error?.code ?? null
          } catch {
            code = null
          }
          resolve({ status: res.statusCode ?? 0, code })
        })
      },
    )
    req.on('error', reject)
    req.write(text.subarray(0, half))
    // the router's entry check has run once the first bytes are in: maintenance goes on, then the rest
    setTimeout(() => {
      between().then(
        () => req.end(text.subarray(half)),
        (e) => {
          req.destroy()
          reject(e)
        },
      )
    }, 300)
  })
}

const maintenanceOn = (st: ElementStack) => call(st, 'POST', '/internal/maintenance', { on: true })

describe('OPEN16: maintenance is checked again after a write body is read', () => {
  it(
    'a seed whose body was still arriving when maintenance went on is refused 503 MAINTENANCE; no file is made',
    async () => {
      const dataDir = h.dataDir()
      const st = await h.stack({ dataDir })
      const b = newBoardId()
      const body = { format: 'lobby-elements', elements: [rect('s1', { index: 'a0' })], doc: {} }
      const r = await slowPost(st, `/internal/boards/${b}/seed`, body, () => maintenanceOn(st))
      expect(r).toEqual({ status: 503, code: 'MAINTENANCE' })
      expect(existsSync(boardDbPath(join(dataDir, 'rooms'), b))).toBe(false)
      // off again: the same seed lands (the refusal was the window, not the body)
      expect((await call(st, 'POST', '/internal/maintenance', { on: false })).status).toBe(200)
      expect((await seed(st, b, body.elements)).status).toBe(201)
    },
    T,
  )

  it(
    "a server write queued to an open board's room (the test hook) is refused the same way; nothing lands",
    async () => {
      const st = await h.stack()
      const b = newBoardId()
      expect((await seed(st, b, [rect('s1', { index: 'a0' })])).status).toBe(201)
      // the board's room is open (a session on it)
      const a = await st.client({ boardId: b, user: 'alice' })
      const clock = a.clock
      const r = await slowPost(
        st,
        `/internal/test/boards/${b}/server-write`,
        { put: [rect('sw1', { index: 'a1' })] },
        () => maintenanceOn(st),
      )
      expect(r).toEqual({ status: 503, code: 'MAINTENANCE' })
      const snap = await st.snapshot(b)
      expect(snap.elements.map((e) => e.id)).toEqual(['s1'])
      expect(snap.clock).toBe(clock)
    },
    T,
  )
})
