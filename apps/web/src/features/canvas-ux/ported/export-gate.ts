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
// read GET /api/boards/:bid/export-policy itself. Until the first answer it fails closed (wave K.1): only the
// owner and an editor with an account, whom no policy limits, copy and export then; a viewer, a commenter or
// a name-only guest cannot copy in the moment before the policy has loaded (CR-3A-4 closed it for guests).
import { EXPORT_DISABLED_MESSAGE, type ExportPolicy } from '@draftroom/contracts'
import type { CanvasFeatureContext } from '../../../canvas/api/index.ts'
import { knownUserKind } from '../../../invite/guest.tsx'
import type { BoardRole } from '../../../lib/permissions.ts'
import { type Atom, atom } from '../../../lib/signals.ts'
import { boardExportAllowed, notifyExportPending } from '../../sharing/export-rules.ts'
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
 * The rule (pure): the board page's `boardExportAllowed` (../../sharing/export-rules.ts). An unknown policy
 * (still loading) lets through only the owner and an editor known to have an account, whom no policy limits
 * (wave K.1: before, it let every account through, so a viewer could copy on an export-off board in that
 * moment); a known policy decides as before (unknown role = allowed, unknown kind = not a name-only guest).
 */
export function exportAllowedWith(
  role: BoardRole | null,
  policy: ExportPolicy | null,
  guest: boolean | null,
) {
  return boardExportAllowed(role, policy, guest)
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
  // the session's welcome is authoritative about the kind (it asks after the welcome): false is an account
  return exportAllowedWith(role, g.policy.get(), nameOnlyGuest || g.guest.get() === true)
}

/** Reactive (inside useValue / react): may this person copy and export here? */
export function exportAllowed(ctx: Pick<CanvasFeatureContext, 'board' | 'role'>): boolean {
  const g = exportGate(ctx.board.id)
  return exportAllowedWith(ctx.role, g.policy.get(), g.guest.get())
}

/** Whether the board's policy is still unknown (wave K.1: the gates are closed then, but nothing is "off"). */
export const exportPending = (ctx: Pick<CanvasFeatureContext, 'board'>): boolean =>
  exportGate(ctx.board.id).policy.get() === null

/** Says why a copy or an export did nothing (before the first policy answer: that it is still being checked). */
export function notifyExportOff(
  ctx: Pick<CanvasFeatureContext, 'notify'> & Partial<Pick<CanvasFeatureContext, 'board'>>,
) {
  if (ctx.board && exportPending({ board: ctx.board })) return notifyExportPending(ctx.notify)
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
