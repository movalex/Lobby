// Export control on the Excalidraw canvas (docs/WAVE3-CONTRACTS.md "export-control"; the tldraw page's
// ../export-gate.tsx): while the board owner turned exporting off for this person (viewers, commenters,
// name-only guests under 'editors'), copying the selection does nothing but say why, and the context and
// board menus show that line where their copy and export entries were (the menu shells drop the
// `export` group and the clipboard's copy entries: ./Menu.tsx). UI only: the api refuses the downloads
// themselves.
//
// K1-4 (wave K): the policy is the board's one shared export-policy resource
// (features/sharing/ported/export-policy.ts: read once per board session, every `export-control.policy`
// event, a read after each event-stream reconnect), which every gate on the board reads; this gate used to
// read GET /api/boards/:bid/export-policy itself. Until the first answer it counts as 'everyone' for
// accounts, so boards that never limit anyone do not flash disabled entries; a name-only guest the gate
// KNOWS about fails closed instead (they are limited under 'everyone' too), so they cannot copy in the
// moment before the policy has loaded (CR-3A-4).
import { EXPORT_DISABLED_MESSAGE, type ExportPolicy, exportAllowedFor } from '@draftroom/contracts'
import type { CanvasFeatureContext } from '../../../canvas/api/index.ts'
import { knownUserKind } from '../../../invite/guest.tsx'
import type { BoardRole } from '../../../lib/permissions.ts'
import { type Atom, atom } from '../../../lib/signals.ts'
import { attachExportPolicy, exportStateOf } from '../../sharing/ported/export-policy.ts'

/** What people see wherever copying or exporting is turned off. */
export const EXPORT_OFF_TEXT = EXPORT_DISABLED_MESSAGE
/** The menu line: the notice's words, without the full stop. */
export const EXPORT_OFF_MENU_LABEL = EXPORT_OFF_TEXT.replace(/\.$/, '')

export interface ExportGate {
  /** the board's shared policy (null until the first answer, treated like 'everyone') */
  readonly policy: Atom<ExportPolicy | null>
  /** a name-only guest (null: not known yet) */
  readonly guest: Atom<boolean | null>
}

const gates = new Map<string, ExportGate>()

export function exportGate(boardId: string): ExportGate {
  let g = gates.get(boardId)
  if (!g) {
    g = {
      policy: exportStateOf(boardId).policy,
      guest: atom<boolean | null>(`cux-export-guest:${boardId}`, null),
    }
    gates.set(boardId, g)
  }
  return g
}

/**
 * The rule (pure): unknown role = allowed, unknown kind = not a name-only guest, and an unknown policy
 * (still loading) = allowed for an account but not for a KNOWN name-only guest (`guest === true`): the
 * policy may well limit them, and only 'everyone-including-guests' lets them through.
 */
export function exportAllowedWith(
  role: BoardRole | null,
  policy: ExportPolicy | null,
  guest: boolean | null,
) {
  if (policy === null) return guest !== true
  if (role === null) return true
  return exportAllowedFor(role, policy, { nameOnlyGuest: guest === true })
}

/**
 * For code that has no feature context (the board session's input layer lets a viewer's Ctrl/Cmd+C through
 * only where this says so: CR-3A-4): the same rule as `exportAllowed`, read from this board's gate. The
 * session's own knowledge that this is a name-only guest (its welcome says so) joins the gate's, and a
 * known guest is not let through before the first policy answer (`exportAllowedWith`); an account is, as
 * the menus are.
 */
export function exportAllowedOnBoard(
  boardId: string,
  role: BoardRole | null,
  nameOnlyGuest: boolean,
): boolean {
  const g = exportGate(boardId)
  return exportAllowedWith(role, g.policy.get(), nameOnlyGuest ? true : g.guest.get())
}

/** Reactive (inside useValue / react): may this person copy and export here? */
export function exportAllowed(ctx: Pick<CanvasFeatureContext, 'board' | 'role'>): boolean {
  const g = exportGate(ctx.board.id)
  return exportAllowedWith(ctx.role, g.policy.get(), g.guest.get())
}

/** Says why a copy or an export did nothing. */
export function notifyExportOff(ctx: Pick<CanvasFeatureContext, 'notify'>) {
  ctx.notify({ key: 'export-off', text: EXPORT_OFF_TEXT, testId: 'export-off-notice', timeoutMs: 6000 })
}

/** true when exporting is allowed; otherwise shows the notice and returns false. */
export function guardExport(ctx: Pick<CanvasFeatureContext, 'board' | 'role' | 'notify'>): boolean {
  if (exportAllowed(ctx)) return true
  notifyExportOff(ctx)
  return false
}

/**
 * Keeps this board's policy current while canvas-ux is installed: attaches to the board's shared resource
 * (one read per board session for every gate; an answer to a request sent before a later event never
 * overwrites that event) and records whether this person is a name-only guest.
 */
export function syncExportGate(ctx: CanvasFeatureContext): () => void {
  const g = exportGate(ctx.board.id)
  const kind = knownUserKind(ctx.me.user.id)
  if (kind !== null) g.guest.set(kind === 'guest')
  return attachExportPolicy({ boardId: ctx.board.id, api: ctx.api, events: ctx.events })
}

const isEditable = (el: EventTarget | null) =>
  typeof HTMLElement !== 'undefined' &&
  el instanceof HTMLElement &&
  (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')

/**
 * Whether a native copy or cut is a copy of the selected elements while exporting is off: the board has
 * the keyboard, something is selected, no editor is open and no text field holds the keys. Text copied
 * from fields and panels is left alone. Pure.
 */
export function blocksNativeCopy(s: {
  allowed: boolean
  onBoard: boolean
  editing: boolean
  selected: number
  inEditable: boolean
}): boolean {
  return !s.allowed && s.onBoard && !s.editing && s.selected > 0 && !s.inEditable
}

/**
 * Ctrl/Cmd+C and Ctrl/Cmd+X on the board, stopped in the capture phase on the board's region (an
 * ancestor of the engine's wrapper, so before the engine and Lobby's own clipboard listeners).
 */
export function installCopyGuard(ctx: CanvasFeatureContext): () => void {
  const root = ctx.canvas.container()
  if (!root) return () => {}
  const onCopy = (e: ClipboardEvent) => {
    const doc = root.ownerDocument
    const block = blocksNativeCopy({
      allowed: exportAllowed(ctx),
      onBoard: ctx.canvas.hasKeyboard(),
      editing: ctx.canvas.editingId() !== null,
      selected: ctx.canvas.selection.length,
      inEditable: isEditable(e.target) || isEditable(doc.activeElement),
    })
    if (!block) return
    e.preventDefault()
    e.stopImmediatePropagation()
    notifyExportOff(ctx)
  }
  root.addEventListener('copy', onCopy, true)
  root.addEventListener('cut', onCopy, true)
  return () => {
    root.removeEventListener('copy', onCopy, true)
    root.removeEventListener('cut', onCopy, true)
  }
}
