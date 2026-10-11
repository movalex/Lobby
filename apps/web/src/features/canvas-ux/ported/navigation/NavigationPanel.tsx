// MAK-10/11 the navigation host slot on the new canvas (tldraw's NavigationPanel, the same structure and
// test ids): the zoom menu (the zoom as a percentage; zoom in, zoom out, 100%, fit, selection), zoom out /
// in beside it and the minimap toggle, and the minimap itself (./Minimap.tsx). The minimap starts closed
// (PERF-03, ./state.ts) and is not mounted while closed. Below tldraw's tablet width only the zoom menu
// stays; at phone width, a single Zoom to fit button (PRI-13: a reviewer on a phone can always get the
// whole board back). A mouse click on a button gives the keyboard back to the board (F3).
//
// Wave N (WS7, N7-5): "Linked from": when boards this person can open link to this one (the api answers them,
// permission-filtered: features/board-links/backlinks.ts), the bar gets a "Linked from" button with their count; it
// opens the list, each board with "Go to the link" (its linking element, `/b/<from>?el=<id>`; a plain click in this
// tab, Ctrl/Cmd or a middle click in a new tab). Nothing shows while the list is unknown, empty, or the api cannot
// answer (an older api's 404, a guest's refusal).
import type { Backlink } from '@draftroom/contracts'
import { type MouseEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react'
import {
  type CanvasFeatureContext,
  currentPlatform,
  formatChord,
  type LobbyCanvas,
} from '../../../../canvas/api/index.ts'
import { backlinkPath, useBacklinks } from '../../../board-links/backlinks.ts'
import '../../../board-links/board-links.css'
import { knownUserKind } from '../../../../invite/guest.tsx'
import { useValue } from '../../../../lib/signals.ts'
import { countUsage } from '../../../../lib/usage.ts'
import { boardLinkHandlers } from '../../../board-links/open.ts'
import { Minimap } from './Minimap.tsx'
import { minimapOpen, setMinimapOpen } from './state.ts'
import { zoomIn, zoomOut, zoomTo100, zoomToFit, zoomToSelection } from './zoom.ts'

/** tldraw's portrait breakpoints (PORTRAIT_BREAKPOINTS): MOBILE from 580 px, TABLET from 840 px. */
export const MOBILE_MIN_W = 580
export const TABLET_MIN_W = 840

const PLATFORM = currentPlatform()
const title = (label: string, chord?: string) =>
  chord ? `${label} (${formatChord(chord, PLATFORM)})` : label

/** The canvas's width on screen, updated on resize. */
function useCanvasWidth(canvas: LobbyCanvas): number {
  const read = () => {
    const v = canvas.viewport.get()
    return v.width * v.zoom
  }
  const [w, setW] = useState(read)
  useEffect(() => canvas.on('resize', (r) => setW(r.width)), [canvas])
  return w
}

function NavButton(props: {
  canvas: LobbyCanvas
  testId: string
  label: string
  onClick(): void
  pressed?: boolean
  children: ReactNode
}) {
  return (
    <button
      type="button"
      className="dr-cnav__btn"
      data-testid={props.testId}
      title={props.label}
      aria-label={props.label}
      aria-pressed={props.pressed}
      onClick={(e: MouseEvent) => {
        props.onClick()
        // F3: a clicked button must not keep the keyboard (Space would press it instead of panning)
        if (e.detail > 0) props.canvas.focus({ preventScroll: true })
      }}
    >
      {props.children}
    </button>
  )
}

const Icon = {
  minus: <path d="M5 12h14" />,
  plus: <path d="M12 5v14M5 12h14" />,
  fit: <path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" />,
  left: <path d="M15 5l-7 7 7 7" />,
  right: <path d="M9 5l7 7-7 7" />,
  linked: (
    <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
  ),
}
const Svg = ({ children }: { children: ReactNode }) => (
  <svg
    viewBox="0 0 24 24"
    width="16"
    height="16"
    aria-hidden="true"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {children}
  </svg>
)

/** The zoom menu: its button shows the zoom; double-click resets to 100% (tldraw's ZoomTriggerButton). */
function ZoomMenu({ canvas, showValue }: { canvas: LobbyCanvas; showValue: boolean }) {
  const zoom = useValue('nav-zoom', () => canvas.viewport.get().zoom, [canvas])
  const hasSelection = useValue('nav-has-selection', () => canvas.selection.length > 0, [canvas])
  const [open, setOpen] = useState(false)
  const menuId = useId()
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  // an animated move can end a hair below its step (0.9999…): never show 99% for 100%
  const value = `${Math.floor(zoom * 100 + 1e-6)}%`

  useEffect(() => {
    if (!open) return
    menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null
      if (t && (menuRef.current?.contains(t) || buttonRef.current?.contains(t))) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [open])

  const item = (
    id: string,
    label: string,
    run: () => void,
    opts: { chord?: string; keepOpen?: boolean; disabled?: boolean } = {},
  ) => (
    <button
      type="button"
      role="menuitem"
      className="dr-cnav__item"
      data-testid={`zoom-menu.${id}`}
      disabled={opts.disabled}
      onClick={() => {
        run()
        if (!opts.keepOpen) {
          setOpen(false)
          canvas.focus({ preventScroll: true })
        }
      }}
    >
      <span>{label}</span>
      {opts.chord ? <kbd className="dr-cnav__kbd">{formatChord(opts.chord, PLATFORM)}</kbd> : null}
    </button>
  )

  return (
    <div className="dr-cnav__zoom">
      <button
        ref={buttonRef}
        type="button"
        className="dr-cnav__btn dr-cnav__zoombtn"
        data-testid="minimap.zoom-menu-button"
        aria-label={`Zoom — ${value}`}
        title={`Zoom — ${value}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((o) => !o)}
        onDoubleClick={() => zoomTo100(canvas)}
      >
        {showValue ? <span>{value}</span> : <Svg>{Icon.plus}</Svg>}
      </button>
      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          className="dr-cnav__menu"
          data-testid="zoom-menu"
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return
            e.preventDefault()
            e.stopPropagation()
            setOpen(false)
            buttonRef.current?.focus()
          }}
        >
          {item('zoom-in', 'Zoom in', () => zoomIn(canvas), { chord: 'mod+=', keepOpen: true })}
          {item('zoom-out', 'Zoom out', () => zoomOut(canvas), { chord: 'mod+-', keepOpen: true })}
          {item('zoom-to-100', 'Zoom to 100%', () => zoomTo100(canvas), { chord: 'mod+0' })}
          {item('zoom-to-fit', 'Zoom to fit', () => zoomToFit(canvas), { chord: 'alt+1' })}
          {item('zoom-to-selection', 'Zoom to selection', () => zoomToSelection(canvas), {
            chord: 'alt+2',
            disabled: !hasSelection,
          })}
        </div>
      )}
    </div>
  )
}

/** N7-5: one "Linked from" row: the board and "Go to the link". */
function LinkedFromItem({ link }: { link: Backlink }) {
  const path = backlinkPath(link)
  return (
    <li className="dr-cnav__linked-item" data-testid="linked-from-item" data-board-id={link.boardId}>
      <span className="dr-cnav__linked-title" title={link.title}>
        {link.title}
      </span>
      <a
        className="dr-cnav__linked-go"
        data-testid="linked-from-go"
        href={path}
        rel="noopener noreferrer"
        referrerPolicy="no-referrer"
        {...boardLinkHandlers(path)}
      >
        Go to the link
      </a>
    </li>
  )
}

/** N7-5: "Linked from" (hidden while there is nothing to show, or the api cannot say). */
function LinkedFrom({ ctx }: { ctx: CanvasFeatureContext }) {
  // a name-only guest is refused "Linked from" by the api: never asked
  const list = useBacklinks(ctx.registries, ctx.board.id, knownUserKind(ctx.me.user.id) !== 'guest')
  const [open, setOpen] = useState(false)
  const listId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null
      if (t && rootRef.current?.contains(t)) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [open])
  if (!list?.length) return null
  const label = `Linked from ${list.length} ${list.length === 1 ? 'board' : 'boards'}`
  return (
    <div className="dr-cnav__linked" ref={rootRef} data-testid="linked-from">
      <button
        type="button"
        className="dr-cnav__btn"
        data-testid="navigation.linked-from"
        title={label}
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={(e) => {
          if (!open) countUsage('boardlinks.backlinks')
          setOpen((o) => !o)
          if (e.detail > 0 && open) ctx.canvas.focus({ preventScroll: true })
        }}
      >
        <Svg>{Icon.linked}</Svg>
        <span className="dr-cnav__linked-count">{list.length}</span>
      </button>
      {open && (
        <ul
          id={listId}
          className="dr-cnav__linked-list"
          data-testid="linked-from-list"
          aria-label="Linked from"
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return
            e.preventDefault()
            e.stopPropagation()
            setOpen(false)
          }}
        >
          <li className="dr-cnav__linked-head" aria-hidden="true">
            Linked from
          </li>
          {list.map((l) => (
            <LinkedFromItem key={l.boardId} link={l} />
          ))}
        </ul>
      )}
    </div>
  )
}

export function NavigationPanel({ ctx }: { ctx: CanvasFeatureContext }) {
  const { canvas } = ctx
  const width = useCanvasWidth(canvas)
  const open = useValue(minimapOpen)

  if (width < MOBILE_MIN_W) {
    return (
      <div className="dr-cnav dr-cnav--compact" data-testid="navigation-panel">
        <NavButton
          canvas={canvas}
          testId="navigation.zoom-to-fit"
          label="Zoom to fit"
          onClick={() => zoomToFit(canvas)}
        >
          <Svg>{Icon.fit}</Svg>
        </NavButton>
      </div>
    )
  }
  const tablet = width >= TABLET_MIN_W
  return (
    <div className="dr-cnav" data-testid="navigation-panel">
      <div className="dr-cnav__bar" role="toolbar" aria-label="Navigation">
        {tablet && open && (
          <NavButton
            canvas={canvas}
            testId="minimap.zoom-out"
            label={title('Zoom out', '-')}
            onClick={() => zoomOut(canvas)}
          >
            <Svg>{Icon.minus}</Svg>
          </NavButton>
        )}
        <ZoomMenu canvas={canvas} showValue />
        {tablet && open && (
          <NavButton
            canvas={canvas}
            testId="minimap.zoom-in"
            label={title('Zoom in', '=')}
            onClick={() => zoomIn(canvas)}
          >
            <Svg>{Icon.plus}</Svg>
          </NavButton>
        )}
        {tablet && (
          <NavButton
            canvas={canvas}
            testId="minimap.toggle-button"
            label={title(open ? 'Hide minimap' : 'Show minimap', 'm')}
            pressed={open}
            onClick={() => setMinimapOpen(!open)}
          >
            <Svg>{open ? Icon.left : Icon.right}</Svg>
          </NavButton>
        )}
        <LinkedFrom ctx={ctx} />
      </div>
      {tablet && open && <Minimap canvas={canvas} />}
    </div>
  )
}
