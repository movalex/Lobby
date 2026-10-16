// The `.lobby` backup (wave R, WS4): what writeBackup makes, openBackup reads back (and unzip -t accepts), and the
// backups openBackup, readBackupBoard and streamBackupFile refuse.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BACKUP_CODES, type BackupManifestFile, backupFileEntry } from '@draftroom/contracts'
import { afterAll, describe, expect, it } from 'vitest'
import {
  type BackupFileInput,
  BackupFormatError,
  type BackupInput,
  backupManifest,
  openBackup,
  readBackupBoard,
  streamBackupFile,
  writeBackup,
} from './backup.ts'
import { bufferSource } from './zip-read.ts'
import { type ZipWriteEntry, zipToBuffer } from './zip-write.ts'

const tmp = mkdtempSync(join(tmpdir(), 'board-backup-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))
const hasUnzip = spawnSync('unzip', ['-v'], { encoding: 'utf8' }).status === 0

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const REV = 13
const ID = (p: string, n: number) => `${p}_${String(n).padStart(20, '0')}`

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(20_000, 7)])
const pdf = Buffer.from('%PDF-1.7 a small one')

const fileRow = (
  n: number,
  bytes: Buffer,
  extra: Partial<BackupManifestFile> = {},
): Omit<BackupManifestFile, 'path'> => ({
  versionId: ID('ver', n),
  assetId: ID('ast', n),
  name: `file-${n}`,
  mimeType: 'image/png',
  kind: 'image',
  sizeBytes: bytes.length,
  sha256: sha(bytes),
  omitted: false,
  ...extra,
})

async function* once(b: Buffer) {
  yield b
}
const original = (b: Buffer): BackupFileInput => ({ sha256: sha(b), size: b.length, open: () => once(b) })

const board = Buffer.from(JSON.stringify({ format: 'lobby-board', version: 2, elements: [{ id: 'a' }] }))

const input = (over: Partial<BackupInput> = {}): BackupInput => ({
  createdAt: new Date('2026-10-16T10:00:00Z'),
  app: { contractsRev: REV, engineVersion: '0.18.0-1118751' },
  title: 'Pitch',
  elements: 1,
  board,
  files: [
    fileRow(1, png),
    // the same bytes under a second version: stored once
    fileRow(2, png),
    fileRow(3, pdf, { mimeType: 'application/pdf', kind: 'pdf' }),
    // the caller may not download it: listed, not included
    fileRow(4, Buffer.from('secret'), { omitted: true }),
  ],
  originals: new Map([
    [sha(png), original(png)],
    [sha(pdf), original(pdf)],
  ]),
  ...over,
})

const collect = async (gen: AsyncIterable<Buffer>) => {
  const parts: Buffer[] = []
  for await (const p of gen) parts.push(p)
  return Buffer.concat(parts)
}

const refusal = async (p: Promise<unknown>) => {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  )
  expect(e).toBeInstanceOf(BackupFormatError)
  return (e as BackupFormatError).code
}

/** a hand-made backup: a manifest for these files, then whatever entries the test wants */
const crafted = async (entries: ZipWriteEntry[]) => zipToBuffer(entries)
const manifestEntry = (m: unknown): ZipWriteEntry => ({
  name: 'manifest.json',
  data: Buffer.from(JSON.stringify(m)),
  method: 8,
})
const boardEntry = (b = board): ZipWriteEntry => ({ name: 'board.json', data: b, method: 8 })
const fileEntry = (b: Buffer, name = backupFileEntry(sha(b))): ZipWriteEntry => ({ name, data: b, method: 0 })
const open = (zip: Buffer) => openBackup(bufferSource(zip), { contractsRev: REV })

describe('the .lobby backup', () => {
  it('round trip: the manifest, board.json and every included original come back, checked', async () => {
    const zip = await collect(writeBackup(input()))
    const opened = await open(zip)
    expect(opened.manifest).toMatchObject({
      format: 'lobby-backup',
      version: 1,
      title: 'Pitch',
      app: { contractsRev: REV },
      counts: { elements: 1, files: 3 },
      board: { path: 'board.json', sha256: sha(board), bytes: board.length },
    })
    expect(opened.manifest.files.map((f) => [f.versionId, f.path, f.omitted])).toEqual([
      [ID('ver', 1), backupFileEntry(sha(png)), false],
      [ID('ver', 2), backupFileEntry(sha(png)), false],
      [ID('ver', 3), backupFileEntry(sha(pdf)), false],
      [ID('ver', 4), null, true],
    ])
    expect([...opened.files.keys()].sort()).toEqual([sha(png), sha(pdf)].sort())
    expect(await readBackupBoard(bufferSource(zip), opened)).toEqual(JSON.parse(board.toString()))
    expect((await collect(streamBackupFile(bufferSource(zip), opened, sha(png)))).equals(png)).toBe(true)
    expect((await collect(streamBackupFile(bufferSource(zip), opened, sha(pdf)))).equals(pdf)).toBe(true)
  })

  it.runIf(hasUnzip)('unzip -t accepts a backup', async () => {
    const path = join(tmp, 'board.lobby')
    writeFileSync(path, await collect(writeBackup(input())))
    const r = spawnSync('unzip', ['-t', path], { encoding: 'utf8' })
    expect(r.stdout).toContain('No errors detected')
  })

  it('the writer refuses an original whose bytes are not its sha256, and an included file without bytes', async () => {
    const zeros = Buffer.alloc(png.length)
    const lying: BackupFileInput = { sha256: sha(png), size: png.length, open: () => once(zeros) }
    const originals = new Map([
      [sha(png), lying],
      [sha(pdf), original(pdf)],
    ])
    await expect(collect(writeBackup(input({ originals })))).rejects.toThrow('sha256')
    expect(() => writeBackup(input({ originals: new Map() }))).toThrow()
  })

  it('a backup from a newer Lobby is refused as such; an older one is read', async () => {
    const newer = await collect(writeBackup(input({ app: { contractsRev: REV + 1, engineVersion: 'x' } })))
    expect(await refusal(open(newer))).toBe(BACKUP_CODES.fromNewer)
    const older = await collect(writeBackup(input({ app: { contractsRev: REV - 2, engineVersion: 'x' } })))
    await expect(open(older)).resolves.toBeTruthy()
  })

  it('the manifest must be first, valid JSON and match the schema', async () => {
    const m = backupManifest(input())
    const files = [fileEntry(png), fileEntry(pdf)]
    const ok = await crafted([manifestEntry(m), boardEntry(), ...files])
    await expect(open(ok)).resolves.toBeTruthy()
    const second = await crafted([boardEntry(), manifestEntry(m), ...files])
    expect(await refusal(open(second))).toBe(BACKUP_CODES.invalid)
    const brace: ZipWriteEntry = { name: 'manifest.json', data: Buffer.from('{'), method: 8 }
    const notJson = await crafted([brace, boardEntry(), ...files])
    expect(await refusal(open(notJson))).toBe(BACKUP_CODES.invalid)
    const extraKey = await crafted([manifestEntry({ ...m, evil: true }), boardEntry(), ...files])
    expect(await refusal(open(extraKey))).toBe(BACKUP_CODES.invalid)
    const noBoard = await crafted([manifestEntry(m), ...files])
    expect(await refusal(open(noBoard))).toBe(BACKUP_CODES.invalid)
  })

  it('any other entry name refuses the backup (an extra, traversal, a file not named by its sha256)', async () => {
    const m = backupManifest(input())
    const files = [fileEntry(png), fileEntry(pdf)]
    const names = ['readme.txt', '../board.json', 'files/../board.json', `files/${sha(png).toUpperCase()}`]
    for (const name of names) {
      const zip = await crafted([manifestEntry(m), boardEntry(), ...files, fileEntry(Buffer.from('x'), name)])
      expect(await refusal(open(zip)), name).toBe(BACKUP_CODES.invalid)
    }
  })

  it('the manifest and the files must agree: none missing, none extra, the same sizes, stored', async () => {
    const m = backupManifest(input())
    const missing = await crafted([manifestEntry(m), boardEntry(), fileEntry(png)])
    expect(await refusal(open(missing))).toBe(BACKUP_CODES.invalid)
    const other = Buffer.from('not listed')
    const extra = await crafted([
      manifestEntry(m),
      boardEntry(),
      fileEntry(png),
      fileEntry(pdf),
      fileEntry(other),
    ])
    expect(await refusal(open(extra))).toBe(BACKUP_CODES.invalid)
    const sized = backupManifest(input({ files: [fileRow(1, png, { sizeBytes: png.length + 1 })] }))
    const wrongSize = await crafted([manifestEntry(sized), boardEntry(), fileEntry(png)])
    expect(await refusal(open(wrongSize))).toBe(BACKUP_CODES.invalid)
    const deflated = await crafted([
      manifestEntry(m),
      boardEntry(),
      { name: backupFileEntry(sha(png)), data: png, method: 8 },
      fileEntry(pdf),
    ])
    expect(await refusal(open(deflated))).toBe(BACKUP_CODES.invalid)
    const small = boardEntry(Buffer.from('{}'))
    const boardSize = await crafted([manifestEntry(m), small, fileEntry(png), fileEntry(pdf)])
    expect(await refusal(open(boardSize))).toBe(BACKUP_CODES.invalid)
  })

  it('board.json must match its sha256; a file must match its sha256 (after its CRC, which a forger can fix)', async () => {
    const m = backupManifest(input())
    const forged = Buffer.from(board)
    forged[forged.length - 2] = 0x20 // same size, other bytes
    const zip = await crafted([manifestEntry(m), boardEntry(forged), fileEntry(png), fileEntry(pdf)])
    const opened = await open(zip)
    expect(await refusal(readBackupBoard(bufferSource(zip), opened))).toBe(BACKUP_CODES.invalid)
    // a file entry named for png's sha256 whose bytes are something else (with a correct CRC for them)
    const fake = Buffer.alloc(png.length, 1)
    const named = fileEntry(fake, backupFileEntry(sha(png)))
    const zip2 = await crafted([manifestEntry(m), boardEntry(), named, fileEntry(pdf)])
    const opened2 = await open(zip2)
    const read = collect(streamBackupFile(bufferSource(zip2), opened2, sha(png)))
    expect(await refusal(read)).toBe(BACKUP_CODES.invalid)
  })

  it('over the limits: too many entries, too large a manifest or board.json', async () => {
    const zip = await collect(writeBackup(input()))
    const many = Buffer.from(zip)
    many.writeUInt16LE(5_003, zip.length - 22 + 8)
    many.writeUInt16LE(5_003, zip.length - 22 + 10)
    expect(await refusal(open(many))).toBe(BACKUP_CODES.tooLarge)
    const huge = await crafted([
      { name: 'manifest.json', data: Buffer.alloc(5 * 1024 * 1024, 0x20), method: 0 },
      boardEntry(),
    ])
    expect(await refusal(open(huge))).toBe(BACKUP_CODES.tooLarge)
  })

  it('a zip bomb as board.json is refused before it is inflated', async () => {
    const bomb = Buffer.alloc(32 * 1024 * 1024, 0x20)
    const m = backupManifest(input({ board: bomb, files: [], originals: new Map() }))
    const zip = await crafted([manifestEntry(m), boardEntry(bomb)])
    expect(await refusal(open(zip))).toBe(BACKUP_CODES.tooLarge)
  })

  it('a backup that is not a ZIP at all, or empty, is invalid', async () => {
    expect(await refusal(open(Buffer.from('{"format":"lobby-board"}')))).toBe(BACKUP_CODES.invalid)
    expect(await refusal(open(Buffer.alloc(0)))).toBe(BACKUP_CODES.invalid)
  })
})
