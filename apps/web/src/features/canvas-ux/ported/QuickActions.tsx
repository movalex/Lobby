// tldraw's quick actions and actions menu on the Excalidraw canvas (tldraw 5.4.2 DefaultQuickActions and
// DefaultActionsMenu, the tldraw page's phone toolbar and top-left menu zone): Undo, Redo, Delete,
// Duplicate, Comment (when the comments feature registers its tool) and "⋮", a grid of align, distribute,
// reorder, zoom to 100% (on a phone-width canvas) and group / ungroup. Every button runs the same command
// as the menus and keys (./commands.ts, navigation's zoom), so undo and redo go through the canvas history
// API; a button is disabled when its command cannot run. Editors only (tldraw shows none of it to
// read-only roles). Test ids are tldraw's (`quick-actions.*`, `actions-menu.*`).
//
// Placement (./toolbar-layout.ts): a strip on top of the toolbar on a canvas of 840 px or less, as on the
// tldraw page's phone and tablet toolbar. On a wider canvas tldraw put the same buttons in its top-left menu
// zone; this canvas has only Undo and Redo there, left of the tools (W5-33: ./HistoryBar below; the other
// owners' ported specs click the board's top-left, where a strip would sit; the board menu's Edit ▸ and the
// keys have every action). Each bar is one Tab stop (W5-42). A click never takes
// the keyboard from the board; arrow keys, Home and End move along the strip (ARIA toolbar); the actions
// menu closes on Escape, a pick or a press elsewhere.
import { type ComponentType, type ReactNode, useEffect, useLayoutEffect, useRef } from 'react'
import type { CanvasFeatureContext } from '../../../canvas/api/index.ts'
import { currentPlatform, formatChord } from '../../../canvas/api/index.ts'
import { useValue } from '../../../lib/signals.ts'
import { AlignIcons } from '../icons.tsx'
import { CMD, runCommand } from './commands.ts'
import { uxState } from './state.ts'
import { moveInToolbar, rove } from './toolbar-keys.ts'
import { QUICK_MARGIN_PX } from './toolbar-layout.ts'

function Svg({ children }: { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={16}
      height={16}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

export const UndoIcon = () => (
  <Svg>
    <path d="M9 14L4 9l5-5" />
    <path d="M4 9h10a6 6 0 0 1 0 12h-3" />
  </Svg>
)
export const RedoIcon = () => (
  <Svg>
    <path d="M15 14l5-5-5-5" />
    <path d="M20 9H10a6 6 0 0 0 0 12h3" />
  </Svg>
)
export const TrashIcon = () => (
  <Svg>
    <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
  </Svg>
)
export const DuplicateIcon = () => (
  <Svg>
    <rect x="8" y="8" width="12" height="12" rx="2" />
    <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
  </Svg>
)
export const DotsIcon = () => (
  <Svg>
    <circle cx="12" cy="5.5" r="1.1" fill="currentColor" />
    <circle cx="12" cy="12" r="1.1" fill="currentColor" />
    <circle cx="12" cy="18.5" r="1.1" fill="currentColor" />
  </Svg>
)
const ToBackIcon = () => (
  <Svg>
    <path d="M12 4v12M7 11l5 5 5-5M5 20h14" />
  </Svg>
)
const BackwardIcon = () => (
  <Svg>
    <path d="M12 5v14M7 14l5 5 5-5" />
  </Svg>
)
const ForwardIcon = () => (
  <Svg>
    <path d="M12 19V5M7 10l5-5 5 5" />
  </Svg>
)
const ToFrontIcon = () => (
  <Svg>
    <path d="M12 20V8M7 13l5-5 5 5M5 4h14" />
  </Svg>
)
const Zoom100Icon = () => (
  <Svg>
    <circle cx="10.5" cy="10.5" r="6.5" />
    <path d="M20 20l-4.8-4.8M10.5 8v5" />
  </Svg>
)
const GroupIcon = () => (
  <Svg>
    <rect x="3.5" y="3.5" width="17" height="17" rx="2" strokeDasharray="3 2.5" />
    <rect x="7" y="7" width="5" height="5" rx="1" />
    <rect x="12" y="12" width="5" height="5" rx="1" />
  </Svg>
)
const UngroupIcon = () => (
  <Svg>
    <rect x="3.5" y="3.5" width="9" height="9" rx="1.5" strokeDasharray="3 2.5" />
    <rect x="11.5" y="11.5" width="9" height="9" rx="1.5" strokeDasharray="3 2.5" />
  </Svg>
)

/** Whether a command (any feature's) may run now: it exists, the role may run it, and it is enabled. */
export function commandReady(ctx: CanvasFeatureContext, id: string): boolean {
  const cmd = ctx.registries.commands.get(id)
  if (!cmd) return false
  if (ctx.canvas.readOnly() && !cmd.readOnlyAllowed) return false
  return cmd.enabled ? cmd.enabled(ctx) : true
}

interface Action {
  readonly id: string
  readonly command: string
  readonly label: string
  readonly icon: ComponentType
  readonly kbd?: string
}

const QUICK: readonly Action[] = [
  { id: 'undo', command: CMD.undo, label: 'Undo', icon: UndoIcon, kbd: 'mod+z' },
  { id: 'redo', command: CMD.redo, label: 'Redo', icon: RedoIcon, kbd: 'mod+shift+z' },
  { id: 'delete', command: CMD.delete, label: 'Delete', icon: TrashIcon, kbd: 'delete' },
  { id: 'duplicate', command: CMD.duplicate, label: 'Duplicate', icon: DuplicateIcon, kbd: 'mod+d' },
]

/** The actions menu's rows (tldraw's DefaultActionsMenuContent, the actions Lobby has on this canvas). */
export function actionsMenuItems(opts: { phone: boolean; ungroup: boolean }): readonly Action[] {
  return [
    { id: 'align-left', command: CMD.alignLeft, label: 'Align left', icon: AlignIcons.left, kbd: 'alt+a' },
    {
      id: 'align-center-horizontal',
      command: CMD.alignCenterH,
      label: 'Align horizontally',
      icon: AlignIcons.centerH,
      kbd: 'alt+h',
    },
    { id: 'align-right', command: CMD.alignRight, label: 'Align right', icon: AlignIcons.right },
    { id: 'align-top', command: CMD.alignTop, label: 'Align top', icon: AlignIcons.top, kbd: 'alt+w' },
    {
      id: 'align-center-vertical',
      command: CMD.alignCenterV,
      label: 'Align vertically',
      icon: AlignIcons.centerV,
      kbd: 'alt+v',
    },
    {
      id: 'align-bottom',
      command: CMD.alignBottom,
      label: 'Align bottom',
      icon: AlignIcons.bottom,
      kbd: 'alt+s',
    },
    {
      id: 'distribute-horizontal',
      command: CMD.distributeH,
      label: 'Distribute horizontally',
      icon: AlignIcons.distH,
      kbd: 'alt+shift+h',
    },
    {
      id: 'distribute-vertical',
      command: CMD.distributeV,
      label: 'Distribute vertically',
      icon: AlignIcons.distV,
      kbd: 'alt+shift+v',
    },
    { id: 'send-to-back', command: CMD.sendToBack, label: 'Send to back', icon: ToBackIcon, kbd: 'pagedown' },
    {
      id: 'send-backward',
      command: CMD.sendBackward,
      label: 'Send backward',
      icon: BackwardIcon,
      kbd: 'shift+pagedown',
    },
    {
      id: 'bring-forward',
      command: CMD.bringForward,
      label: 'Bring forward',
      icon: ForwardIcon,
      kbd: 'shift+pageup',
    },
    {
      id: 'bring-to-front',
      command: CMD.bringToFront,
      label: 'Bring to front',
      icon: ToFrontIcon,
      kbd: 'pageup',
    },
    ...(opts.phone
      ? [
          {
            id: 'zoom-to-100',
            command: 'navigation.zoom-to-100',
            label: 'Zoom to 100%',
            icon: Zoom100Icon,
          },
        ]
      : []),
    opts.ungroup
      ? { id: 'ungroup', command: CMD.ungroup, label: 'Ungroup', icon: UngroupIcon, kbd: 'mod+shift+g' }
      : { id: 'group', command: CMD.group, label: 'Group', icon: GroupIcon, kbd: 'mod+g' },
  ]
}

const titleOf = (label: string, kbd?: string) =>
  kbd ? `${label} — ${formatChord(kbd, currentPlatform())}` : label

function ActionButton(props: {
  testId: string
  label: string
  kbd?: string
  disabled?: boolean
  pressed?: boolean
  expanded?: boolean
  onClick(): void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      className="cux-quick__btn"
      data-testid={props.testId}
      aria-label={titleOf(props.label, props.kbd)}
      title={titleOf(props.label, props.kbd)}
      disabled={props.disabled}
      aria-pressed={props.pressed}
      aria-expanded={props.expanded}
      aria-haspopup={props.expanded === undefined ? undefined : 'true'}
      // the board keeps the keyboard: a click is not a move of the focus
      onMouseDown={(e) => e.preventDefault()}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  )
}

export function QuickActions({
  ctx,
  phone = false,
  indent = 0,
}: {
  ctx: CanvasFeatureContext
  /** a phone-width canvas (the actions menu adds zoom to 100%) */
  phone?: boolean
  /** px the strip moves right of its place to clear the navigation slot (toolbar-layout.ts quickIndent) */
  indent?: number
}) {
  const { canvas } = ctx
  const state = uxState(canvas)
  const open = useValue(state.actionsMenuOpen)
  const readOnly = useValue('cux-quick-readonly', () => canvas.readOnly(), [canvas])
  const ready = useValue('cux-quick-ready', () => {
    const out: Record<string, boolean> = {}
    for (const a of QUICK) out[a.id] = commandReady(ctx, a.command)
    out.ungroupable = commandReady(ctx, CMD.ungroup) && !commandReady(ctx, CMD.group)
    for (const a of actionsMenuItems({ phone, ungroup: out.ungroupable === true }))
      out[`menu:${a.id}`] = commandReady(ctx, a.command)
    return JSON.stringify(out)
  }, [ctx, phone])
  const enabled = JSON.parse(ready) as Record<string, boolean>
  const comment = ctx.registries.tools.get('comment')
  const tool = useValue('cux-quick-tool', () => canvas.tool(), [canvas])
  const barRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  // W5-42: one Tab stop for the strip, one for the actions menu
  useLayoutEffect(() => {
    rove(barRef.current)
    rove(menuRef.current)
  })

  useEffect(() => {
    if (!open) return
    const doc = barRef.current?.ownerDocument ?? document
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null
      if (t && (menuRef.current?.contains(t) || barRef.current?.contains(t))) return
      state.actionsMenuOpen.set(false)
    }
    doc.addEventListener('pointerdown', onDown, true)
    return () => doc.removeEventListener('pointerdown', onDown, true)
  }, [open, state])

  if (readOnly) return null
  const run = (command: string) => {
    runCommand(ctx, command, 'toolbar')
    canvas.focus({ preventScroll: true })
  }
  const Comment = comment?.toolbar?.icon
  const items = actionsMenuItems({ phone, ungroup: enabled.ungroupable === true })
  return (
    <div
      className="cux-quick cux-quick--toolbar"
      style={indent > 0 ? { marginLeft: QUICK_MARGIN_PX + Math.round(indent) } : undefined}
    >
      <div
        ref={barRef}
        className="cux-quick__bar"
        role="toolbar"
        aria-label="Actions"
        data-testid="quick-actions"
        onKeyDown={(e) => moveInToolbar(e.nativeEvent, barRef.current)}
        onFocus={(e) => rove(barRef.current, e.target)}
      >
        {QUICK.map((a) => (
          <ActionButton
            key={a.id}
            testId={`quick-actions.${a.id}`}
            label={a.label}
            kbd={a.kbd}
            disabled={!enabled[a.id]}
            onClick={() => run(a.command)}
          >
            <a.icon />
          </ActionButton>
        ))}
        {comment && Comment && (
          <ActionButton
            testId="quick-actions.comment"
            label={comment.label}
            kbd={comment.kbd?.[0]}
            pressed={tool === comment.id}
            onClick={() => {
              canvas.setTool(tool === comment.id ? 'select' : comment.id)
              canvas.focus({ preventScroll: true })
            }}
          >
            <Comment />
          </ActionButton>
        )}
        <ActionButton
          testId="actions-menu.button"
          label="Actions"
          expanded={open}
          onClick={() => state.actionsMenuOpen.set(!open)}
        >
          <DotsIcon />
        </ActionButton>
      </div>
      {open && (
        <div
          ref={menuRef}
          className="cux-quick__menu"
          role="toolbar"
          aria-label="Actions"
          data-testid="actions-menu.content"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              e.stopPropagation()
              state.actionsMenuOpen.set(false)
              barRef.current?.querySelector<HTMLButtonElement>('[data-testid="actions-menu.button"]')?.focus()
              return
            }
            moveInToolbar(e.nativeEvent, menuRef.current)
          }}
        >
          {items.map((a) => (
            <ActionButton
              key={a.id}
              testId={`actions-menu.${a.id}`}
              label={a.label}
              kbd={a.kbd}
              disabled={!enabled[`menu:${a.id}`]}
              onClick={() => {
                state.actionsMenuOpen.set(false)
                run(a.command)
              }}
            >
              <a.icon />
            </ActionButton>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * W5-33 (the wave-5 review): Undo and Redo on a wider canvas (where the quick actions are not on the
 * toolbar), in a small bar left of the tools: the Lobby tour tells people to press Ctrl+Z, and tldraw's
 * wider canvas had both buttons in its top-left menu zone. Editors only; the same commands as the keys.
 */
export function HistoryBar({ ctx }: { ctx: CanvasFeatureContext }) {
  const { canvas } = ctx
  const readOnly = useValue('cux-history-readonly', () => canvas.readOnly(), [canvas])
  const ready = useValue(
    'cux-history-ready',
    () => `${commandReady(ctx, CMD.undo)}|${commandReady(ctx, CMD.redo)}`,
    [ctx],
  )
  const barRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => rove(barRef.current))
  if (readOnly) return null
  const [undo, redo] = ready.split('|').map((v) => v === 'true')
  const run = (command: string) => {
    runCommand(ctx, command, 'toolbar')
    canvas.focus({ preventScroll: true })
  }
  return (
    <div
      ref={barRef}
      className="cux-quick__bar cux-history"
      role="toolbar"
      aria-label="History"
      data-testid="history-bar"
      onKeyDown={(e) => moveInToolbar(e.nativeEvent, barRef.current)}
      onFocus={(e) => rove(barRef.current, e.target)}
    >
      <ActionButton
        testId="history-bar.undo"
        label="Undo"
        kbd="mod+z"
        disabled={!undo}
        onClick={() => run(CMD.undo)}
      >
        <UndoIcon />
      </ActionButton>
      <ActionButton
        testId="history-bar.redo"
        label="Redo"
        kbd="mod+shift+z"
        disabled={!redo}
        onClick={() => run(CMD.redo)}
      >
        <RedoIcon />
      </ActionButton>
    </div>
  )
}
