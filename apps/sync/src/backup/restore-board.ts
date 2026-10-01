// Board restore CLI (docs/DEPLOY.md "Restoring a board on Render from R2"). Safe to run next to a
// running sync server: it only stages; the next server start applies it (staged-restore.ts).
//
//   pnpm --filter @draftroom/sync backup:restore-board --from=store|local --board <id> [--file <name>]
//     [--allow-unsigned]
//   pnpm --filter @draftroom/sync backup:restore-board --from=file --path <sqlite> --board <id>
//   pnpm --filter @draftroom/sync backup:restore-board --board <id> --cancel
//   pnpm --filter @draftroom/sync backup:restore-board --list
//   (on a server without pnpm: node apps/sync/src/backup/restore-board.ts ...)
//   Also --data-dir <DATA> (default DRAFTROOM_DATA_DIR).
//
// --from=store reads the offsite store configured by DRAFTROOM_BACKUP_STORE (+ DRAFTROOM_BACKUP_R2_*
// or R2_*) and needs the sync server's DRAFTROOM_BACKUP_SIGNING_SECRET and DRAFTROOM_INTERNAL_SECRET (the
// older backups' key): the manifest and the entry must carry
// signatures that verify (signing.ts), or, with --allow-unsigned, be unsigned (written before backups
// were signed) and are then staged with a WARN line; a signature that is present and wrong always
// refuses. --from=local reads <DATA>/backups; --from=file takes one board database file (for example the
// .pre-restore-<stamp> copy an earlier restore kept, to undo it). The backup (newest, or --file) is
// verified exactly like the restore drill before anything is staged. Exit code 0 only when a restore was
// staged (or cancelled / listed).

import { join } from 'node:path'
import { dataLayout, resolveDataDir } from '@draftroom/dev-assets'
import { backupSigningSecrets, parseBackupStore } from '../config.ts'
import { BOARD_ID_RE } from '../rooms.ts'
import { BACKUP_FILE_RE } from './backup.ts'
import {
  type BackupSource,
  DrillProblem,
  fileBackupSource,
  localBackupSource,
  storeBackupSource,
} from './drill.ts'
import { backupSigningKey } from './signing.ts'
import { cancelStagedRestore, listStagedRestores, stageRestore } from './staged-restore.ts'
import { openBackupStore } from './store.ts'

function parseArgs(argv: string[]) {
  const out = {
    dataDir: null as string | null,
    board: null as string | null,
    file: undefined as string | undefined,
    path: null as string | null,
    from: null as 'local' | 'store' | 'file' | null,
    cancel: false,
    list: false,
    allowUnsigned: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? ''
    const eq = /^(--[a-z-]+)=(.*)$/.exec(a)
    const flag = eq?.[1] ?? a
    const value = () => (eq ? eq[2] : argv[++i]) ?? ''
    if (flag === '--data-dir') out.dataDir = value() || null
    else if (flag === '--board') out.board = value()
    else if (flag === '--file') out.file = value()
    else if (flag === '--path') out.path = value() || null
    else if (flag === '--from') {
      const v = value()
      if (v !== 'local' && v !== 'store' && v !== 'file')
        throw new Error('--from must be store, local or file')
      out.from = v
    } else if (a === '--cancel') out.cancel = true
    else if (a === '--list') out.list = true
    else if (a === '--allow-unsigned') out.allowUnsigned = true
    else throw new Error(`unknown argument ${a.slice(0, 40)}`)
  }
  if (out.allowUnsigned && (out.from !== 'store' || out.cancel || out.list))
    throw new Error('--allow-unsigned only applies to --from=store (local backups are not signed)')
  if (out.board !== null && !BOARD_ID_RE.test(out.board))
    throw new Error(`invalid board id ${out.board.slice(0, 70)}`)
  if (out.file !== undefined && !BACKUP_FILE_RE.test(out.file)) throw new Error('invalid backup file name')
  if (!out.list && !out.board) throw new Error('--board <id> is required')
  if (!out.list && !out.cancel && !out.from)
    throw new Error('--from=store, --from=local or --from=file is required')
  if (out.from === 'file' && !out.path) throw new Error('--from=file needs --path <board database file>')
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const dataDir = dataLayout(args.dataDir ?? resolveDataDir(process.env)).root
  if (args.list) {
    const staged = listStagedRestores(dataDir)
    if (staged.length === 0) console.log('no staged restores')
    for (const r of staged)
      console.log(`${r.boardId} ${r.file} (from ${r.source}, ${r.recordCount} records, staged ${r.stagedAt})`)
    return
  }
  const boardId = args.board ?? ''
  if (args.cancel) {
    console.log(
      cancelStagedRestore(dataDir, boardId)
        ? `cancelled the staged restore of ${boardId}`
        : `no staged restore for ${boardId}`,
    )
    return
  }
  let source: BackupSource
  if (args.from === 'store') {
    const store = openBackupStore(parseBackupStore(process.env, dataDir))
    if (!store)
      throw new Error(
        'DRAFTROOM_BACKUP_STORE is off: set it to fs or r2 (with R2_*) to restore from the store',
      )
    source = storeBackupSource(store, {
      signingKey: backupSigningKey(backupSigningSecrets(process.env)),
      allowUnsigned: args.allowUnsigned,
    })
  } else if (args.from === 'file') source = fileBackupSource(args.path ?? '')
  else source = localBackupSource(join(dataDir, 'backups'))
  try {
    const { request, checks, warnings } = await stageRestore({ dataDir, source, boardId, file: args.file })
    for (const c of checks) console.log(`  ok   ${c}`)
    for (const w of warnings) console.log(`  WARN ${w}`)
    console.log(
      `staged ${boardId} from ${request.source} backup ${request.file}` +
        (request.unsignedAccepted ? ' (UNSIGNED, accepted with --allow-unsigned)' : ''),
    )
    console.log(
      'restart the sync server to apply it (every board reconnects; open tabs of this board reload its state)',
    )
  } catch (e) {
    if (!(e instanceof DrillProblem)) throw e
    for (const p of e.problems) console.log(`  FAIL ${p}`)
    console.log(`nothing staged for ${boardId}`)
    process.exit(1)
  }
}

main().catch((e: unknown) => {
  console.error(`restore board: ${(e as Error)?.message ?? e}`)
  process.exit(1)
})
