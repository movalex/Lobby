// Checks RoomRegistry.open() runs before it opens a board file for writing (bridge release R0,
// docs/EXCALIDRAW-MIGRATION.md §5.9 step 4, §5.10).
//
// On main (R0) this module held its own list of checks, in the shape of the spike's engine-switch.ts
// pre-open hook "so the new build can keep the same seam". On the Excalidraw branch it is that seam: the
// types, BoardOpenRefused and the one list of checks are spike B's (engine-switch.ts), re-exported here so
// R0's code and tests keep their imports.
//
// The born-after check (born-after.ts) is registered when this module loads, and rooms.ts imports it, so
// the tldraw RoomRegistry refuses every board born on the new canvas whichever entry point reaches it, as
// R0 does. With DRAFTROOM_ENGINE=excalidraw the tldraw registry stays idle (sockets and board routes go to
// the ElementRoom, which never runs these checks). A refusal is a BoardOpenRefused: app.ts closes the socket
// with 4099 NEW_CANVAS_BOARD, the internal router answers 409 `new-canvas`.

import {
  BoardOpenRefused,
  type PreOpenCheck,
  type PreOpenContext,
  type PreOpenVerdict,
  registerPreOpenCheck,
  runPreOpenChecks,
} from '../engine-switch.ts'
import { classifyBoardFile, isServable } from './born-after.ts'

export type { PreOpenCheck, PreOpenContext, PreOpenVerdict }
export { BoardOpenRefused, registerPreOpenCheck, runPreOpenChecks }

/** The terminal socket close reason of a refused board (the web explains it, SyncErrorScreen.tsx). */
export const NEW_CANVAS_CLOSE_REASON = 'NEW_CANVAS_BOARD'
/** The internal routes' error code for a refused board. */
export const NEW_CANVAS_ERROR_CODE = 'new-canvas'

/** R0's check: tldraw and converted boards are served, every other file with lb_* tables is refused. */
export const bornAfterCheck: PreOpenCheck = (ctx) =>
  !ctx.exists || isServable(classifyBoardFile(ctx.path)) ? { ok: true } : { ok: false, reason: 'new-canvas' }

/** Removes R0's check again (tests). Registered once: ES modules evaluate once. */
export const unregisterBornAfterCheck = registerPreOpenCheck(bornAfterCheck)
