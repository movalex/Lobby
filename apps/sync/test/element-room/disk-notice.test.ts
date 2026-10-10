// Wave M (M7-4, CAP-DISK), the rooms' side:
//  - the DISK notice to everyone on a board now goes out below 10 % free (it was 5 %): with a fake statfs, the
//    in-process service's room broadcasts it at 8 % (the old rule said nothing there) and not at 12 %;
//  - lobby_disk_free_ratio is in /internal/metrics (the real server, DRAFTROOM_TEST_DISK_FREE with the test hooks);
//  - DRAFTROOM_BACKUP_KEEP reaches the backup pass of the real server (keep=4).
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ELEMENT_SCHEMA_VERSION, PROTO } from '@draftroom/canvas-schema/protocol'
import { afterEach, describe, expect, it } from 'vitest'
import '../../src/room/index.ts' // registers the ElementRoom (engine-switch.ts registerElementRoom)
import { readManifest } from '../../src/backup/backup.ts'
import { loadConfig } from '../../src/config.ts'
import type { DiskProbe } from '../../src/disk.ts'
import {
  type ElementRoomService,
  type ElementSocket,
  registeredElementRoom,
} from '../../src/engine-switch.ts'
import { callInternal, TEST_INTERNAL_SECRET, TEST_TICKET_SECRET } from '../harness/tickets.ts'
import { rect } from './support/elements.ts'
import { newBoardId, useElementHarness } from './support/stack.ts'

const h = useElementHarness()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

/** The in-process service with a fake disk and a clock the test moves (the DISK check runs once a minute). */
function service(free: number) {
  const dir = mkdtempSync(join(tmpdir(), 'dr-disk-notice-'))
  const factory = registeredElementRoom()
  if (!factory) throw new Error('no ElementRoom registered')
  let now = 1_800_000_000_000
  const disk: DiskProbe = { freeRatio: () => free }
  const svc: ElementRoomService = factory({
    dataDir: join(dir, 'rooms'),
    config: loadConfig({
      DRAFTROOM_TICKET_SECRET: TEST_TICKET_SECRET,
      DRAFTROOM_INTERNAL_SECRET: TEST_INTERNAL_SECRET,
      DRAFTROOM_DATA_DIR: dir,
      DRAFTROOM_ENGINE: 'excalidraw',
    }),
    log: () => {},
    now: () => now,
    fileRefs: async (_b, ids) => ({ ok: [], foreign: [], missing: [...ids] }),
    workshopState: async () => ({ voteOpen: false, anonymous: false }),
    onSessionRemoved: () => {},
    onDocumentChange: () => {},
    disk,
  })
  cleanups.push(async () => {
    await svc.closeAll()
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  })
  const join_ = (boardId: string) => {
    const frames: string[] = []
    const socket: ElementSocket = {
      readyState: 1,
      bufferedAmount: 0,
      send: (d) => void (typeof d === 'string' && frames.push(d)),
      close: () => {},
    }
    const handle = svc.connect(
      {
        boardId,
        sid: 'usr_disk:tab',
        uid: 'usr_disk',
        name: 'Disk',
        color: '#1971c2',
        role: 'editor',
        guest: false,
        readonly: false,
        ticketIssuedAt: now,
        contractsRev: 12,
      },
      socket,
    )
    handle.message(
      JSON.stringify({
        type: 'hello',
        proto: PROTO,
        schema: ELEMENT_SCHEMA_VERSION,
        since: 0,
        epoch: null,
        tab: 'tab',
      }),
    )
    return frames
  }
  return {
    join: join_,
    advance: (ms: number) => {
      now += ms
    },
  }
}

const diskNotices = (frames: string[]) =>
  frames.filter((f) => f.includes('"type":"notice"') && f.includes('"DISK"'))

async function welcomed(frames: string[]) {
  for (let i = 0; i < 100 && !frames.some((f) => f.startsWith('{"type":"contracts"')); i++) await sleep(20)
  expect(frames.some((f) => f.startsWith('{"type":"contracts"'))).toBe(true)
}

describe('M7-4: the DISK notice below 10 % free (it was 5 %)', () => {
  it('8 % free: the room tells everyone (DISK), at its next once-a-minute check', async () => {
    const s = service(0.08)
    const frames = s.join(newBoardId())
    await welcomed(frames)
    s.advance(61_000) // the next check is due
    for (let i = 0; i < 50 && !diskNotices(frames).length; i++) await sleep(20)
    expect(diskNotices(frames)).toHaveLength(1)
  })

  it('12 % free: no notice (the backup guard acts there, not the people)', async () => {
    const s = service(0.12)
    const frames = s.join(newBoardId())
    await welcomed(frames)
    s.advance(61_000)
    await sleep(600)
    expect(diskNotices(frames)).toEqual([])
  })
})

describe('M7-4 in the real server', () => {
  it('lobby_disk_free_ratio is in /internal/metrics', async () => {
    const st = await h.stack({ env: { DRAFTROOM_TEST_DISK_FREE: '0.15' } })
    const b = newBoardId()
    await st.client({ boardId: b, user: 'alice' })
    const text = await (await callInternal(st.server.url, 'GET', '/internal/metrics')).text()
    expect(text).toContain('# TYPE lobby_disk_free_ratio gauge')
    expect(text).toMatch(/^lobby_disk_free_ratio 0\.15$/m)
  })

  it('DRAFTROOM_BACKUP_KEEP=4 reaches the backup pass: never more than 4 local copies of a board', async () => {
    const dataDir = h.dataDir()
    const st = await h.stack({
      dataDir,
      env: {
        DRAFTROOM_BACKUP_KEEP: '4',
        DRAFTROOM_BACKUP_INTERVAL_MS: '1000',
        DRAFTROOM_TEST_DISK_FREE: '0.9',
      },
    })
    const b = newBoardId()
    const c = await st.client({ boardId: b, user: 'alice' })
    const backups = join(dataDir, 'backups', b)
    const count = () => {
      try {
        return readdirSync(backups).filter((f) => f.endsWith('.sqlite')).length
      } catch {
        return 0
      }
    }
    const seen: number[] = []
    for (let i = 0; i < 7; i++) {
      await c.create([rect(`k${i}`, { x: i * 30 })])
      await sleep(1_150)
      seen.push(count())
    }
    expect(Math.max(...seen)).toBe(4)
    expect(readManifest(join(dataDir, 'backups'), b)?.backups.length).toBe(4)
  })
})
