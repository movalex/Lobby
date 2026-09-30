// Checks RoomRegistry.open() runs before it opens a board file for writing (bridge release R0,
// docs/EXCALIDRAW-MIGRATION.md §5.9 step 4, §5.10). The shape of the spike's engine-switch.ts pre-open
// hook, so the new build can keep the same seam.
//
// The born-after check (born-after.ts) is always registered: R0 refuses every board born on the new
// canvas, whichever entry point reaches it. A refusal is a BoardOpenRefused: app.ts closes the socket with
// 4099 NEW_CANVAS_BOARD, the internal router answers 409 `new-canvas`.

import { classifyBoardFile, isServable } from './born-after.ts'

export interface PreOpenContext {
  readonly boardId: string
  /** the board file's absolute path */
  readonly path: string
  /** whether the file exists (a new board has none; a check must never create it) */
  readonly exists: boolean
}
export type PreOpenVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: 'new-canvas' }
/** Synchronous, like RoomRegistry.open(): no await between the check and the open. */
export type PreOpenCheck = (ctx: PreOpenContext) => PreOpenVerdict

/** The terminal socket close reason of a refused board (the web explains it, SyncErrorScreen.tsx). */
export const NEW_CANVAS_CLOSE_REASON = 'NEW_CANVAS_BOARD'
/** The internal routes' error code for a refused board. */
export const NEW_CANVAS_ERROR_CODE = 'new-canvas'

/** A board a pre-open check refused. */
export class BoardOpenRefused extends Error {
  readonly boardId: string
  readonly reason: 'new-canvas'
  constructor(boardId: string, reason: 'new-canvas') {
    super('This board was made on the new canvas. It opens again when Lobby is back on the new canvas.')
    this.name = 'BoardOpenRefused'
    this.boardId = boardId
    this.reason = reason
  }
}

/** R0's check: tldraw and converted boards are served, every other file with lb_* tables is refused. */
export const bornAfterCheck: PreOpenCheck = (ctx) =>
  !ctx.exists || isServable(classifyBoardFile(ctx.path)) ? { ok: true } : { ok: false, reason: 'new-canvas' }

const checks: PreOpenCheck[] = [bornAfterCheck]

/** Adds a check that runs after the ones already registered. Returns the unregister function. */
export function registerPreOpenCheck(check: PreOpenCheck): () => void {
  checks.push(check)
  return () => {
    const i = checks.indexOf(check)
    if (i >= 0) checks.splice(i, 1)
  }
}

/** Runs every registered check; throws BoardOpenRefused on the first refusal. */
export function runPreOpenChecks(ctx: PreOpenContext): void {
  for (const check of [...checks]) {
    const verdict = check(ctx)
    if (!verdict.ok) throw new BoardOpenRefused(ctx.boardId, verdict.reason)
  }
}
