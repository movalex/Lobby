// gen-boards (docs/EXCALIDRAW-MIGRATION.md §8.3 B9, §8.6.6): writes the load runs' test boards into sync's
// data dir, before sync starts, inside the pinned Node image with `--network none` on the NAS:
//
//   node e2e/load/gen-boards.ts --data-dir /var/data [--profile L1,L2] [--cul] [--overcap-notes 60000]
//
//  - the boards of each profile (plan.ts boardsOf: L1's workshop board and its 20 light boards, L2's heavy
//    board) as lb_* files (board-files.ts), the same boards run.ts regenerates in memory;
//  - with --cul (the conversion-under-load run): `cul-heavy`, an unconverted tldraw copy of the heavy
//    board's notes (4,500), `cul-second`, another unconverted board (600 notes), and `cul-overcap`, the
//    planted board larger than the worker's heap cap (--overcap-notes notes of --overcap-chars
//    characters; set it from O4's measured cap, §2.13: at most 128 MB of heap);
//  - a manifest (`<data-dir>/load-boards.json`: ids, element counts, bytes, ms; no content) and the same
//    lines on stdout.
// It never overwrites a board file, and refuses a data dir that already has one of its boards.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { type WrittenBoard, writeLbBoard, writeTldrawBoard } from './board-files.ts'
import { boardsOf } from './plan.ts'
import { PROFILES } from './profiles.ts'

const { values } = parseArgs({
  options: {
    'data-dir': { type: 'string' },
    profile: { type: 'string', default: 'L1,L2' },
    cul: { type: 'boolean', default: false },
    'overcap-notes': { type: 'string', default: '60000' },
    'overcap-chars': { type: 'string', default: '2000' },
  },
})
const dataDir = values['data-dir']
if (!dataDir) throw new Error('--data-dir is required (sync DRAFTROOM_DATA_DIR)')

const written: (WrittenBoard & { kind: string })[] = []
const log = (w: WrittenBoard & { kind: string }) =>
  console.log(
    `[gen-boards] ${w.kind} ${w.boardId}: ${w.rows} rows, ${(w.bytes / 1e6).toFixed(1)} MB, ${w.ms} ms`,
  )

for (const name of (values.profile as string).split(',').filter(Boolean)) {
  const profile = PROFILES[name]
  if (!profile) throw new Error(`unknown profile ${name}`)
  for (const [id, board] of boardsOf(profile)) {
    const w = { ...writeLbBoard(dataDir, id, board.elements), kind: `lb ${board.spec.kind}` }
    written.push(w)
    log(w)
  }
}
if (values.cul) {
  for (const [id, notes, chars] of [
    ['cul-heavy', 4_500, 60],
    ['cul-second', 600, 60],
    ['cul-overcap', Number(values['overcap-notes']), Number(values['overcap-chars'])],
  ] as const) {
    const w = { ...writeTldrawBoard(dataDir, id, { notes, textChars: chars }), kind: 'tldraw' }
    written.push(w)
    log(w)
  }
}
writeFileSync(
  join(dataDir, 'load-boards.json'),
  JSON.stringify(
    written.map(({ path: _path, ...w }) => w),
    null,
    1,
  ),
)
console.log(`[gen-boards] ${written.length} boards, manifest ${join(dataDir, 'load-boards.json')}`)
