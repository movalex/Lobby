// Wave M (M7-3, S5) in the ElementRoom service (in process): a laser stroke and a note with words on a board,
// then the service closes (what a deploy does): its last `metrics.summary` line is logged with the laser frames
// and the pushes counted, and it names no board, no person and nothing they wrote. /internal/metrics carries
// lobby_laser_frames_in_total (the real server: test/element-room/metrics-f10.test.ts). The unit tests of the line
// (hourly, fake timers; the bucket estimates; labels dropped) are src/room/metrics-f10.test.ts.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ELEMENT_SCHEMA_VERSION, PROTO } from '@draftroom/canvas-schema/protocol'
import { describe, expect, it } from 'vitest'
import '../../src/room/index.ts' // registers the ElementRoom (engine-switch.ts registerElementRoom)
import { loadConfig } from '../../src/config.ts'
import { type ElementSocket, registeredElementRoom } from '../../src/engine-switch.ts'
import { TEST_INTERNAL_SECRET, TEST_TICKET_SECRET } from '../harness/tickets.ts'
import { label, note } from './support/elements.ts'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('M7-3: the service’s last metrics.summary line when it closes', () => {
  it('counts the laser frames and pushes, and names no board, person or words', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dr-summary-'))
    const factory = registeredElementRoom()
    if (!factory) throw new Error('no ElementRoom registered')
    const logs: string[] = []
    const svc = factory({
      dataDir: join(dir, 'rooms'),
      config: loadConfig({
        DRAFTROOM_TICKET_SECRET: TEST_TICKET_SECRET,
        DRAFTROOM_INTERNAL_SECRET: TEST_INTERNAL_SECRET,
        DRAFTROOM_DATA_DIR: dir,
        DRAFTROOM_ENGINE: 'excalidraw',
      }),
      log: (...a) => logs.push(a.map(String).join(' ')),
      fileRefs: async (_b, ids) => ({ ok: [], foreign: [], missing: [...ids] }),
      workshopState: async () => ({ voteOpen: false, anonymous: false }),
      onSessionRemoved: () => {},
      onDocumentChange: () => {},
      disk: { freeRatio: () => 0.42 },
    })
    try {
      const boardId = 'b-summary0001'
      const uid = 'usr_SummaryAlice01'
      const frames: string[] = []
      const socket: ElementSocket = {
        readyState: 1,
        bufferedAmount: 0,
        send: (d) => void (typeof d === 'string' && frames.push(d)),
        close: () => {},
      }
      const h = svc.connect(
        {
          boardId,
          sid: `${uid}:tab`,
          uid,
          name: 'Alice Halden',
          color: '#1971c2',
          role: 'editor',
          guest: false,
          readonly: false,
          ticketIssuedAt: Date.now(),
          contractsRev: 12,
        },
        socket,
      )
      h.message(
        JSON.stringify({
          type: 'hello',
          proto: PROTO,
          schema: ELEMENT_SCHEMA_VERSION,
          since: 0,
          epoch: null,
          tab: 'tab',
        }),
      )
      for (let i = 0; i < 100 && !frames.some((f) => f.startsWith('{"type":"contracts"')); i++)
        await sleep(20)
      const words = 'Quarterly pricing idea for Halden'
      h.message(
        JSON.stringify({
          type: 'push',
          seq: 1,
          base: 0,
          ops: [
            { k: 'c', el: note('n1', { boundElements: [{ id: 'n1t', type: 'text' }] }) },
            { k: 'c', el: label('n1t', 'n1', { text: words, originalText: words }) },
          ],
        }),
      )
      for (let i = 0; i < 100 && !frames.some((f) => f.startsWith('{"type":"ack"')); i++) await sleep(20)
      for (let i = 0; i < 3; i++) {
        h.message(
          JSON.stringify({
            type: 'presence',
            pointer: { x: 10 + i, y: 10 },
            button: 'down',
            sel: [],
            view: null,
            idle: false,
            editing: null,
            f: null,
            t: 'laser',
            trail: [{ x: 5 + i, y: 10 }],
          }),
        )
        await sleep(60) // within the 20 Hz input cap
      }
      expect(svc.metrics()).toMatch(/^lobby_laser_frames_in_total 3$/m)
      await svc.closeAll()
      const summaries = logs.filter((l) => l.startsWith('metrics.summary '))
      expect(summaries).toHaveLength(1)
      const line = summaries[0] as string
      const s = JSON.parse(line.slice('metrics.summary '.length)) as {
        final?: boolean
        counts: Record<string, number>
        rooms: number
        sessions: number
        diskFree: number
        elements: { n: number; max: number }
      }
      expect(s.final).toBe(true)
      expect(s.counts).toMatchObject({ laserFramesIn: 3, pushes: 1, joins: 1 })
      expect(s).toMatchObject({ rooms: 1, sessions: 1, diskFree: 0.42 })
      expect(s.elements).toMatchObject({ n: 1, max: 2 })
      for (const needle of [boardId, uid, 'usr_', 'Summary', 'Alice', 'Halden', 'pricing', 'board', 'user'])
        expect(line, needle).not.toContain(needle)
    } finally {
      await svc.closeAll().catch(() => {})
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    }
  })
})
