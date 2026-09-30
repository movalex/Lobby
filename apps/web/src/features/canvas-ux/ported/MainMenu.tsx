// The board menu on the Excalidraw canvas (host slot `mainMenu`, top left; the tldraw page's ../MainMenu.tsx
// over tldraw's DefaultMainMenu). Lobby's own menu from every feature's `mainMenu` entries (./Menu.tsx),
// laid out as tldraw's was:
//   Board ▸   the `board` entries, then the `ai` ones (the start view, "Hide note authors", AI on this board)
//   Edit ▸    the `clipboard`, `edit`, `arrange` and `select` entries (undo, redo, cut, copy, duplicate,
//             delete, group, lock, select all…)
//   View ▸    the `view` entries (zoom, minimap…)
//   Export ▸  the `export` entries (or, while exporting is off for this person, the line saying so)
//   the other groups' entries, then Preferences ▸ (Always snap, Show grid) and Keyboard shortcuts.
// tldraw's Language submenu stays out (DANA-13), and so does its debug mode. "Hide note authors" (FAC-07
// partial / RETRO-03a) is the same synced setting as the workshop popover's checkbox; read-only people see
// its state, disabled.
import { useEffect, useRef } from 'react'
import type { CanvasFeatureContext, MenuEntrySpec, MenuGroup, MenuTarget } from '../../../canvas/api/index.ts'
import { useValue } from '../../../lib/signals.ts'
import { EXPORT_OFF_ENTRY, gatedEntries } from './ContextMenu.tsx'
import { CMD } from './commands.ts'
import { MenuIcon } from './icons.tsx'
import { groupRows, MenuList, type MenuRow } from './Menu.tsx'
import { readSessionSettings } from './session-settings.ts'
import { uxState } from './state.ts'

/** canvas-ux's own board-menu entries. */
export const MAIN_MENU_ENTRIES: readonly MenuEntrySpec[] = [
  {
    id: 'dr-toggle-note-authors',
    group: 'board',
    order: 200,
    label: 'Hide note authors',
    checked: (ctx) => readSessionSettings(ctx.canvas).hideNoteAuthors,
    disabled: (ctx) => ctx.canvas.readOnly(),
    run: (ctx) => {
      ctx.registries.commands.get(CMD.toggleNoteAuthors)?.run(ctx, 'menu')
    },
  },
  { id: 'undo', group: 'edit', order: 10, label: '', command: CMD.undo, kbdHint: 'mod+z' },
  { id: 'redo', group: 'edit', order: 20, label: '', command: CMD.redo, kbdHint: 'mod+shift+z' },
  { id: 'cut', group: 'clipboard', order: 10, label: '', command: CMD.cut, kbdHint: 'mod+x' },
  { id: 'copy', group: 'clipboard', order: 20, label: '', command: CMD.copy, kbdHint: 'mod+c' },
  { id: 'duplicate', group: 'clipboard', order: 30, label: '', command: CMD.duplicate, kbdHint: 'mod+d' },
  { id: 'delete', group: 'clipboard', order: 40, label: '', command: CMD.delete, kbdHint: 'delete' },
  { id: 'group', group: 'arrange', order: 10, label: '', command: CMD.group, kbdHint: 'mod+g' },
  { id: 'ungroup', group: 'arrange', order: 20, label: '', command: CMD.ungroup, kbdHint: 'mod+shift+g' },
  { id: 'toggle-lock', group: 'arrange', order: 30, label: '', command: CMD.toggleLock },
  { id: 'unlock-all', group: 'arrange', order: 40, label: '', command: CMD.unlockAll },
  { id: 'select-all', group: 'select', order: 10, label: '', command: CMD.selectAll, kbdHint: 'mod+a' },
  { id: 'select-none', group: 'select', order: 20, label: '', command: CMD.selectNone },
  EXPORT_OFF_ENTRY,
]

const EDIT_GROUPS: readonly MenuGroup[] = ['clipboard', 'edit', 'arrange', 'select']
const TOP_GROUPS: readonly MenuGroup[] = ['frame', 'collaborate', 'workshop', 'organize', 'danger']

function sub(id: string, label: string, rows: MenuRow[][]): MenuRow | null {
  return rows.length ? { id, label, disabled: false, submenu: rows } : null
}

export function mainMenuRows(ctx: CanvasFeatureContext): MenuRow[][] {
  const entries = gatedEntries(ctx, ctx.registries.mainMenu.list())
  const target: MenuTarget = { ids: ctx.canvas.selection, point: null, hit: null }
  const rows = (groups: readonly MenuGroup[]) => groupRows(entries, ctx, target, 'menu', groups)
  const settings = ctx.canvas.settings.get()
  const top: MenuRow[] = [
    sub('dr-board', 'Board', rows(['board', 'ai'])),
    sub('edit', 'Edit', rows(EDIT_GROUPS)),
    sub('view', 'View', rows(['view'])),
    sub('export', 'Export', rows(['export'])),
  ].filter((r): r is MenuRow => r !== null)
  const middle = rows(TOP_GROUPS)
  const prefs: MenuRow = {
    id: 'preferences',
    label: 'Preferences',
    disabled: false,
    submenu: [
      [
        {
          id: 'toggle-snap-mode',
          label: 'Always snap',
          disabled: false,
          checked: settings.snap,
          run: () => ctx.canvas.settings.set({ snap: !ctx.canvas.settings.get().snap }),
        },
        {
          id: 'toggle-grid',
          label: 'Show grid',
          disabled: false,
          checked: settings.grid,
          run: () => ctx.canvas.settings.set({ grid: !ctx.canvas.settings.get().grid }),
        },
      ],
    ],
  }
  const help: MenuRow = {
    id: 'keyboard-shortcuts',
    label: 'Keyboard shortcuts',
    kbd: 'shift+?',
    disabled: false,
    run: () => {
      uxState(ctx.canvas).shortcutsOpen.set(true)
    },
  }
  return [top, ...middle, [prefs, help]]
}

export function MainMenu({ ctx }: { ctx: CanvasFeatureContext }) {
  const { canvas } = ctx
  const state = uxState(canvas)
  const open = useValue(state.mainMenuOpen)
  // what the entries read (the selection, the document, the settings) while it is open
  useValue(
    'cux-main-menu-deps',
    () =>
      open
        ? [
            canvas.selection.join(),
            canvas.items().length,
            JSON.stringify(canvas.settings.get()),
            JSON.stringify(canvas.doc.get('workshop') ?? null),
            canvas.readOnly(),
          ].join('|')
        : '',
    [canvas, open],
  )
  const wrap = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const byKeyboard = useRef(false)
  useEffect(() => {
    if (!open) return
    const doc = wrap.current?.ownerDocument ?? document
    const onDown = (e: PointerEvent) => {
      if (wrap.current?.contains(e.target as Node)) return
      state.mainMenuOpen.set(false)
    }
    doc.addEventListener('pointerdown', onDown, true)
    return () => doc.removeEventListener('pointerdown', onDown, true)
  }, [open, state])
  return (
    <div ref={wrap} className="cux-mainmenu">
      <button
        ref={button}
        type="button"
        className="cux-mainmenu__button"
        data-testid="main-menu.button"
        aria-label="Board menu"
        title="Board menu"
        aria-haspopup="menu"
        aria-expanded={open}
        onPointerDown={() => {
          byKeyboard.current = false
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
            byKeyboard.current = true
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              state.mainMenuOpen.set(true)
            }
          }
        }}
        onClick={() => {
          state.contextMenu.set(null)
          state.mainMenuOpen.set(!open)
        }}
      >
        <MenuIcon />
      </button>
      {open && (
        <div className="cux-menu cux-menu--main" data-testid="main-menu-root">
          <MenuList
            rows={mainMenuRows(ctx)}
            prefix="main-menu"
            label="Board menu"
            testId="main-menu"
            autoFocus={byKeyboard.current ? 'first' : 'list'}
            onDone={() => state.mainMenuOpen.set(false)}
            onEscape={() => {
              state.mainMenuOpen.set(false)
              button.current?.focus()
            }}
          />
        </div>
      )}
    </div>
  )
}
