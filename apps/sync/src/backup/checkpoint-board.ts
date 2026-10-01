// Checkpoint a board file before copying or restoring it by hand (backup/checkpoint.ts has why).
//
//   node apps/sync/src/backup/checkpoint-board.ts --board <id> [--data-dir <DATA>]
//   node apps/sync/src/backup/checkpoint-board.ts --path <board database file>
//   (dev: pnpm --filter @draftroom/sync backup:checkpoint …)
//
// Exit 0 when the file is self-contained afterwards (or had no WAL to fold in), 1 when another connection
// held the file (stop the sync server, or wait for its rooms to close in maintenance, and run it again) or
// the file could not be read, 2 for bad arguments. It prints the board id or file name and byte counts,
// never any content.

import { join } from 'node:path'
import { dataLayout, resolveDataDir } from '@draftroom/dev-assets'
import { BOARD_ID_RE, boardDbPath } from '../rooms.ts'
import { checkpointBoardFile } from './checkpoint.ts'

class UsageError extends Error {}

function parseArgs(argv: string[]) {
  const out = { dataDir: null as string | null, board: null as string | null, path: null as string | null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? ''
    const eq = /^(--[a-z-]+)=(.*)$/.exec(a)
    const flag = eq?.[1] ?? a
    const value = () => (eq ? eq[2] : argv[++i]) ?? ''
    if (flag === '--data-dir') out.dataDir = value() || null
    else if (flag === '--board') out.board = value()
    else if (flag === '--path') out.path = value() || null
    else throw new UsageError(`unknown argument ${a.slice(0, 40)}`)
  }
  if ((out.board === null) === (out.path === null))
    throw new UsageError(
      'give --board <id> (with --data-dir or DRAFTROOM_DATA_DIR) or --path <file>, not both',
    )
  if (out.board !== null && !BOARD_ID_RE.test(out.board))
    throw new UsageError(`invalid board id ${out.board.slice(0, 70)}`)
  return out
}

function main(): number {
  let args: ReturnType<typeof parseArgs>
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (e) {
    console.error(`checkpoint-board: ${(e as Error).message}`)
    return 2
  }
  const path =
    args.path ??
    boardDbPath(
      join(dataLayout(args.dataDir ?? resolveDataDir(process.env)).root, 'rooms'),
      args.board as string,
    )
  const what = args.board ?? args.path
  let result: ReturnType<typeof checkpointBoardFile>
  try {
    result = checkpointBoardFile(path)
  } catch (e) {
    console.error(`checkpoint-board: ${what}: ${(e as Error).message}`)
    return 1
  }
  if (result.walBytesBefore === 0) {
    console.log(`${what}: nothing to do (no WAL next to the file); it can be copied as it is`)
    return 0
  }
  if (result.busy) {
    console.error(
      `${what}: busy: another connection holds the file (${result.walBytesBefore} WAL bytes may be left). Stop the sync server, or wait for the board's room to close in maintenance, then run it again.`,
    )
    return 1
  }
  console.log(
    `${what}: checkpointed (${result.walBytesBefore} WAL bytes folded into the file); it can be copied now`,
  )
  return 0
}

process.exitCode = main()
