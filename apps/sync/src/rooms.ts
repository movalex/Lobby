// Board files and the words the rest of the server shares about them. Until wave 4 part 2 this module
// was the tldraw room registry (TLSocketRoom over SQLiteSyncStorage); the Excalidraw engine's rooms are
// apps/sync/src/room/** (ElementRoom), and this keeps only what both eras share: the board id rule, where
// a board's file is, the files of a rooms folder and where their backups go.
import { readdirSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { BoardRole } from './permissions.ts'

/** Per-session data taken from the verified ticket (docs/M1-CONTRACTS.md §6). */
export interface SessionMeta {
  userId: string
  role: BoardRole
  /** The ticket's name: the only one the session may be shown as. */
  name: string
  /** The ticket's color as everyone is shown it (presenceIdentity: a plain hex color or the fallback). */
  color: string
}

/**
 * Lowercase only: Windows (NTFS) and macOS (APFS default) are case-insensitive, so 'Board' and
 * 'board' would otherwise be two rooms on ONE sqlite file (split room).
 */
export const BOARD_ID_RE = /^[a-z0-9][a-z0-9_-]{2,63}$/

/** A board database file name in the rooms folder (boardDbPath); the capture is the board id. */
export const BOARD_FILE_RE = /^board-([a-z0-9][a-z0-9_-]{2,63})\.sqlite$/

export function boardDbPath(dataDir: string, boardId: string): string {
  if (!BOARD_ID_RE.test(boardId)) throw new Error('invalid board id')
  // 'board-' prefix: the file base name can never be a Windows device name (con, nul, com1, ...)
  return join(resolve(dataDir), `board-${boardId}.sqlite`)
}

/** Ids of every board that has a database file in `roomsDir`, sorted ([] when the folder is missing). */
export function boardFileIds(roomsDir: string): string[] {
  let names: string[]
  try {
    names = readdirSync(roomsDir)
  } catch {
    return []
  }
  return names
    .map((n) => BOARD_FILE_RE.exec(n)?.[1])
    .filter((id): id is string => id !== undefined && BOARD_ID_RE.test(id))
    .sort()
}

/**
 * Where a rooms folder's local backups go: `<DATA>/backups` when `roomsDir` is the data layout's
 * `<DATA>/rooms` (the folder the server uses), else null (backups off: a bare folder in a test).
 */
export function backupsDirFor(roomsDir: string): string | null {
  const rooms = resolve(roomsDir)
  return basename(rooms) === 'rooms' ? join(dirname(rooms), 'backups') : null
}
