// canvas-ux's commands on the Excalidraw canvas (docs/EXCALIDRAW-CONTRACTS.md §3 `commands`): what the
// tldraw page's actions and the canvas-ux overrides did (../overrides.tsx, ../shortcuts.ts), for the
// menus, the selection bar, the shortcuts dialog and the keys. Every write is one `transact` (one undo
// step); the server refuses what a read-only role or a lock does not allow.
//
// Keys (docs/EXCALIDRAW-MIGRATION.md §2.3.3): a command's `kbd` is a Lobby-owned key, dispatched by the
// board page's key registry before the allowlist. The keys Excalidraw keeps (Delete, Ctrl+D, Ctrl+G,
// Ctrl+Shift+G, Ctrl+[ ], arrows, Space, Ctrl+= / Ctrl+-) and the ones the allowlist takes itself (the
// tool letters, Ctrl+Z / Ctrl+Y, Ctrl+A, type-to-edit, Enter on a text) are NOT claimed here: their
// commands exist for the menus only.
//  - MAK-05: Ctrl/Cmd+Shift+L locks and unlocks, and the (now locked) selection is kept, as Miro does
//    (Excalidraw's own lock deselects and groups a locked multi-selection; this one only sets `locked`).
//    Locking a frame locks what is inside it, as Excalidraw's own lock does.
//  - MAK-06: PgUp/PgDn to front/back, Shift+PgUp/PgDn one step; tldraw's ] [ and Alt+] Alt+[ kept.
//  - tldraw's align keys (Alt+A/H/W/V/S, Alt+Shift+H/V) stay on the selection's align and distribute.
//    Align right loses tldraw's Alt+D: it is the browser's address bar (plan §2.3.3 "browser chords pass
//    untouched"); the button and the menus still have it.
//  - A11Y2-07: "?" and Ctrl/Cmd+/ open the keyboard shortcuts (Ctrl/Cmd+Alt+/ too); nothing flips the theme.
//  - Ctrl/Cmd+U opens the file picker (Insert file).
//  - Ctrl/Cmd+X cuts (the allowlist blocks the chord itself; ./export-gate.ts and the input layer apply the
//    export policy to the cut event).
import type {
  CanvasElement,
  CanvasFeatureContext,
  CommandSource,
  CommandSpec,
  LobbyCanvas,
  ReorderTo,
} from '../../../canvas/api/index.ts'
import { items as itemsApi } from '../../../canvas/api/index.ts'
import {
  type AlignOp,
  alignDeltas,
  type DistributeOp,
  distributeDeltas,
  moveUnits,
  unitsOf,
} from './align.ts'
import { guardExport } from './export-gate.ts'
import { pickFiles } from './insert-file.ts'
import { readSessionSettings, writeSessionSettings } from './session-settings.ts'
import { uxState } from './state.ts'

/** Command ids (also the menus' and the selection bar's). */
export const CMD = {
  undo: 'canvas-ux.undo',
  redo: 'canvas-ux.redo',
  cut: 'canvas-ux.cut',
  copy: 'canvas-ux.copy',
  paste: 'canvas-ux.paste',
  duplicate: 'canvas-ux.duplicate',
  delete: 'canvas-ux.delete',
  selectAll: 'canvas-ux.select-all',
  selectNone: 'canvas-ux.select-none',
  group: 'canvas-ux.group',
  ungroup: 'canvas-ux.ungroup',
  toggleLock: 'canvas-ux.toggle-lock',
  unlockAll: 'canvas-ux.unlock-all',
  bringToFront: 'canvas-ux.bring-to-front',
  sendToBack: 'canvas-ux.send-to-back',
  bringForward: 'canvas-ux.bring-forward',
  sendBackward: 'canvas-ux.send-backward',
  alignLeft: 'canvas-ux.align-left',
  alignCenterH: 'canvas-ux.align-center-horizontal',
  alignRight: 'canvas-ux.align-right',
  alignTop: 'canvas-ux.align-top',
  alignCenterV: 'canvas-ux.align-center-vertical',
  alignBottom: 'canvas-ux.align-bottom',
  distributeH: 'canvas-ux.distribute-horizontal',
  distributeV: 'canvas-ux.distribute-vertical',
  shortcuts: 'canvas-ux.keyboard-shortcuts',
  insertFile: 'canvas-ux.insert-file',
  toggleNoteAuthors: 'canvas-ux.toggle-note-authors',
  toggleSnap: 'canvas-ux.toggle-snap',
  toggleGrid: 'canvas-ux.toggle-grid',
} as const

/** Copy for the board settings (honest about what they do and do not do; ../overrides.tsx). */
export const BOARD_SETTING_COPY = {
  authorsHidden:
    'Note authors are hidden for everyone on this board: on the board, in Present and in exports. This is not anonymity: the board still records who last edited each note.',
  authorsShown: 'Note authors are shown again.',
} as const

// ---- the selection ---------------------------------------------------------------------------------------

const live = (el: CanvasElement | undefined): el is CanvasElement =>
  !!el && !(el as { isDeleted?: boolean }).isDeleted

/** The selection as containers (a selected label counts as its container), live only. */
export function selectedRoots(canvas: LobbyCanvas): CanvasElement[] {
  const out = new Map<string, CanvasElement>()
  for (const id of canvas.selection) {
    const el = canvas.get(id)
    if (!live(el)) continue
    const root = itemsApi.containerOf(el, (x) => canvas.get(x))
    out.set(root.id, root)
  }
  return [...out.values()]
}

/** Ids a lock change writes for `roots`: each root, its bound label and, for a frame, what is inside it. */
export function lockTargets(canvas: LobbyCanvas, roots: readonly CanvasElement[]): string[] {
  const all = canvas.items()
  const out = new Set<string>()
  const add = (el: CanvasElement) => {
    if (out.has(el.id)) return
    out.add(el.id)
    const label = itemsApi.labelOf(el, (x) => canvas.get(x))
    if (label) out.add(label.id)
    if (el.type === 'frame')
      for (const c of itemsApi.childrenOf(el.id, all)) {
        const child = canvas.get(c)
        if (live(child)) add(child)
      }
  }
  for (const r of roots) add(r)
  return [...out]
}

/** MAK-05: lock or unlock the selection, keeping it selected. Returns the new state, or null. */
export function toggleLock(ctx: CanvasFeatureContext): boolean | null {
  const { canvas } = ctx
  if (canvas.readOnly()) return null
  const roots = selectedRoots(canvas)
  if (!roots.length) return null
  const next = !roots.every((r) => r.locked)
  const ids = canvas.selection
  const targets = lockTargets(canvas, roots)
  canvas.transact(next ? 'lock' : 'unlock', (tx) => {
    for (const id of targets) if (canvas.get(id)?.locked !== next) tx.update(id, { locked: next })
  })
  canvas.select(ids)
  return next
}

/** "Unlock all": every locked element (labels and frame contents too); what it unlocked is selected. */
export function unlockAll(ctx: CanvasFeatureContext): number {
  const { canvas } = ctx
  if (canvas.readOnly()) return 0
  const locked = canvas.items().filter((e) => live(e) && e.locked)
  if (!locked.length) return 0
  canvas.transact('unlock all', (tx) => {
    for (const e of locked) tx.update(e.id, { locked: false })
  })
  canvas.select(locked.filter((e) => !(e.type === 'text' && e.containerId)).map((e) => e.id))
  return locked.length
}

/** Whether the board holds a locked element (the menus' "Unlock all"). */
export const hasLocked = (canvas: LobbyCanvas) => canvas.items().some((e) => live(e) && e.locked)

function reorder(ctx: CanvasFeatureContext, to: ReorderTo) {
  const { canvas } = ctx
  const ids = selectedRoots(canvas)
    .filter((e) => !e.locked)
    .map((e) => e.id)
  if (!ids.length || canvas.readOnly()) return
  canvas.transact(`reorder ${to}`, (tx) => tx.reorder(ids, to))
}

function align(ctx: CanvasFeatureContext, op: AlignOp) {
  const { canvas } = ctx
  if (canvas.readOnly()) return
  const units = unitsOf(canvas, canvas.selection)
  const deltas = alignDeltas(units, op)
  if (!deltas.size) return
  canvas.transact(`align ${op}`, (tx) => moveUnits(canvas, tx, units, deltas))
}

function distribute(ctx: CanvasFeatureContext, op: DistributeOp) {
  const { canvas } = ctx
  if (canvas.readOnly()) return
  const units = unitsOf(canvas, canvas.selection)
  const deltas = distributeDeltas(units, op)
  if (!deltas.size) return
  canvas.transact(`distribute ${op}`, (tx) => moveUnits(canvas, tx, units, deltas))
}

/** Select all: live, unlocked, not a bound label (the hidden ones are filtered by `select`). */
export function selectAll(canvas: LobbyCanvas) {
  canvas.select(
    canvas
      .items()
      .filter((e) => live(e) && !e.locked && !(e.type === 'text' && e.containerId))
      .map((e) => e.id),
  )
}

/** The board keeps the keyboard after a menu command. */
const refocus = (ctx: CanvasFeatureContext, source: CommandSource) => {
  if (source !== 'kbd') ctx.canvas.focus({ preventScroll: true })
}

/**
 * Copy or cut the selection through the engine's own clipboard (the browser's copy command on the focused
 * canvas: the engine's copy listener writes its clipboard format), after the export gate.
 */
function clipboard(ctx: CanvasFeatureContext, kind: 'copy' | 'cut') {
  if (!guardExport(ctx)) return
  if (kind === 'cut' && ctx.canvas.readOnly()) return
  ctx.canvas.focus({ preventScroll: true })
  const doc = ctx.canvas.container()?.ownerDocument ?? document
  doc.execCommand(kind)
}

/** What the menus' Paste says when the browser will not hand the clipboard over (W5-33). */
export const PASTE_BLOCKED_COPY =
  'Your browser did not let Lobby read the clipboard. Press Ctrl+V (⌘V on a Mac) to paste.'

/**
 * W5-33: Paste from the menus (tldraw's Edit ▸ Paste and the context menu's): the clipboard's contents,
 * read with the browser's permission, go through the board's own paste path as a paste event on the
 * canvas, at `at` (screen pixels; default the middle of the canvas), so every paste rule applies (Lobby's
 * paste handlers, the upload path for files, the engine's own clipboard, paste as notes).
 */
export async function pasteFromMenu(
  ctx: CanvasFeatureContext,
  at?: { x: number; y: number },
): Promise<boolean> {
  const { canvas } = ctx
  if (canvas.readOnly()) return false
  const nav = globalThis.navigator as Navigator | undefined
  const data = new DataTransfer()
  try {
    const items = (await nav?.clipboard?.read?.()) ?? []
    for (const item of items)
      for (const type of item.types) {
        const blob = await item.getType(type)
        if (type.startsWith('text/')) data.setData(type, await blob.text())
        else data.items.add(new File([blob], `pasted.${type.split('/')[1] ?? 'bin'}`, { type }))
      }
  } catch {
    try {
      const text = (await nav?.clipboard?.readText?.()) ?? ''
      if (text) data.setData('text/plain', text)
    } catch {
      // no permission: say how to paste instead
    }
  }
  if (!data.types.length && !data.files.length) {
    ctx.notify({
      key: 'paste-blocked',
      text: PASTE_BLOCKED_COPY,
      testId: 'paste-blocked-notice',
      timeoutMs: 6000,
    })
    return false
  }
  const root = canvas.container()
  const doc = root?.ownerDocument ?? document
  const view = canvas.viewport.screenRect()
  const point = at ?? { x: view.x + view.width / 2, y: view.y + view.height / 2 }
  canvas.focus({ preventScroll: true })
  // the engine pastes where the pointer last was, over its canvas: put the pointer there first
  const under = doc.elementFromPoint(point.x, point.y) ?? root ?? doc.body
  under.dispatchEvent(
    new PointerEvent('pointermove', {
      clientX: point.x,
      clientY: point.y,
      bubbles: true,
      pointerType: 'mouse',
    }),
  )
  const target = doc.activeElement ?? root ?? doc.body
  target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  return true
}

const selectionAtLeast = (n: number) => (ctx: CanvasFeatureContext) => selectedRoots(ctx.canvas).length >= n
const editable = (ctx: CanvasFeatureContext) => !ctx.canvas.readOnly()

export const COMMANDS: readonly CommandSpec[] = [
  {
    id: CMD.undo,
    label: 'Undo',
    enabled: (ctx) => editable(ctx) && ctx.canvas.history.canUndo(),
    run: (ctx, source) => {
      ctx.canvas.history.undo()
      refocus(ctx, source)
    },
  },
  {
    id: CMD.redo,
    label: 'Redo',
    enabled: (ctx) => editable(ctx) && ctx.canvas.history.canRedo(),
    run: (ctx, source) => {
      ctx.canvas.history.redo()
      refocus(ctx, source)
    },
  },
  {
    // A11Y2-02: Ctrl/Cmd+X on the canvas cuts. The allowlist blocks the chord (Excalidraw's own actionCut
    // keydown test, canvas/input/keymap.ts), so it is Lobby's key: the browser's cut command on the focused
    // canvas, where the engine's cut listener copies and deletes, after the export gate
    id: CMD.cut,
    label: 'Cut',
    kbd: ['mod+x'],
    enabled: (ctx) => editable(ctx) && selectionAtLeast(1)(ctx),
    run: (ctx) => clipboard(ctx, 'cut'),
  },
  {
    // editors only on this canvas: the input layer lets only editors copy (CR-3A-4 asks it to follow the
    // export policy, as the tldraw page does for viewers and commenters)
    id: CMD.copy,
    label: 'Copy',
    enabled: selectionAtLeast(1),
    run: (ctx) => clipboard(ctx, 'copy'),
  },
  {
    // W5-33: the menus' Paste (Ctrl/Cmd+V stays the browser's paste event, through the allowlist)
    id: CMD.paste,
    label: 'Paste',
    enabled: editable,
    run: (ctx) => void pasteFromMenu(ctx),
  },
  {
    id: CMD.duplicate,
    label: 'Duplicate',
    enabled: (ctx) => editable(ctx) && selectionAtLeast(1)(ctx),
    run: (ctx, source) => {
      const { canvas } = ctx
      const ids = selectedRoots(canvas).map((e) => e.id)
      if (!ids.length) return
      const map = canvas.transact('duplicate', (tx) => tx.duplicate(ids, { x: 10, y: 10 }))
      canvas.select(ids.map((id) => map.get(id)).filter((x): x is string => !!x))
      refocus(ctx, source)
    },
  },
  {
    id: CMD.delete,
    label: 'Delete',
    enabled: (ctx) => editable(ctx) && selectedRoots(ctx.canvas).some((e) => !e.locked),
    run: (ctx, source) => {
      const { canvas } = ctx
      const roots = selectedRoots(canvas).filter((e) => !e.locked)
      if (!roots.length) return
      // a frame goes with what is inside it, as the engine's own Delete does (labels go with their
      // containers in `tx.delete`)
      const all = canvas.items()
      const ids = new Set(roots.map((e) => e.id))
      for (const r of roots)
        if (r.type === 'frame')
          for (const c of itemsApi.childrenOf(r.id, all)) {
            const child = canvas.get(c)
            if (live(child) && !child.locked && !(child.type === 'text' && child.containerId)) ids.add(c)
          }
      canvas.transact('delete', (tx) => {
        for (const id of ids) tx.delete(id)
      })
      canvas.select([])
      refocus(ctx, source)
    },
  },
  {
    id: CMD.selectAll,
    label: 'Select all',
    readOnlyAllowed: true,
    run: (ctx, source) => {
      selectAll(ctx.canvas)
      refocus(ctx, source)
    },
  },
  {
    id: CMD.selectNone,
    label: 'Select none',
    readOnlyAllowed: true,
    enabled: (ctx) => ctx.canvas.selection.length > 0,
    run: (ctx, source) => {
      ctx.canvas.select([])
      refocus(ctx, source)
    },
  },
  {
    id: CMD.group,
    label: 'Group',
    enabled: (ctx) => editable(ctx) && selectionAtLeast(2)(ctx),
    run: (ctx, source) => {
      const { canvas } = ctx
      const ids = selectedRoots(canvas).map((e) => e.id)
      if (ids.length < 2) return
      canvas.transact('group', (tx) => tx.group(ids))
      canvas.select(ids)
      refocus(ctx, source)
    },
  },
  {
    id: CMD.ungroup,
    label: 'Ungroup',
    enabled: (ctx) => editable(ctx) && selectedRoots(ctx.canvas).some((e) => e.groupIds.length > 0),
    run: (ctx, source) => {
      const { canvas } = ctx
      const ids = selectedRoots(canvas).map((e) => e.id)
      canvas.transact('ungroup', (tx) => tx.ungroup(ids))
      canvas.select(ids)
      refocus(ctx, source)
    },
  },
  {
    id: CMD.toggleLock,
    label: 'Toggle locked',
    kbd: ['mod+shift+l'],
    enabled: (ctx) => editable(ctx) && selectionAtLeast(1)(ctx),
    run: (ctx, source) => {
      toggleLock(ctx)
      refocus(ctx, source)
    },
  },
  {
    id: CMD.unlockAll,
    label: 'Unlock all',
    enabled: (ctx) => editable(ctx) && hasLocked(ctx.canvas),
    run: (ctx, source) => {
      unlockAll(ctx)
      refocus(ctx, source)
    },
  },
  {
    id: CMD.bringToFront,
    label: 'Bring to front',
    kbd: ['pageup', ']'],
    enabled: (ctx) => editable(ctx) && selectionAtLeast(1)(ctx),
    run: (ctx) => reorder(ctx, 'front'),
  },
  {
    id: CMD.sendToBack,
    label: 'Send to back',
    kbd: ['pagedown', '['],
    enabled: (ctx) => editable(ctx) && selectionAtLeast(1)(ctx),
    run: (ctx) => reorder(ctx, 'back'),
  },
  {
    id: CMD.bringForward,
    label: 'Bring forward',
    kbd: ['shift+pageup', 'alt+]'],
    enabled: (ctx) => editable(ctx) && selectionAtLeast(1)(ctx),
    run: (ctx) => reorder(ctx, 'forward'),
  },
  {
    id: CMD.sendBackward,
    label: 'Send backward',
    kbd: ['shift+pagedown', 'alt+['],
    enabled: (ctx) => editable(ctx) && selectionAtLeast(1)(ctx),
    run: (ctx) => reorder(ctx, 'backward'),
  },
  ...(
    [
      [CMD.alignLeft, 'Align left', 'alt+a', 'left'],
      [CMD.alignCenterH, 'Align horizontally', 'alt+h', 'center-horizontal'],
      [CMD.alignRight, 'Align right', null, 'right'],
      [CMD.alignTop, 'Align top', 'alt+w', 'top'],
      [CMD.alignCenterV, 'Align vertically', 'alt+v', 'center-vertical'],
      [CMD.alignBottom, 'Align bottom', 'alt+s', 'bottom'],
    ] as const
  ).map(
    ([id, label, kbd, op]): CommandSpec => ({
      id,
      label,
      ...(kbd ? { kbd: [kbd] } : {}),
      enabled: (ctx) => editable(ctx) && selectionAtLeast(2)(ctx),
      run: (ctx) => align(ctx, op),
    }),
  ),
  ...(
    [
      [CMD.distributeH, 'Distribute horizontally', 'alt+shift+h', 'horizontal'],
      [CMD.distributeV, 'Distribute vertically', 'alt+shift+v', 'vertical'],
    ] as const
  ).map(
    ([id, label, kbd, op]): CommandSpec => ({
      id,
      label,
      kbd: [kbd],
      enabled: (ctx) => editable(ctx) && selectionAtLeast(3)(ctx),
      run: (ctx) => distribute(ctx, op),
    }),
  ),
  {
    id: CMD.shortcuts,
    label: 'Keyboard shortcuts',
    kbd: ['shift+?', 'mod+/', 'mod+alt+/'],
    readOnlyAllowed: true,
    run: (ctx) => {
      const s = uxState(ctx.canvas)
      s.contextMenu.set(null)
      s.mainMenuOpen.set(false)
      s.shortcutsOpen.set(true)
    },
  },
  {
    id: CMD.insertFile,
    label: 'Upload media…',
    // Ctrl/Cmd+U is the media feature's (media.insert-file, 3g: it also tells a read-only person why
    // nothing happens); this command is the toolbar's and the menus' (wave-3 integration)
    enabled: editable,
    run: (ctx) => void pickFiles(ctx),
  },
  {
    // FAC-07 (partial) / RETRO-03a: the same synced setting as the workshop popover's checkbox
    id: CMD.toggleNoteAuthors,
    label: 'Hide note authors',
    enabled: editable,
    run: (ctx) => {
      if (ctx.canvas.readOnly()) return
      const next = !readSessionSettings(ctx.canvas).hideNoteAuthors
      writeSessionSettings(ctx.canvas, { hideNoteAuthors: next })
      ctx.notify({
        key: 'board-setting',
        text: next ? BOARD_SETTING_COPY.authorsHidden : BOARD_SETTING_COPY.authorsShown,
        testId: 'board-setting-notice',
        timeoutMs: next ? 9000 : 4000,
      })
    },
  },
  {
    id: CMD.toggleSnap,
    label: 'Always snap',
    readOnlyAllowed: true,
    run: (ctx) => ctx.canvas.settings.set({ snap: !ctx.canvas.settings.get().snap }),
  },
  {
    id: CMD.toggleGrid,
    label: 'Show grid',
    readOnlyAllowed: true,
    run: (ctx) => ctx.canvas.settings.set({ grid: !ctx.canvas.settings.get().grid }),
  },
]

/** Runs a command by id as a menu or a button would (its `enabled` and read-only rules applied). */
export function runCommand(ctx: CanvasFeatureContext, id: string, source: CommandSource): boolean {
  const cmd = ctx.registries.commands.get(id) ?? COMMANDS.find((c) => c.id === id)
  if (!cmd) return false
  if (ctx.canvas.readOnly() && !cmd.readOnlyAllowed) return false
  if (cmd.enabled && !cmd.enabled(ctx)) return false
  void cmd.run(ctx, source)
  return true
}
