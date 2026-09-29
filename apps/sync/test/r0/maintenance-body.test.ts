// Bridge release R0 (docs/EXCALIDRAW-MIGRATION.md §7.5 steps 3 and 4): a board-writing internal request
// whose body is still arriving when maintenance goes on is refused once its body is read (503
// MAINTENANCE), so it can land neither after maintenance started nor after the final run-all backup. The
// router's check on entry alone let it through (verifier, maint-toctou).

import { existsSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'
import { INTERNAL_SECRET_HEADER } from '@draftroom/auth-tickets'
import { draftroomSchema } from '@draftroom/canvas-schema'
import { describe, expect, it } from 'vitest'
import type { RunAllReport } from '../../src/backup/run-all.ts'
import { boardDbPath } from '../../src/rooms.ts'
import { newBoardId, useProtocolHarness } from '../harness/fixture.ts'
import { geoShape } from '../harness/records.ts'
import { callInternal, TEST_INTERNAL_SECRET } from '../harness/tickets.ts'

/** A POST whose first half is sent now; finish() sends the rest and resolves with the answer. */
function halfSent(baseUrl: string, path: string, body: unknown) {
  const json = JSON.stringify(body)
  const bytes = Buffer.from(json)
  const req = request(new URL(path, baseUrl), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': String(bytes.length),
      [INTERNAL_SECRET_HEADER]: TEST_INTERNAL_SECRET,
    },
  })
  const answer = new Promise<{ status: number; body: string }>((resolve, reject) => {
    req.on('response', (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (c: string) => {
        text += c
      })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }))
    })
    req.on('error', reject)
  })
  const cut = Math.floor(bytes.length / 2)
  req.write(bytes.subarray(0, cut))
  return {
    async finish() {
      req.end(bytes.subarray(cut))
      return answer
    },
  }
}

const settle = () => new Promise((r) => setTimeout(r, 150))
const codeOf = (body: string) => (JSON.parse(body) as { error?: { code?: string } }).error?.code

describe('maintenance goes on while a board-writing body is still arriving', () => {
  const h = useProtocolHarness()

  it('deleted/restore, seed and place-notes answer 503 MAINTENANCE and write nothing', async () => {
    const server = await h.server({ env: { DRAFTROOM_BACKUP_STORE: 'fs' } })
    const board = newBoardId()
    const a = await h.connected(server, { boardId: board, user: 'usr_alice', autoReconnect: false })
    a.put(geoShape('victim'))
    await a.waitForAcked()
    a.remove('shape:victim')
    await a.waitForAcked()
    const fresh = newBoardId()

    const restore = halfSent(server.url, `/internal/boards/${board}/deleted/restore`, {
      ids: ['shape:victim'],
    })
    const seed = halfSent(server.url, `/internal/boards/${fresh}/seed`, {
      snapshot: { schema: draftroomSchema.serialize(), documents: [] },
    })
    const place = halfSent(server.url, `/internal/boards/${board}/place-notes`, {
      sessionId: 'pbs_0000000003',
      anonymous: true,
      frame: { id: 'shape:f', pageId: 'page:page', x: 0, y: 0, w: 400, h: 300, name: 'Ideas' },
      notes: [{ id: 'pnt_0000000003', text: 'late', color: 'yellow', authorId: null }],
      authors: [],
    })
    await settle() // every first half is at the server, its handler waiting for the rest

    const on = await callInternal(server.url, 'POST', '/internal/maintenance', { body: { on: true } })
    expect(on.status).toBe(200)
    const runAll = await callInternal(server.url, 'POST', '/internal/backups/run-all')
    const report = (await runAll.json()) as RunAllReport
    expect(report.boards.map((b) => b.boardId)).toEqual([board])

    for (const [what, pending] of [
      ['deleted/restore', restore],
      ['seed', seed],
      ['place-notes', place],
    ] as const) {
      const got = await pending.finish()
      expect({ what, status: got.status, code: codeOf(got.body) }).toEqual({
        what,
        status: 503,
        code: 'MAINTENANCE',
      })
    }
    // nothing reached a board after the final backup
    const snap = await callInternal(server.url, 'GET', `/internal/boards/${board}/snapshot`)
    const ids = ((await snap.json()) as { documents: Array<{ state: { id: string } }> }).documents.map(
      (d) => d.state.id,
    )
    expect(ids).not.toContain('shape:victim')
    expect(ids.some((id) => id.startsWith('shape:pnt_'))).toBe(false)
    expect(ids).toHaveLength(report.boards[0]?.recordCount ?? -1)
    expect(existsSync(boardDbPath(join(server.dataDir, 'rooms'), fresh))).toBe(false)
    a.dispose()
  })
})
