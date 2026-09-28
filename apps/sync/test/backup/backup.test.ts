// Board backups (build plan §7): node:sqlite backup() on the live connection, consistency while the
// room keeps committing, the manifest, change detection, retention, the eviction backup, the restore
// drill (API and CLI) and the clock bump that keeps stale clients from keeping ghost records.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { draftroomSchema } from '@draftroom/canvas-schema'
import { type TLShape, toRichText } from '@tldraw/tlschema'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { backupBoard, describeBoardDb, readManifest, sha256File } from '../../src/backup/backup.ts'
import { runRestoreDrill } from '../../src/backup/drill.ts'
import { restoreBackupFile } from '../../src/backup/restore.ts'
import { boardDbPath, type RegistryOpts, RoomRegistry } from '../../src/rooms.ts'
import { indexFor, note, RoomClient, until } from '../deleted/fixtures.ts'

const BOARD = 'backup-board'
let data: string
let rooms: string
let backups: string
let registries: RoomRegistry[] = []

function registry(over: Partial<RegistryOpts> = {}) {
  const r = new RoomRegistry({ dataDir: rooms, schema: draftroomSchema, idleEvictMs: 60_000, ...over })
  registries.push(r)
  return r
}
async function editor(reg: RoomRegistry, boardId = BOARD) {
  const c = new RoomClient(reg.getOrCreate(boardId), 'usr_a')
  await c.connect()
  return c
}
// usr_a retypes a note, stamping itself as tldraw does (the sync server requires it, attribution.ts)
const text = (s: string) => ({
  props: ['patch', { richText: ['put', toRichText(s)], textLastEditedBy: ['put', 'usr_a'] }],
})

beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), 'dr-backup-'))
  rooms = join(data, 'rooms')
  backups = join(data, 'backups')
})
afterEach(() => {
  for (const r of registries) r.closeAll()
  registries = []
  rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

describe('backups of open boards', () => {
  it('are on by default for the server data layout (<DATA>/rooms -> <DATA>/backups) and off elsewhere', () => {
    expect(registry().backupsDir()).toBe(resolve(backups))
    expect(registry({ backup: false }).backupsDir()).toBeNull()
    const bare = new RoomRegistry({ dataDir: join(data, 'elsewhere'), schema: draftroomSchema })
    registries.push(bare)
    expect(bare.backupsDir()).toBeNull()
  })

  it('writes a self-contained copy and a manifest that describes it exactly', async () => {
    const reg = registry()
    const a = await editor(reg)
    await a.put(note('n1', 'one'), note('n2', 'two', { index: indexFor(2) }))
    const entry = await reg.backupNow(BOARD)
    if (!entry) throw new Error('no backup')
    const file = join(backups, BOARD, entry.file)
    expect(existsSync(file)).toBe(true)
    expect(existsSync(`${file}-wal`)).toBe(false) // rollback journal: one file
    expect(entry.sha256).toBe(await sha256File(file))
    const facts = describeBoardDb(file)
    expect(facts.documentClock).toBe(reg.roomIfOpen(BOARD)?.getCurrentDocumentClock())
    expect(facts.recordsSha256).toBe(entry.recordsSha256)
    expect([...facts.records.keys()]).toEqual(expect.arrayContaining(['shape:n1', 'shape:n2', 'page:page']))
    expect(readManifest(backups, BOARD)?.backups).toEqual([entry])
    // no temp files left behind
    expect(readdirSync(join(backups, BOARD)).sort()).toEqual([entry.file, 'manifest.json'].sort())
  })

  it('is consistent while the room keeps committing on the same connection', async () => {
    const reg = registry()
    const a = await editor(reg)
    // a board big enough that the online backup takes many steps (100 pages each)
    const filler = 'x'.repeat(2_000)
    for (let chunk = 0; chunk < 10; chunk++)
      await a.put(
        ...Array.from({ length: 150 }, (_, i) =>
          note(`f${chunk}_${i}`, filler, { index: indexFor(chunk * 150 + i + 10) }),
        ),
      )
    await a.put(note('pairA', 'k=0', { index: indexFor(1) }), note('pairB', 'k=0', { index: indexFor(2) }))
    // every push writes the same k into BOTH shapes: a torn copy would show them differing
    let k = 0
    let writing = true
    const writer = (async () => {
      while (writing) {
        k++
        await a.push({ 'shape:pairA': ['patch', text(`k=${k}`)], 'shape:pairB': ['patch', text(`k=${k}`)] })
        await new Promise((r) => setImmediate(r))
      }
    })()
    const entry = await reg.backupNow(BOARD)
    writing = false
    await writer
    if (!entry) throw new Error('no backup')
    expect(k).toBeGreaterThan(1) // writes really happened during the copy
    const facts = describeBoardDb(join(backups, BOARD, entry.file))
    const kOf = (id: string) =>
      JSON.parse(facts.records.get(id) ?? '{}').props.richText.content[0].content[0].text
    expect(kOf('shape:pairA')).toBe(kOf('shape:pairB'))
    expect(facts.recordCount).toBe(1_500 + 2 + 2) // fillers + pair + document + page
    expect(facts.recordsSha256).toBe(entry.recordsSha256)
  })

  it('backs up only boards that changed since their last backup, and keeps the newest N', async () => {
    const reg = registry({ backup: { keep: 2 } })
    const a = await editor(reg)
    await a.put(note('n1', 'v1'))
    await reg.runBackupPass()
    await reg.runBackupPass() // unchanged: nothing new
    expect(readManifest(backups, BOARD)?.backups).toHaveLength(1)
    for (const v of ['v2', 'v3']) {
      await a.push({ 'shape:n1': ['patch', text(v)] })
      await reg.runBackupPass()
    }
    const manifest = readManifest(backups, BOARD)
    expect(manifest?.backups).toHaveLength(2)
    const files = readdirSync(join(backups, BOARD)).filter((f) => f.endsWith('.sqlite'))
    expect(files.sort()).toEqual(manifest?.backups.map((b) => b.file).sort())
    // change detection survives a restart (it reads the manifest)
    reg.closeAll()
    const again = registry({ backup: { keep: 2 } })
    await editor(again)
    await again.runBackupPass()
    expect(readManifest(backups, BOARD)?.backups).toHaveLength(2)
  })

  it('backs up a changed board before an idle eviction closes it', async () => {
    const reg = registry({ idleEvictMs: 20, backup: { evictBackupMinOpenMs: 0 } })
    const room = reg.getOrCreate(BOARD)
    const a = new RoomClient(room, 'usr_a')
    await a.connect()
    await a.put(note('n1', 'before idle'))
    room.handleSocketClose(a.sessionId)
    await until(() => !reg.roomIfOpen(BOARD), 10_000)
    const entry = readManifest(backups, BOARD)?.backups.at(-1)
    expect(entry && describeBoardDb(join(backups, BOARD, entry.file)).records.has('shape:n1')).toBe(true)
  })
})

describe('restore drill', () => {
  async function boardWithBackup() {
    const reg = registry()
    const a = await editor(reg)
    await a.put(note('n1', 'drill me'), note('n2', 'and me', { index: indexFor(2) }))
    const entry = await reg.backupNow(BOARD)
    reg.closeAll()
    if (!entry) throw new Error('no backup')
    return entry
  }

  it('restores the newest backup into a clean data dir and finds every record', async () => {
    const entry = await boardWithBackup()
    const report = await runRestoreDrill({ dataDir: data })
    expect(report.ok).toBe(true)
    expect(report.boards).toHaveLength(1)
    expect(report.boards[0]).toMatchObject({
      boardId: BOARD,
      ok: true,
      backupFile: entry.file,
      recordCount: entry.recordCount,
      live: 'identical',
      problems: [],
    })
    expect(existsSync(report.workDir)).toBe(false) // cleaned up
  })

  it('fails on a backup whose bytes or records do not match the manifest', async () => {
    const entry = await boardWithBackup()
    const file = join(backups, BOARD, entry.file)
    const bytes = readFileSync(file)
    bytes[bytes.length - 10] = (bytes[bytes.length - 10] ?? 0) ^ 0xff
    writeFileSync(file, bytes)
    const report = await runRestoreDrill({ dataDir: data })
    expect(report.ok).toBe(false)
    expect(report.boards[0]?.problems).toEqual(['backup file checksum does not match its manifest'])

    // bytes fine but the manifest's record digest is not what the file holds
    const fresh = await boardWithBackup()
    const manifestFile = join(backups, BOARD, 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
    manifest.backups.at(-1).recordsSha256 = '0'.repeat(64)
    writeFileSync(manifestFile, JSON.stringify(manifest))
    const again = await runRestoreDrill({ dataDir: data, boardIds: [BOARD] })
    expect(again.ok).toBe(false)
    expect(again.boards[0]?.backupFile).toBe(fresh.file)
    expect(again.boards[0]?.problems).toContain('restored records differ from the manifest digest')
  })

  it('fails when there is nothing to drill', async () => {
    const report = await runRestoreDrill({ dataDir: data })
    expect(report).toMatchObject({ ok: false, boards: [] })
  })

  it('runs as a script (the pnpm backup:restore-drill entry point), with --backup-first', () => {
    const reg = registry({ backup: false })
    return editor(reg).then(async (a) => {
      await a.put(note('n1', 'cli'))
      reg.closeAll()
      const script = fileURLToPath(new URL('../../src/backup/restore-drill.ts', import.meta.url))
      const run = spawnSync(process.execPath, [script, '--data-dir', data, '--backup-first'], {
        encoding: 'utf8',
        timeout: 60_000,
      })
      expect(run.stdout).toContain(`PASS ${BOARD}`)
      expect(run.stdout).toContain('restore drill passed')
      expect(run.status).toBe(0)
      const empty = mkdtempSync(join(tmpdir(), 'dr-backup-empty-'))
      try {
        const none = spawnSync(process.execPath, [script, '--data-dir', empty], {
          encoding: 'utf8',
          timeout: 60_000,
        })
        expect(none.status).toBe(1)
        expect(none.stdout).toContain('no backups found')
      } finally {
        rmSync(empty, { recursive: true, force: true })
      }
    })
  })
})

describe('putting a backup back in place (disaster recovery)', () => {
  it('bumpClockBy makes clients that saw newer state reset instead of keeping ghost records', async () => {
    const reg = registry()
    const a = await editor(reg)
    await a.put(note('n1', 'in the backup'))
    const entry = await reg.backupNow(BOARD)
    if (!entry) throw new Error('no backup')
    await a.put(note('ghost', 'after the backup', { index: indexFor(3) }) as TLShape)
    const seenClock = reg.roomIfOpen(BOARD)?.getCurrentDocumentClock() ?? 0
    reg.closeAll()
    const file = join(backups, BOARD, entry.file)

    // Others keep working on the restored board until its clock passes what the stale tab saw.
    const catchUp = async (reg: RoomRegistry) => {
      const other = await editor(reg)
      for (let i = 0; (reg.roomIfOpen(BOARD)?.getCurrentDocumentClock() ?? 0) <= seenClock + 1; i++)
        await other.put(note(`after${i}`, 'new work', { index: indexFor(100 + i) }))
    }

    // without the bump, the stale tab is sent only the newest changes: it keeps 'ghost' forever
    restoreBackupFile({ file, roomsDir: rooms, boardId: BOARD, overwrite: true })
    const plain = registry({ backup: false })
    await catchUp(plain)
    const stale = new RoomClient(plain.getOrCreate(BOARD), 'usr_stale', { tab: 'stale' })
    expect((await stale.connect(seenClock)).hydrationType).toBe('wipe_presence')
    plain.closeAll()

    // with it, the same tab is sent a full reset (wipe_all) and loses the ghost
    const bumped = restoreBackupFile({
      file,
      roomsDir: rooms,
      boardId: BOARD,
      overwrite: true,
      bumpClockBy: 1_000_000,
    })
    expect(bumped.documentClock).toBe(entry.documentClock + 1_000_000)
    const fixed = registry({ backup: false })
    await catchUp(fixed)
    const client = new RoomClient(fixed.getOrCreate(BOARD), 'usr_stale', { tab: 'stale' })
    const connect = await client.connect(seenClock)
    expect(connect.hydrationType).toBe('wipe_all')
    expect(JSON.stringify(connect)).toContain('shape:n1')
    expect(JSON.stringify(connect)).not.toContain('shape:ghost')
  })

  it('refuses to replace an existing board database unless asked', async () => {
    const entry = await (async () => {
      const reg = registry()
      await (await editor(reg)).put(note('n1', 'x'))
      const e = await reg.backupNow(BOARD)
      reg.closeAll()
      return e
    })()
    if (!entry) throw new Error('no backup')
    mkdirSync(rooms, { recursive: true })
    expect(() =>
      restoreBackupFile({ file: join(backups, BOARD, entry.file), roomsDir: rooms, boardId: BOARD }),
    ).toThrow(/already has a database/)
    expect(existsSync(boardDbPath(rooms, BOARD))).toBe(true)
  })
})

describe('backupBoard on its own', () => {
  it('refuses board ids that could escape the backups folder', async () => {
    const db = new DatabaseSync(':memory:')
    await expect(backupBoard({ db, boardId: '../evil', root: backups })).rejects.toThrow(/invalid board id/)
    db.close()
  })
})
