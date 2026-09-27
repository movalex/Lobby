// Restore drill CLI (docs/FEATURES-M2-CONTRACTS.md "history", build plan §7).
//
//   node apps/sync/src/backup/restore-drill.ts [--data-dir <DATA>] [--board <id>]... [--backup-first] [--keep]
//   (intended as `pnpm --filter @draftroom/sync backup:restore-drill`)
//
// Restores the newest backup of each board (or the given ones) into a clean temp data dir and checks
// the records match; exit code 0 only if every board passed and at least one was drilled.
// --backup-first makes a fresh backup of every board database in <DATA>/rooms first (a plain SQLite
// connection and the online-backup API; safe next to a running server) so a dev data dir without
// periodic backups yet can be drilled right away.

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { dataLayout, resolveDataDir } from '@draftroom/dev-assets'
import { BOARD_ID_RE } from '../rooms.ts'
import { backupBoard } from './backup.ts'
import { runRestoreDrill } from './drill.ts'

function parseArgs(argv: string[]) {
  const out = { dataDir: null as string | null, boards: [] as string[], backupFirst: false, keep: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--data-dir') out.dataDir = argv[++i] ?? null
    else if (a === '--board') out.boards.push(argv[++i] ?? '')
    else if (a === '--backup-first') out.backupFirst = true
    else if (a === '--keep') out.keep = true
    else throw new Error(`unknown argument ${a}`)
  }
  for (const b of out.boards) if (!BOARD_ID_RE.test(b)) throw new Error(`invalid board id ${b}`)
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const dataDir = args.dataDir ?? resolveDataDir(process.env)
  const layout = dataLayout(dataDir)
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
  const report = await runRestoreDrill({ dataDir, boardIds: args.boards, keepWorkDir: args.keep })
  if (report.boards.length === 0) console.log(`no backups found under ${join(layout.root, 'backups')}`)
  for (const b of report.boards) {
    console.log(`${b.ok ? 'PASS' : 'FAIL'} ${b.boardId} ${b.backupFile ?? '(no backup)'}`)
    for (const c of b.checks) console.log(`  ok   ${c}`)
    for (const p of b.problems) console.log(`  FAIL ${p}`)
  }
  if (args.keep) console.log(`restored copies kept in ${report.workDir}`)
  console.log(report.ok ? 'restore drill passed' : 'restore drill FAILED')
  process.exit(report.ok ? 0 : 1)
}

main().catch((e: unknown) => {
  console.error(`restore drill: ${(e as Error)?.message ?? e}`)
  process.exit(1)
})
