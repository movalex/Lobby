// The board top bar's layout, shared by both board pages (engine-neutral: no tldraw, no engine). What
// differs per engine comes in as render props: the people list, the live-presentation chip and the
// feature controls (the tldraw page's BOARD_FEATURES items, ./TopBar.tsx; the Excalidraw page's top-bar
// registry, canvas/board/**). Integration owner (2C).
//
// K2-5 (wave K, UXD-01, F3, UXP-11, UXP-5): a calmer bar (./topbar-fit.ts `topBarPlan`, `statusView`):
//  - one status dot for Saved and Live (`BoardStatus`): words beside it only when something needs attention,
//    both halves in its tooltip and for screen readers, never "Saved" before the board is live; the hidden
//    live region that speaks problems and recoveries (A11Y-14) is no `status` node, so "Saved" is read once;
//  - an always-visible Feedback pill (wave J5's dialog through features/feedback/state.ts `openFeedback`; in
//    the "⋯" menu on a phone);
//  - "Shared outside" is a badge on Share (same test id and tooltip), and the sharing link badge (the sharing
//    feature's control) sits against Share (canvas-ux.css);
//  - the H1 is named by the title alone; its button is "Rename board";
//  - on a phone the bell and the comment tool are in "⋯" (the comments feature's items; the comment tool left
//    the bar everywhere else: the toolbar's Comment and the rail's Comments stay).
// Moved controls keep their test ids (save-status, conn-status, topbar-shared-outside, notifications-bell,
// comment-tool). The new parts are styled in features/canvas-ux/canvas-ux.css (loaded with the board page).

import type { Board } from '@draftroom/contracts'
import { SHARED_OUTSIDE_LABEL, SHARED_OUTSIDE_TITLE } from '@draftroom/contracts'
import { type ReactNode, type RefObject, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { UserMenu } from '../auth/UserMenu.tsx'
import { Mark } from '../brand/Wordmark.tsx'
import { useMayGiveFeedback } from '../features/feedback/audience.ts'
import { openFeedback } from '../features/feedback/state.ts'
import { useBoardOutside } from '../features/people/outside.ts'
import { useIsGuest } from '../invite/guest.tsx'
import { type BoardRole, can } from '../lib/permissions.ts'
import { linkClick, workspacePath } from '../lib/routing.ts'
import { type SaveStatusView, saveAnnouncement } from '../sync-quality/SaveStatus.tsx'
import type { DisplayState } from '../sync-quality/save-state.ts'
import { OverflowMenu } from '../ui/OverflowMenu.tsx'
import { RenameInput } from '../ui/RenameInput.tsx'
import { useTopBarWidth } from '../ui/useMedia.ts'
import { readonlyPill, shareButtonView } from './access.ts'
import {
  type ConnState,
  compactValue,
  firstFittingLevel,
  hasContent,
  mayLeaveMenu,
  statusView,
  type TitleMeasure,
  titleFits,
  titleNeed,
  topBarPlan,
} from './topbar-fit.ts'

export type { ConnState } from './topbar-fit.ts'

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
  // DANA-11 / F14 / PRI-18: viewers, commenters and guests cannot hand out access: "People", not primary.
  const share = shareButtonView(role, useIsGuest())
  const pillIcon = board.status !== 'archived' && can(role, 'comment', board.status) ? 'comment' : 'eye'
  // Wave J: "Shared outside" while someone outside Dark Burn / TPG, a guest or an open link can open the
  // board (the server's flag on the board's outside list, refetched when sharing changes). K2-5: a badge on Share.
  const { snap: outside } = useBoardOutside(board.id)
  const outsideId = useId()
  // PRI-02: at 768 px and below the feature controls (present, export, timer, sharing badge) move
  // into a "⋯" menu; at 480 px and below the people list, the account button, Feedback, the bell and the
  // comment tool do too (K2-5). The title, the status dot and Share always stay in the bar.
  const width = useTopBarWidth()
  const narrow = width !== 'wide'
  // F4: a wide bar compacts its controls (then, if still too full, moves them into "⋯") before the
  // board title drops below about 24 characters.
  const bar = useRef<HTMLElement>(null)
  const crowded = useTopBarFit(bar, narrow)
  const menu = narrow || crowded
  // P-023: Feedback is the team's: an external client or a name-only guest does not see it
  const plan = topBarPlan(width, crowded, useMayGiveFeedback())
  const inBar = new Set(plan.bar)
  const inMenu = new Set(plan.menu)
  // The role pill already says what a viewer/commenter can do: a second "View only" is noise (RETRO-17).
  const saveHidden = !!pill && save.state === 'readonly'
  // W5-50: on a phone the people list sits in the "⋯" menu, unless the people feature draws its own chip
  // in the bar (`people()` is then nothing): a caption with nothing under it is not drawn.
  const menuPeople = inMenu.has('people') ? people(MAX_AVATARS) : null
  const feedbackBoard = { id: board.id, title: board.title }
  // Tab order = DOM order (RETRO-22a): breadcrumb, title, role, Feedback, people, status, feature controls,
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
      {inBar.has('feedback') && <FeedbackPill board={feedbackBoard} />}
      {/* Wave 4 (present-live): rejoin a presentation to everyone; the people list (features/people). */}
      {liveChip}
      {inBar.has('people') && people(narrow ? 2 : MAX_AVATARS)}
      <BoardStatus save={save} conn={conn} saveHidden={saveHidden} />
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
          {inMenu.has('feedback') && (
            <div className="dr-overflow__item" data-feature="feedback">
              <FeedbackPill board={feedbackBoard} wide />
            </div>
          )}
          {inMenu.has('account') && (
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
        className={`dr-btn ${share.primary ? 'dr-btn--primary ' : ''}dr-btn--sm dr-topbar__share`}
        data-testid="share-button"
        data-variant={share.primary ? 'share' : 'people'}
        data-outside={outside.sharedOutside || undefined}
        aria-label={share.label}
        // the name stays what the button does; "Shared outside" is its description
        aria-describedby={outside.sharedOutside ? outsideId : undefined}
        title={share.primary ? undefined : share.title}
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
        <span className="dr-topbar__share-label">{share.label}</span>
        {outside.sharedOutside && <SharedOutsideBadge />}
      </button>
      {outside.sharedOutside && (
        <span id={outsideId} className="dr-sr-only">
          {SHARED_OUTSIDE_LABEL}: {SHARED_OUTSIDE_TITLE}
        </span>
      )}
    </header>
  )
}

/**
 * K2-5: "Shared outside" as a badge on Share (wave J's marker: the same test id and tooltip; for screen readers
 * the words are Share's description, its name staying what it does).
 */
function SharedOutsideBadge() {
  return (
    <span
      className="dr-topbar__share-badge"
      data-testid="topbar-shared-outside"
      title={SHARED_OUTSIDE_TITLE}
      aria-hidden="true"
    >
      <svg viewBox="0 0 24 24" width="10" height="10" aria-hidden="true">
        <path
          d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3.5 12h17M12 3c2.5 2.6 3.7 5.6 3.7 9s-1.2 6.4-3.7 9c-2.5-2.6-3.7-5.6-3.7-9S9.5 5.6 12 3z"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  )
}

/**
 * K2-5 (F3): the always-visible Feedback pill: wave J5's dialog (features/feedback/state.ts `openFeedback`,
 * about this board); the keyboard comes back to the pill when the dialog closes. `wide`: the "⋯" menu's row.
 */
export function FeedbackPill({
  board,
  wide = false,
}: {
  board: { id: string; title: string }
  wide?: boolean
}) {
  const ref = useRef<HTMLButtonElement>(null)
  return (
    <button
      ref={ref}
      type="button"
      className={`dr-btn dr-btn--sm dr-topbar__feedback${wide ? ' dr-topbar__feedback--wide' : ''}`}
      data-testid="topbar-feedback"
      aria-label={wide ? undefined : 'Send feedback'}
      title="Send feedback about Lobby"
      onClick={() => openFeedback(board, () => ref.current?.focus())}
    >
      <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
        <path
          d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.2 3.6c-.6.5-1.8.2-1.8-.8z"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinejoin="round"
        />
      </svg>
      <span className="dr-topbar__feedback-label">{wide ? 'Send feedback' : 'Feedback'}</span>
    </button>
  )
}

/**
 * A11Y-14: the words for the hidden live region, set only when `saveAnnouncement` has something to say (a
 * problem, or the recovery from one; never the "Saving…"/"Saved" of every edit).
 */
function useSaveAnnouncement(state: DisplayState, role?: string, label?: string): string {
  const [text, setText] = useState('')
  const prev = useRef<DisplayState | null>(null)
  const trouble = useRef<DisplayState | null>(null)
  useEffect(() => {
    const a = saveAnnouncement(prev.current, state, trouble.current, role, label)
    prev.current = state
    trouble.current = a.trouble
    const say = a.say
    // The same words twice (offline again) must change the region's text to be spoken again.
    if (say) setText((t) => (t === say ? `${say} ` : say))
  }, [state, role, label])
  return text
}

/**
 * K2-5 (UXD-01, UXP-11): one status dot for Saved and Live (./topbar-fit.ts `statusView`). The dot alone while
 * all is well (its tooltip says "Saved" and "Live"); its words beside it when something needs attention. For
 * screen readers it reads "Saved" then "Live" once (the test ids `save-status` and `conn-status` stay on those
 * words); the live region next to it speaks only problems and recoveries and is no `status` node.
 */
export function BoardStatus({
  save,
  conn,
  saveHidden,
}: {
  save: SaveStatusView
  conn: ConnState
  saveHidden: boolean
}) {
  const v = statusView(save, conn, saveHidden)
  const announcement = useSaveAnnouncement(save.state, save.role, save.label)
  return (
    <>
      <span
        className={`dr-status dr-status--${v.tone}`}
        data-testid="board-status"
        data-tone={v.tone}
        title={v.title}
      >
        <span className="dr-status__dot" aria-hidden="true" />
        {v.label && (
          <span className="dr-status__label" aria-hidden="true">
            {v.label}
          </span>
        )}
        <span
          className="dr-sr-only"
          data-testid="save-status"
          data-state={save.state}
          data-role={save.role}
          title={v.saveTitle ?? undefined}
          // Hidden, not removed, when the role pill already says it: it comes back by itself if the
          // session goes offline or errors.
          hidden={saveHidden}
        >
          {v.saveText}
        </span>
        <span className="dr-sr-only" data-testid="conn-status" data-state={conn} title={v.connTitle}>
          {v.connText}
        </span>
      </span>
      <span className="dr-sr-only" aria-live="polite" aria-atomic="true" data-testid="save-announcer">
        {announcement}
      </span>
    </>
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

/**
 * UXP-11 (K2-5): the H1 is named by the board's title alone ("Launch plan", not "Launch plan, rename board");
 * the button inside it is "Rename board", described by the title.
 */
export function BoardTitle({
  title,
  canRename,
  onRename,
}: {
  title: string
  canRename: boolean
  onRename(title: string): void
}) {
  const [editing, setEditing] = useState(false)
  const titleId = useId()
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
    <h1 className="dr-topbar__h1" aria-labelledby={titleId}>
      <button
        type="button"
        className="dr-topbar__title dr-topbar__title--editable"
        data-testid="board-title"
        title="Rename board"
        aria-label="Rename board"
        aria-describedby={titleId}
        onClick={() => setEditing(true)}
      >
        <span id={titleId}>{title}</span>
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
