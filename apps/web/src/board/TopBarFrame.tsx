// The board top bar's layout, shared by both board pages (engine-neutral: no tldraw, no engine). What
// differs per engine comes in as render props: the people list, the live-presentation chip and the
// feature controls (the tldraw page's BOARD_FEATURES items, ./TopBar.tsx; the Excalidraw page's top-bar
// registry, canvas/board/**). Integration owner (2C).
import type { Board } from '@draftroom/contracts'
import { type ReactNode, type RefObject, useLayoutEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { UserMenu } from '../auth/UserMenu.tsx'
import { Mark } from '../brand/Wordmark.tsx'
import { type BoardRole, can } from '../lib/permissions.ts'
import { linkClick, workspacePath } from '../lib/routing.ts'
import { SaveStatus, type SaveStatusView } from '../sync-quality/SaveStatus.tsx'
import { OverflowMenu } from '../ui/OverflowMenu.tsx'
import { RenameInput } from '../ui/RenameInput.tsx'
import { useTopBarWidth } from '../ui/useMedia.ts'
import { readonlyPill } from './access.ts'
import {
  compactValue,
  firstFittingLevel,
  hasContent,
  mayLeaveMenu,
  type TitleMeasure,
  titleFits,
  titleNeed,
} from './topbar-fit.ts'

export type ConnState = 'connecting' | 'online' | 'offline' | 'error'

const CONN_LABEL: Record<ConnState, string> = {
  connecting: 'Connecting…',
  online: 'Live',
  offline: 'Offline',
  error: 'Disconnected',
}
const CONN_TITLE: Record<ConnState, string> = {
  connecting: 'Connecting to the board server',
  online: 'Connected: your changes are sent to everyone on this board as you make them',
  offline:
    'Offline: changes are kept in this tab only until the connection returns. Reloading now would lose them.',
  error: 'The connection to this board ended',
}

/** Which feature controls the bar asks for: all of them, the pinned ones, or the rest as "⋯" menu rows. */
export type TopBarItemsMode = 'all' | 'pinned' | 'overflow'

export interface TopBarFrameProps {
  board: Board
  role: BoardRole
  workspace: { id: string; name: string }
  /** The socket only ("Live"): never evidence that anything was saved. */
  conn: ConnState
  /** What the server has acknowledged. */
  save: SaveStatusView
  onRename(title: string): void
  onShare(): void
  /** The role pill opens the request-more-access flow (PRI-09b). */
  onRequestAccess(): void
  /** The live-presentation chip (present-live), or nothing. */
  liveChip?: ReactNode
  /** The people on the board, at most `max` avatars (in the bar; on phones inside the "⋯" menu). */
  people(max: number): ReactNode
  /** The feature controls placed before Share. */
  items(mode: TopBarItemsMode): ReactNode
}

export function TopBarFrame({
  board,
  role,
  workspace,
  conn,
  save,
  onRename,
  onShare,
  onRequestAccess,
  liveChip,
  people,
  items,
}: TopBarFrameProps) {
  const home = workspacePath(workspace.id)
  const pill = readonlyPill(role, board.status)
  const pillIcon = board.status !== 'archived' && can(role, 'comment', board.status) ? 'comment' : 'eye'
  // PRI-02: at 768 px and below the feature controls (present, export, timer, sharing badge) move
  // into a "⋯" menu; at 480 px and below the people list and the account button do too. The title,
  // the bell and Share always stay in the bar.
  const width = useTopBarWidth()
  const narrow = width !== 'wide'
  const phone = width === 'phone'
  // F4: a wide bar compacts its controls (then, if still too full, moves them into "⋯") before the
  // board title drops below about 24 characters.
  const bar = useRef<HTMLElement>(null)
  const crowded = useTopBarFit(bar, narrow)
  const menu = narrow || crowded
  // The role pill already says what a viewer/commenter can do: a second "View only" is noise (RETRO-17).
  const saveHidden = !!pill && save.state === 'readonly'
  // W5-50: on a phone the people list sits in the "⋯" menu, unless the people feature draws its own chip
  // in the bar (`people()` is then nothing): a caption with nothing under it is not drawn.
  const menuPeople = phone ? people(MAX_AVATARS) : null
  // Tab order = DOM order (RETRO-22a): breadcrumb, title, role, people, status, feature controls,
  // Share. The account (DEV identity) badge is drawn at the bar's right end and comes right after
  // Share (A11Y-09: BoardAccount below, rendered by BoardPage just after this bar); on phones it is in
  // the menu.
  return (
    <header
      ref={bar}
      className="dr-topbar"
      data-width={width}
      data-crowded={crowded || undefined}
      data-testid="topbar"
    >
      <a
        className="dr-topbar__home"
        href={home}
        onClick={linkClick(home)}
        aria-label={`Back to ${workspace.name}`}
      >
        <Mark size={24} />
      </a>
      <span className="dr-topbar__sep" aria-hidden="true" />
      <div className="dr-topbar__board">
        <a className="dr-topbar__ws" href={home} onClick={linkClick(home)} title={workspace.name}>
          {workspace.name}
        </a>
        <span className="dr-topbar__slash" aria-hidden="true">
          /
        </span>
        <BoardTitle title={board.title} canRename={can(role, 'rename', board.status)} onRename={onRename} />
      </div>
      {pill && (
        <button
          type="button"
          className="dr-pill dr-pill--role"
          data-testid="readonly-pill"
          data-role={role}
          title={pill.request ? `${pill.title}. Ask for more access.` : pill.title}
          aria-label={pill.request ? `${pill.label}: ask for more access` : pill.label}
          aria-haspopup={pill.request ? 'dialog' : undefined}
          disabled={!pill.request}
          onClick={onRequestAccess}
        >
          {/* DANA-11: a speech bubble for "Can comment", the eye for view only. */}
          <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true" data-icon={pillIcon}>
            {pillIcon === 'comment' ? (
              <path
                d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.2 3.6c-.6.5-1.8.2-1.8-.8z"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinejoin="round"
              />
            ) : (
              <path
                d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"
                fill="currentColor"
              />
            )}
          </svg>
          <span className="dr-pill__label">{pill.label}</span>
        </button>
      )}
      <div className="dr-topbar__spacer" />
      {/* Wave 4 (present-live): rejoin a presentation to everyone; the people list (features/people). */}
      {liveChip}
      {!phone && people(narrow ? 2 : MAX_AVATARS)}
      <SaveStatus view={save} hidden={saveHidden} />
      <span
        className={`dr-pill dr-pill--${conn}`}
        data-testid="conn-status"
        data-state={conn}
        role="status"
        title={CONN_TITLE[conn]}
      >
        <span className="dr-pill__dot" aria-hidden="true" />
        <span className="dr-pill__label">{CONN_LABEL[conn]}</span>
      </span>
      {items(menu ? 'pinned' : 'all')}
      {menu && (
        <OverflowMenu label="More board controls" testId="topbar-overflow">
          {items('overflow')}
          {hasContent(menuPeople) && (
            <div className="dr-overflow__item" data-feature="people">
              <span className="dr-overflow__caption" aria-hidden="true">
                On this board
              </span>
              {menuPeople}
            </div>
          )}
          {phone && (
            <div className="dr-overflow__item" data-feature="account">
              <span className="dr-overflow__caption" aria-hidden="true">
                Your account
              </span>
              <UserMenu />
            </div>
          )}
        </OverflowMenu>
      )}
      <button
        type="button"
        className="dr-btn dr-btn--primary dr-btn--sm dr-topbar__share"
        data-testid="share-button"
        aria-label="Share"
        onClick={onShare}
      >
        <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
          <path
            d="M16 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM8 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM2 20c0-3 2.7-5 6-5s6 2 6 5M14 15.5c.6-.3 1.3-.5 2-.5 3.3 0 6 2 6 5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
          />
        </svg>
        <span className="dr-topbar__share-label">Share</span>
      </button>
    </header>
  )
}

/**
 * The account button of the board page, drawn at the right end of the top bar and placed right after
 * it in the DOM, so Tab reaches it after Share, as it is drawn (A11Y-09). The bar keeps room for it
 * through --dr-account-w. On phones it lives in the "⋯" menu.
 */
export function BoardAccount() {
  const width = useTopBarWidth()
  const wrap = useRef<HTMLDivElement>(null)
  const phone = width === 'phone'
  useLayoutEffect(() => {
    const el = wrap.current
    const board = el?.closest<HTMLElement>('.dr-board')
    if (!el || !board) return
    const set = () =>
      board.style.setProperty('--dr-account-w', `${Math.ceil(el.getBoundingClientRect().width)}px`)
    set()
    const ro = new ResizeObserver(set)
    ro.observe(el)
    return () => {
      ro.disconnect()
      board.style.removeProperty('--dr-account-w')
    }
  }, [phone])
  if (phone) return null
  return (
    <div className="dr-board__account" ref={wrap}>
      <UserMenu compact />
    </div>
  )
}

function BoardTitle({
  title,
  canRename,
  onRename,
}: {
  title: string
  canRename: boolean
  onRename(title: string): void
}) {
  const [editing, setEditing] = useState(false)
  if (!canRename) {
    return (
      <h1 className="dr-topbar__title" data-testid="board-title" title={title}>
        {title}
      </h1>
    )
  }
  if (editing) {
    return (
      <RenameInput
        initial={title}
        label="Board title"
        testId="board-title-input"
        className="dr-input dr-topbar__title-input"
        onSubmit={(next) => {
          setEditing(false)
          onRename(next)
        }}
        onCancel={() => setEditing(false)}
      />
    )
  }
  return (
    <h1 className="dr-topbar__h1">
      <button
        type="button"
        className="dr-topbar__title dr-topbar__title--editable"
        data-testid="board-title"
        title="Rename board"
        aria-label={`${title}, rename board`}
        onClick={() => setEditing(true)}
      >
        {title}
      </button>
    </h1>
  )
}

const MAX_AVATARS = 5

let measureCtx: CanvasRenderingContext2D | null | undefined

/** The board title's box and what MIN_TITLE_CHARS of it need, in its own font (null while renaming). */
function titleMeasure(header: HTMLElement): TitleMeasure | null {
  const el = header.querySelector<HTMLElement>('.dr-topbar__title')
  if (!el) return null
  const cs = getComputedStyle(el)
  if (measureCtx === undefined) measureCtx = document.createElement('canvas').getContext('2d')
  const ctx = measureCtx
  if (ctx) ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`
  const em = Number.parseFloat(cs.fontSize) || 15
  const measure = (text: string) => (ctx ? ctx.measureText(text).width : Array.from(text).length * em * 0.6)
  const padding = (Number.parseFloat(cs.paddingLeft) || 0) + (Number.parseFloat(cs.paddingRight) || 0)
  return {
    client: el.clientWidth,
    scroll: el.scrollWidth,
    need: titleNeed(el.textContent ?? '', measure, padding),
  }
}

/**
 * F4: keeps the board title readable in a wide top bar (topbar-fit.ts). Whenever something can move
 * (the bar's width, a chip appearing, a label or the timer changing, fonts arriving) it applies the
 * compact steps again from none upwards, before the browser paints, and stops at the first that lets
 * the title show at least MIN_TITLE_CHARS characters. Returns true while even the most compact bar is
 * too full: the feature controls then sit in the "⋯" menu until the bar grows past that width.
 */
function useTopBarFit(bar: RefObject<HTMLElement | null>, narrow: boolean): boolean {
  const [crowded, setCrowded] = useState(false)
  const state = useRef({ crowded: false, crowdedAt: 0 })
  state.current.crowded = crowded
  useLayoutEffect(() => {
    const header = bar.current
    if (!header) return
    // Tablets and phones have their own layout (the "⋯" menu, icon-only pills: PRI-02).
    if (narrow) {
      delete header.dataset.compact
      return
    }
    let disposed = false
    const apply = (level: number) => {
      const value = compactValue(level)
      if (header.dataset.compact !== value) header.dataset.compact = value
    }
    const fits = (level: number) => {
      apply(level)
      return titleFits(titleMeasure(header))
    }
    // From an observer, the menu switch renders at once (flushSync), so no frame shows the overflowing
    // bar; from this effect a plain update does the same (React re-renders before the paint), and
    // flushSync there would be a React error.
    const setMenu = (value: boolean, fromObserver: boolean) => {
      if (fromObserver) flushSync(() => setCrowded(value))
      else setCrowded(value)
    }
    const fit = (fromObserver: boolean) => {
      if (disposed) return
      const s = state.current
      const width = header.clientWidth
      if (s.crowded && mayLeaveMenu(width, s.crowdedAt)) {
        // Try the controls in the bar again; the re-render's mutations call fit() once more.
        s.crowded = false
        setMenu(false, fromObserver)
        return
      }
      if (firstFittingLevel(fits) !== null || s.crowded) return
      s.crowded = true
      s.crowdedAt = width
      setMenu(true, fromObserver)
    }
    const resize = new ResizeObserver(() => fit(true))
    resize.observe(header)
    const mutations = new MutationObserver((records) => {
      // Our own data-compact changes are not a reason to measure again.
      if (records.every((r) => r.target === header && r.attributeName === 'data-compact')) return
      fit(true)
    })
    mutations.observe(header, { subtree: true, childList: true, characterData: true, attributes: true })
    fit(false)
    document.fonts?.ready.then(
      () => fit(true),
      () => {},
    )
    return () => {
      disposed = true
      resize.disconnect()
      mutations.disconnect()
    }
  }, [bar, narrow])
  return crowded
}
