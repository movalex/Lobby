// The canvas context menu on the Excalidraw canvas (host slot `contextMenu`; the tldraw page's
// ../ContextMenu.tsx over tldraw's DefaultContextMenu): Lobby's own menu, from every feature's
// `contextMenu` entries (./Menu.tsx), opened by a right-click (the engine's own menu never opens) or by
// Shift+F10 / the menu key for the selection (A11Y-04). canvas-ux's own entries, in tldraw's words:
// Cut / Copy / Paste (W5-33) / Duplicate, Group / Ungroup / Toggle locked / Delete, Arrange (align, distribute) and
// Reorder, Select all, and MAK-05 "Unlock all" while the board has locked elements (a locked element
// cannot be selected by a click, so this is where people look). Other features add theirs (Comment, AI,
// mind map, tags, arrange as grid, select by type, the start view, the exports). While exporting is off
// for this person, copy and the export entries give way to one line saying so (export control).
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CanvasFeatureContext, MenuEntrySpec, MenuTarget } from '../../../canvas/api/index.ts'
import { useValue } from '../../../lib/signals.ts'
import { CMD, hasLocked, pasteFromMenu, selectedRoots } from './commands.ts'
import { EXPORT_OFF_MENU_LABEL, exportAllowed, notifyExportOff } from './export-gate.ts'
import { EXPORTING_ENTRIES, groupRows, MenuList } from './Menu.tsx'
import { uxState } from './state.ts'

const selected = (ctx: CanvasFeatureContext) => selectedRoots(ctx.canvas)
const editable = (ctx: CanvasFeatureContext) => !ctx.canvas.readOnly()
const atLeast = (n: number) => (ctx: CanvasFeatureContext) => selected(ctx).length >= n

/** The one line where copying and exporting would be, while exporting is off for this person. */
export const EXPORT_OFF_ENTRY: MenuEntrySpec = {
  id: 'dr-export-off',
  group: 'export',
  order: -1000,
  label: EXPORT_OFF_MENU_LABEL,
  visible: (ctx) => !exportAllowed(ctx) && ctx.canvas.items().length > 0,
  run: (ctx) => notifyExportOff(ctx),
}

/** canvas-ux's own context-menu entries (tldraw's ids, so the test ids stay the tldraw page's). */
export const CONTEXT_MENU_ENTRIES: readonly MenuEntrySpec[] = [
  {
    id: 'cut',
    group: 'clipboard',
    order: 10,
    label: '',
    command: CMD.cut,
    visible: (c) => editable(c) && atLeast(1)(c),
  },
  // read-only roles cannot copy on this canvas yet (the input layer's copy rule is editors only: CR-3A-4)
  {
    id: 'copy',
    group: 'clipboard',
    order: 20,
    label: '',
    command: CMD.copy,
    visible: (c) => editable(c) && atLeast(1)(c),
  },
  {
    // W5-33: Paste where the menu opened (tldraw's context menu has it)
    id: 'paste',
    group: 'clipboard',
    order: 25,
    label: '',
    command: CMD.paste,
    visible: editable,
    run: (ctx, target) =>
      void pasteFromMenu(ctx, target.point ? ctx.canvas.sceneToScreen(target.point) : undefined),
  },
  {
    id: 'duplicate',
    group: 'clipboard',
    order: 30,
    label: '',
    command: CMD.duplicate,
    visible: (c) => editable(c) && atLeast(1)(c),
  },
  {
    id: 'group',
    group: 'edit',
    order: 10,
    label: '',
    command: CMD.group,
    visible: (c) => editable(c) && atLeast(2)(c),
  },
  {
    id: 'ungroup',
    group: 'edit',
    order: 20,
    label: '',
    command: CMD.ungroup,
    visible: (c) => editable(c) && selected(c).some((e) => e.groupIds.length > 0),
  },
  {
    id: 'toggle-lock',
    group: 'edit',
    order: 30,
    label: '',
    command: CMD.toggleLock,
    visible: (c) => editable(c) && atLeast(1)(c),
  },
  {
    id: 'delete',
    group: 'edit',
    order: 90,
    label: '',
    command: CMD.delete,
    visible: (c) => editable(c) && atLeast(1)(c),
  },
  {
    id: 'arrange',
    group: 'arrange',
    order: 10,
    label: 'Arrange',
    visible: (c) => editable(c) && atLeast(2)(c),
    submenu: [
      { id: 'align-left', group: 'arrange', order: 10, label: '', command: CMD.alignLeft },
      { id: 'align-center-horizontal', group: 'arrange', order: 20, label: '', command: CMD.alignCenterH },
      { id: 'align-right', group: 'arrange', order: 30, label: '', command: CMD.alignRight },
      { id: 'align-top', group: 'arrange', order: 40, label: '', command: CMD.alignTop },
      { id: 'align-center-vertical', group: 'arrange', order: 50, label: '', command: CMD.alignCenterV },
      { id: 'align-bottom', group: 'arrange', order: 60, label: '', command: CMD.alignBottom },
      {
        id: 'distribute-horizontal',
        group: 'select',
        order: 10,
        label: '',
        command: CMD.distributeH,
        visible: atLeast(3),
      },
      {
        id: 'distribute-vertical',
        group: 'select',
        order: 20,
        label: '',
        command: CMD.distributeV,
        visible: atLeast(3),
      },
    ],
  },
  {
    id: 'reorder',
    group: 'arrange',
    order: 20,
    label: 'Reorder',
    visible: (c) => editable(c) && atLeast(1)(c),
    submenu: [
      { id: 'bring-to-front', group: 'arrange', order: 10, label: '', command: CMD.bringToFront },
      { id: 'bring-forward', group: 'arrange', order: 20, label: '', command: CMD.bringForward },
      { id: 'send-backward', group: 'arrange', order: 30, label: '', command: CMD.sendBackward },
      { id: 'send-to-back', group: 'arrange', order: 40, label: '', command: CMD.sendToBack },
    ],
  },
  { id: 'select-all', group: 'select', order: 10, label: '', command: CMD.selectAll },
  {
    id: 'unlock-all',
    group: 'danger',
    order: 10,
    label: '',
    command: CMD.unlockAll,
    visible: (c) => editable(c) && hasLocked(c.canvas),
  },
  EXPORT_OFF_ENTRY,
]

/** The entries a menu shows now: while exporting is off, the export group and copy give way. */
export function gatedEntries(ctx: CanvasFeatureContext, entries: readonly MenuEntrySpec[]): MenuEntrySpec[] {
  if (exportAllowed(ctx)) return entries.filter((e) => e.id !== EXPORT_OFF_ENTRY.id)
  return entries.filter(
    (e) => (e.group !== 'export' || e.id === EXPORT_OFF_ENTRY.id) && !EXPORTING_ENTRIES.has(e.id),
  )
}

const MARGIN = 8

export function ContextMenu({ ctx }: { ctx: CanvasFeatureContext }) {
  const { canvas } = ctx
  const state = uxState(canvas)
  const open = useValue(state.contextMenu)
  // re-read the entries when the board or the policy changes while it is open
  useValue(
    'cux-context-deps',
    () => (open ? [canvas.items().length, canvas.selection.join(), exportAllowed(ctx)].join('|') : ''),
    [canvas, open, ctx],
  )
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)

  useLayoutEffect(() => {
    if (!open) return setPos(null)
    const el = ref.current
    const host = el?.offsetParent as HTMLElement | null
    const w = el?.offsetWidth ?? 0
    const h = el?.offsetHeight ?? 0
    const W = host?.clientWidth ?? Number.POSITIVE_INFINITY
    const H = host?.clientHeight ?? Number.POSITIVE_INFINITY
    setPos({
      x: Math.max(MARGIN, Math.min(open.at.x, W - w - MARGIN)),
      y: Math.max(MARGIN, Math.min(open.at.y, H - h - MARGIN)),
    })
  }, [open])

  useEffect(() => {
    if (!open) return
    const doc = ref.current?.ownerDocument ?? document
    const onDown = (e: PointerEvent) => {
      if (ref.current?.contains(e.target as Node)) return
      state.contextMenu.set(null)
    }
    const onBlur = () => state.contextMenu.set(null)
    // while it is open the menu has the keys, even when the board kept the keyboard (a right-click leaves
    // the focus on the canvas): Escape closes it, the arrows walk it instead of moving the selection
    const onKey = (e: KeyboardEvent) => {
      const el = ref.current
      if (!el || el.contains(doc.activeElement)) return
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        state.contextMenu.set(null)
        canvas.focus({ preventScroll: true })
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
        e.preventDefault()
        e.stopPropagation()
        const all = [
          ...el.querySelectorAll<HTMLElement>(
            '[role="menu"] > [role^="menuitem"], [role="menu"] > .cux-menu__subwrap > [role^="menuitem"]',
          ),
        ].filter((b) => b.getAttribute('aria-disabled') !== 'true')
        ;(e.key === 'ArrowUp' || e.key === 'End' ? all[all.length - 1] : all[0])?.focus()
      }
    }
    // a press anywhere else closes it (a right-click elsewhere opens the next one)
    doc.addEventListener('pointerdown', onDown, true)
    doc.addEventListener('keydown', onKey, true)
    doc.defaultView?.addEventListener('blur', onBlur)
    return () => {
      doc.removeEventListener('pointerdown', onDown, true)
      doc.removeEventListener('keydown', onKey, true)
      doc.defaultView?.removeEventListener('blur', onBlur)
    }
  }, [open, state, canvas])

  if (!open) return null
  const target: MenuTarget = open.target
  const rows = groupRows(gatedEntries(ctx, ctx.registries.contextMenu.list()), ctx, target, 'context-menu')
  const close = () => {
    state.contextMenu.set(null)
    canvas.focus({ preventScroll: true })
  }
  if (!rows.length) return null
  return (
    <div
      ref={ref}
      className="cux-menu cux-menu--context"
      // clamped inside the canvas before the first paint (useLayoutEffect); never hidden, so the first
      // entry can take the keyboard at once
      style={{ left: pos?.x ?? open.at.x, top: pos?.y ?? open.at.y }}
      data-testid="context-menu-root"
    >
      <MenuList
        rows={rows}
        prefix="context-menu"
        label="Context menu"
        testId="context-menu"
        autoFocus={open.fromKeyboard ? 'first' : 'list'}
        onDone={() => state.contextMenu.set(null)}
        onEscape={close}
      />
    </div>
  )
}
