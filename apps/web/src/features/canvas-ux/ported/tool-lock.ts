// K2-2 (wave K, UXD-06): the tool lock. A placement tool (Note, Text) returns to Select after ONE placement,
// as Miro and FigJam do, so a click after finishing a text no longer opens another text (and a stray key no
// longer leaves a one-letter text on a colleague's board). With the lock on (Q, or a double-click on a tool in
// the toolbar) every tool stays picked: Note and Text keep placing, and the engine's drawing tools (rectangle,
// connector, pen…) keep drawing, as the engine's own padlock does. The lock is this page's only (never synced,
// never stored) and stays until Q turns it off again.
//
// Read by the board page (canvas/board/session.ts, the N and T placement; canvas/tools/tools.ts, the engine
// tools' `locked`) and toggled by canvas-ux (./commands.ts `canvas-ux.tool-lock`, ./Toolbar.tsx). Pure.
import { atom } from '../../../lib/signals.ts'

/** The lock: every tool stays picked after it places or draws something. */
export const toolLock = atom('lobby.canvas-ux.tool-lock', false)

/** The Lobby tools that return to Select after a placement unless the lock is on. */
export const PLACEMENT_TOOLS: ReadonlySet<string> = new Set(['note', 'text'])

/** The tool after a placement with `tool`: Select, or null to stay on it (the lock is on, or not a placement tool). */
export function toolAfterPlacement(tool: string, locked: boolean): 'select' | null {
  return PLACEMENT_TOOLS.has(tool) && !locked ? 'select' : null
}

/** What the board says when the lock changes (a notice: the toolbar's tooltip says it too). */
export function toolLockNotice(on: boolean): string {
  return on
    ? 'Tool lock on: the tool stays picked after each placement. Press Q to turn it off.'
    : 'Tool lock off: tools go back to Select after one placement.'
}
