// Restore drill CLI (docs/FEATURES-M2-CONTRACTS.md "history", docs/WAVE3-CONTRACTS.md
// "offsite-backups", build plan §7).
//
//   pnpm --filter @draftroom/sync backup:restore-drill [--from=local|store] [--data-dir <DATA>]
//     [--board <id>]... [--backup-first] [--keep] [--allow-unsigned]
//   (on a server without pnpm: node apps/sync/src/backup/restore-drill.ts ...)
//
// Restores the newest backup of each board (or the given ones) into a clean temp data dir and checks
// the records match; exit code 0 only if every board passed and at least one was drilled.
//   --from=local (default) drills <DATA>/backups.
//   --from=store downloads from the offsite store configured by DRAFTROOM_BACKUP_STORE (fs: under
//     <DATA>/blobs; r2: DRAFTROOM_BACKUP_R2_* or the R2_* values). First it verifies the signatures of
//     the index, the manifest and the entry with the key derived from DRAFTROOM_INTERNAL_SECRET (the
//     sync server's), then checks size and sha256 against the offsite manifest. Without --board it
//     drills every board listed in the store's index. Read-only on the store.
//   --allow-unsigned (store only) also accepts what has no signature (written before backups were
//     signed) or was signed with another key, and prints a WARN line for each. A signature that is
//     present and wrong always fails.
// --backup-first (local only) makes a fresh backup of every board database in <DATA>/rooms first (a
// plain SQLite connection and the online-backup API; safe next to a running server) so a dev data dir
// without periodic backups yet can be drilled right away.

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { dataLayout, resolveDataDir } from '@draftroom/dev-assets'
import { backupSigningSecret, parseBackupStore } from '../config.ts'
import { BOARD_ID_RE } from '../rooms.ts'
import { backupBoard } from './backup.ts'
import { runRestoreDrill, storeBackupSource } from './drill.ts'
import { backupSigningKey } from './signing.ts'
import { openBackupStore } from './store.ts'

function parseArgs(argv: string[]) {
  const out = {
    dataDir: null as string | null,
    boards: [] as string[],
    backupFirst: false,
    keep: false,
    allowUnsigned: false,
    from: 'local' as 'local' | 'store',
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? ''
    const eq = /^(--[a-z-]+)=(.*)$/.exec(a)
    const flag = eq?.[1] ?? a
    const value = () => (eq ? eq[2] : argv[++i]) ?? ''
    if (flag === '--data-dir') out.dataDir = value() || null
    else if (flag === '--board') out.boards.push(value())
    else if (flag === '--from') {
      const v = value()
      if (v !== 'local' && v !== 'store') throw new Error('--from must be local or store')
      out.from = v
    } else if (a === '--backup-first') out.backupFirst = true
    else if (a === '--keep') out.keep = true
    else if (a === '--allow-unsigned') out.allowUnsigned = true
    else throw new Error(`unknown argument ${a.slice(0, 40)}`)
  }
  for (const b of out.boards) if (!BOARD_ID_RE.test(b)) throw new Error(`invalid board id ${b.slice(0, 70)}`)
  if (out.backupFirst && out.from === 'store')
    throw new Error('--backup-first only applies to --from=local (the running sync server uploads offsite)')
  if (out.allowUnsigned && out.from !== 'store')
    throw new Error('--allow-unsigned only applies to --from=store (local backups are not signed)')
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const dataDir = args.dataDir ?? resolveDataDir(process.env)
  const layout = dataLayout(dataDir)
  let source: ReturnType<typeof storeBackupSource> | undefined
  if (args.from === 'store') {
    const store = openBackupStore(parseBackupStore(process.env, layout.root))
    if (!store)
      throw new Error(
        'DRAFTROOM_BACKUP_STORE is off: set it to fs or r2 (with R2_*) to drill the offsite store',
      )
    source = storeBackupSource(store, {
      signingKey: backupSigningKey(backupSigningSecret(process.env)),
      allowUnsigned: args.allowUnsigned,
    })
  }
  if (args.backupFirst) {
    const files = existsSync(layout.rooms) ? readdirSync(layout.rooms) : []
    for (const f of files) {
      const m = /^board-([a-z0-9][a-z0-9_-]{2,63})\.sqlite$/.exec(f)
      if (!m?.[1] || (args.boards.length && !args.boards.includes(m[1]))) continue
      const db = new DatabaseSync(join(layout.rooms, f))
      try {
        const e = await backupBoard({ db, boardId: m[1], root: join(layout.root, 'backups') })
        console.log(`backed up ${m[1]} -> ${e.file} (${e.recordCount} records, clock ${e.documentClock})`)
      } finally {
        db.close()
      }
    }
  }
  const report = await runRestoreDrill({ dataDir, source, boardIds: args.boards, keepWorkDir: args.keep })
  for (const w of report.warnings) console.log(`  WARN ${w}`)
  if (report.boards.length === 0)
    console.log(
      source
        ? `no backups found in the offsite ${report.source} store`
        : `no backups found under ${join(layout.root, 'backups')}`,
    )
  for (const b of report.boards) {
    console.log(`${b.ok ? 'PASS' : 'FAIL'} ${b.boardId} ${b.backupFile ?? '(no usable backup)'}`)
    for (const c of b.checks) console.log(`  ok   ${c}`)
    for (const w of b.warnings) console.log(`  WARN ${w}`)
    for (const p of b.problems) console.log(`  FAIL ${p}`)
  }
  if (args.keep) console.log(`restored copies kept in ${report.workDir}`)
  const unverified = report.warnings.length > 0 || report.boards.some((b) => b.warnings.length > 0)
  console.log(
    !report.ok
      ? 'restore drill FAILED'
      : unverified
        ? 'restore drill passed, with unsigned backups accepted (--allow-unsigned)'
        : 'restore drill passed',
  )
  process.exit(report.ok ? 0 : 1)
}

main().catch((e: unknown) => {
  console.error(`restore drill: ${(e as Error)?.message ?? e}`)
  process.exit(1)
})
