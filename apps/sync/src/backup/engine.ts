// Which engine's board files this process backs up, describes, drills and restores (2B; the bridge release
// R0's contracts 3 and 4, docs/EXCALIDRAW-MIGRATION.md "Contracts R0 fixed", §5.6, §5.9). One engine per
// process, set once at start: app.ts from DRAFTROOM_ENGINE, the operator tools (restore-board, the restore
// drill) from the same variable in the service's shell. The default is the tldraw build's: R0's rules.
//
//   tldraw (R0 and the default build until wave 4): a board file is described from its tldraw tables; a
//     file with only lb_* tables (born on the new canvas) is copied whole as `lobby-elements`, checked as
//     far as this build can, and never restored or replaced; a converted board's lb_* tables are carried
//     into a restored file unchanged (r0/lb-carry.ts).
//   excalidraw: a converted board (lb_* with converted_from, plus tldraw's tables, which a rollback still
//     needs) is described from its lb_* tables as `lobby-elements-converted`, a format R0 keeps listed and
//     under retention and refuses to drill or restore by name; `lobby-elements` and converted backups are
//     opened through the element room's store when drilled, and restored with a new epoch; a tldraw
//     backup (from before the cut-over) is restored as it is and converted when its room opens (§5.6).

export type BackupEngine = 'tldraw' | 'excalidraw'

let engine: BackupEngine = 'tldraw'

/** Sets the engine for this process (app.ts at start; tests set and reset it). */
export function setBackupEngine(e: BackupEngine): void {
  engine = e
}

export const backupEngine = (): BackupEngine => engine
