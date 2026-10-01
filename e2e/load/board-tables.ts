// Which tables a board file has, and whether it is converted (docs/EXCALIDRAW-MIGRATION.md §8.3 B9, the
// conversion-under-load pass: "the planted board is reported as failed and stays on its tldraw tables").
// Opens the file read-only and prints table names, `lb_meta.converted_from` presence and the file's size (bytes
// after the conversion, next to gen-boards' bytes before), never content:
//   node e2e/load/board-tables.ts <board file> [...]
import { existsSync, statSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

for (const file of process.argv.slice(2)) {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
        name: string
      }[]
    ).map((r) => r.name)
    const converted =
      tables.includes('lb_meta') &&
      (db.prepare("SELECT count(*) AS n FROM lb_meta WHERE key = 'converted_from'").get() as { n: number })
        .n > 0
    console.log(
      JSON.stringify({
        file: file.split(/[\\/]/).pop(),
        tldraw: tables.includes('documents'),
        lb: tables.filter((t) => t.startsWith('lb_')),
        converted,
        bytes: statSync(file).size,
        walBytes: existsSync(`${file}-wal`) ? statSync(`${file}-wal`).size : 0,
        tables,
      }),
    )
  } finally {
    db.close()
  }
}
