// The Excalidraw sync process keeps backups of its boards (2B; R0's contracts 3 and 4): a real server
// with DRAFTROOM_ENGINE=excalidraw (backups off offsite, as every test stack). Before, its periodic pass
// never backed up an element board (the tldraw registry backs up only the rooms it opens, and with this
// engine it opens none), and run-all described a converted board by its tldraw tables. Failed on f336ae4.
import { describe, expect, it } from 'vitest'
import { readManifest } from '../../src/backup/backup.ts'
import { rect } from '../element-room/support/elements.ts'
import { newBoardId, useElementHarness } from '../element-room/support/stack.ts'
import { fixtureRecords, seedBoardRecords } from '../migrate/board-files.ts'
import { runAllOverHttp } from '../r0/run-all-http.ts'

const h = useElementHarness()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('the Excalidraw sync backs up its boards', () => {
  it('the periodic pass copies a board edited on this build, and run-all holds one of every board', {
    timeout: 120_000,
  }, async () => {
    const dataDir = h.dataDir()
    const converted = newBoardId()
    seedBoardRecords(`${dataDir}/rooms`, converted, fixtureRecords('retrospective'))
    const born = newBoardId()
    const st = await h.stack({ dataDir, env: { DRAFTROOM_BACKUP_INTERVAL_MS: '1000' } })
    // converted on open, then edited; a board made on this build
    const a = await st.client({ boardId: converted, user: 'alice', tab: 'a' })
    await a.create([rect('xbk-r1', { x: 10, y: 10 })])
    const b = await st.client({ boardId: born, user: 'alice', tab: 'b' })
    await b.create([rect('xbk-r2', { x: 10, y: 10 })])
    const deadline = Date.now() + 20_000
    const formats = () =>
      [converted, born].map((id) => readManifest(`${dataDir}/backups`, id)?.backups.at(-1)?.format ?? null)
    while (Date.now() < deadline && formats().includes(null)) await sleep(250)
    expect(formats()).toEqual(['lobby-elements-converted', 'lobby-elements'])
    const report = await runAllOverHttp(st.server.url)
    expect(report.ok).toBe(true)
    const rows = new Map(report.boards.map((r) => [r.boardId, r]))
    expect(rows.get(converted)?.format).toBe('lobby-elements-converted')
    expect(rows.get(born)?.format).toBe('lobby-elements')
    for (const r of rows.values())
      expect(Date.parse(String(r.holdUntil))).toBeGreaterThan(Date.now() + 89 * 86_400_000)
    a.close()
    b.close()
  })
})
