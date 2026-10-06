// OWNER: 3c. The people on the board, in the Excalidraw board page's top bar (the tldraw page's
// ../PeopleBar.tsx; WRK-02, FAC-01, FAC-07..10's per-person "Bring to me"):
// - the avatars (up to 5, 2 on narrow bars, none on phones; a click follows or stops following that
//   person), "+N";
// - "N following you": the people whose camera follows yours (presence `following` and the room's
//   followers list, CONTRACTS_REV 10, CR-3C-1) and, while you present to everyone, the presentation's
//   followers;
// - a people button that opens a searchable list: name, "(guest)", role, what they are doing (the frame
//   in their view, presenting, following the presentation, idle), with Follow / Following and, for
//   people who can edit, "Bring here" (the workshops summon with a target) and "Bring everyone to me".
// The roster (the server's sessions, uncapped) says who is here, with each person's role; presence adds
// their view and idle. Reads are serialized, so cursor movement re-renders nothing here; the list's frame
// and idle details are computed only while it is open.
// Wave J: an account outside Dark Burn / TPG gets an "External" tag in the list (with its domain where
// this viewer manages access) and says so on its avatar (../outside.ts, the server's outside list).

import { type CSSProperties, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { type CanvasFeatureContext, SINGLE_PAGE_ID } from '../../../canvas/api/index.ts'
import { initialsFor } from '../../../lib/identity.ts'
import { can } from '../../../lib/permissions.ts'
import { useValue } from '../../../lib/signals.ts'
import { onFocusLeave, trapTab } from '../../../ui/focus.ts'
import { PHONE_QUERY, useTopBarWidth } from '../../../ui/useMedia.ts'
import { getLive } from '../../present-export/live/ported/controller.ts'
import { namesText } from '../../present-export/live/words.ts'
import { PersonName } from '../../workshops/Hands.tsx'
import { summonScreen } from '../../workshops/ported/camera.ts'
import { WorkshopStore, workshopStoreFor } from '../../workshops/store.ts'
import { ExternalTag } from '../ExternalTag.tsx'
import {
  buildPeople,
  type FrameBox,
  filterPeople,
  followerSummary,
  type PersonRow,
  statusText,
} from '../model.ts'
import { externalTagTitle, useBoardOutside } from '../outside.ts'
import { frameBoxesOf, presenceLikes, presenceUsers, ROLE_LABEL, rosterMap } from './presence.ts'
import '../people.css'

const MAX_AVATARS = 5

function PeopleIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path
        d="M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20c0-3.3 2.9-5.5 6.5-5.5s6.5 2.2 6.5 5.5M16 4.3a3.5 3.5 0 0 1 0 6.4M18 14.8c2 .7 3.5 2.4 3.5 5.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  )
}

function EyeIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <path
        d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"
        fill="currentColor"
      />
    </svg>
  )
}

/** The workshops store of this board session (shared with the workshops feature: one per event stream). */
function workshopsOf(ctx: CanvasFeatureContext): WorkshopStore {
  return workshopStoreFor(
    ctx.events,
    () =>
      new WorkshopStore({
        boardId: ctx.board.id,
        userId: ctx.me.user.id,
        request: ctx.api.request,
        events: ctx.events,
      }),
  )
}

/** This tab's session id (whom "following you" means), or null before the welcome. */
const selfSidOf = (ctx: CanvasFeatureContext): string | null => ctx.canvas.engine?.welcome?.sid ?? null

/** Who follows you right now (names and count), serialized: re-renders only when that changes. */
function useFollowersOfMe(ctx: CanvasFeatureContext) {
  const selfUserId = ctx.me.user.id
  const { canvas } = ctx
  const key = useValue('dr-people-followers', () => {
    const presentation = getLive(ctx.registries)?.store.presentation.get() ?? null
    // camera followers (CR-3C-1): one record per person, "following you" when a session of theirs follows
    const followers = presenceLikes(
      canvas.collaborators(),
      canvas.presence.peers(),
      0,
      SINGLE_PAGE_ID,
      selfSidOf(ctx),
    )
    return JSON.stringify(followerSummary(followers, presentation, selfUserId))
  }, [ctx, canvas, selfUserId])
  return useMemo(() => JSON.parse(key) as { names: string[]; count: number }, [key])
}

/** Whom this tab follows: the user id of the followed session, or null. */
function useFollowingUser(ctx: CanvasFeatureContext): string | null {
  const { canvas } = ctx
  return useValue('dr-people-following-user', () => {
    const sid = canvas.follow.current()
    if (!sid) return null
    return canvas.collaborators().find((r) => r.sid === sid)?.uid ?? null
  }, [canvas])
}

export function PeopleTopBar({ ctx }: { ctx: CanvasFeatureContext }) {
  const { canvas } = ctx
  const selfUserId = ctx.me.user.id
  const [open, setOpen] = useState(false)
  const opener = useRef<HTMLButtonElement>(null)
  const panelId = useId()
  const width = useTopBarWidth()
  const max = width === 'phone' ? 0 : width === 'tablet' ? 2 : MAX_AVATARS
  // Serialized so cursor movement (which changes presence every frame) does not re-render the bar.
  const key = useValue(
    'dr-presence-users',
    () => JSON.stringify(presenceUsers(canvas.collaborators(), canvas.presence.peers(), selfUserId)),
    [canvas, selfUserId],
  )
  const users = useMemo(() => JSON.parse(key) as ReturnType<typeof presenceUsers>, [key])
  const { store: outside, snap: outsideSnap } = useBoardOutside(ctx.board.id)
  // a newcomer may be an outsider who just joined: the outside list refetches (rate-limited)
  useEffect(() => outside?.noticeUsers(users.map((u) => u.userId)), [outside, users])
  const following = useFollowingUser(ctx)
  const followers = useFollowersOfMe(ctx)
  const focusMode = useValue('dr-people-focus', () => canvas.settings.get().focusMode, [canvas])
  useEffect(() => {
    if (focusMode) setOpen(false)
  }, [focusMode])
  const shown = users.slice(0, max)
  const extra = users.length - shown.length
  const toggle = () => setOpen((o) => !o)
  const followersText =
    followers.count === 0
      ? ''
      : followers.names.length > 0
        ? `${namesText(followers.names, followers.count)} ${followers.count === 1 ? 'is' : 'are'} following you`
        : `${followers.count} following you`

  return (
    <div className="dr-people" data-testid="people">
      <ul className="dr-presence" data-testid="presence-list" aria-label="People on this board">
        {shown.map((u) => {
          const isFollowing = following === u.userId
          const external = !u.guest && outsideSnap.people.has(u.userId)
          const who = external ? `${u.name} (${externalTagTitle(null)})` : u.name
          return (
            <li
              key={u.userId}
              data-testid="presence-user"
              data-user-id={u.userId}
              data-guest={u.guest || undefined}
              data-external={external || undefined}
              title={who}
            >
              <button
                type="button"
                className="dr-avatar"
                style={{ background: u.color }}
                aria-pressed={isFollowing}
                aria-label={isFollowing ? `Stop following ${who}` : `Follow ${who}`}
                title={isFollowing ? `Following ${who}` : who}
                onClick={() => {
                  if (isFollowing) canvas.follow.stop()
                  else canvas.follow.start(u.followSid)
                }}
              >
                {initialsFor(u.name)}
              </button>
            </li>
          )
        })}
        {extra > 0 && max > 0 && (
          <li>
            <button
              type="button"
              className="dr-avatar dr-avatar--more"
              data-testid="presence-more"
              aria-label={`${extra} more people on this board. Show everyone`}
              title={users
                .slice(max)
                .map((u) => u.name)
                .join(', ')}
              onClick={toggle}
            >
              +{extra}
            </button>
          </li>
        )}
      </ul>
      {followers.count > 0 && (
        <button
          type="button"
          className="dr-people-followers"
          data-testid="people-followers"
          data-count={followers.count}
          title={followersText}
          aria-label={followersText}
          onClick={toggle}
        >
          <EyeIcon />
          <span>{followers.count}</span>
        </button>
      )}
      <button
        ref={opener}
        type="button"
        className="dr-iconbtn dr-people-open"
        data-testid="people-open"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={`People on this board (${users.length + 1})`}
        title="People on this board"
        onClick={toggle}
      >
        <PeopleIcon />
        <span className="dr-people-open__count">{users.length + 1}</span>
      </button>
      {open &&
        createPortal(
          <PeoplePanel
            id={panelId}
            ctx={ctx}
            anchor={opener}
            onClose={(refocus) => {
              setOpen(false)
              if (refocus) opener.current?.focus()
            }}
          />,
          document.body,
        )}
    </div>
  )
}

/** Re-renders every `ms` while mounted (idle flags age without any presence change). */
function useTick(ms: number): number {
  const [t, setT] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setT(Date.now()), ms)
    return () => clearInterval(id)
  }, [ms])
  return t
}

function PeoplePanel({
  id,
  ctx,
  anchor,
  onClose,
}: {
  id: string
  ctx: CanvasFeatureContext
  anchor: React.RefObject<HTMLButtonElement | null>
  onClose(refocus: boolean): void
}) {
  const { canvas } = ctx
  const [query, setQuery] = useState('')
  const [place, setPlace] = useState<CSSProperties>({})
  const panel = useRef<HTMLElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const now = useTick(10_000)
  const selfUserId = ctx.me.user.id
  const facilitator = can(ctx.role, 'edit', ctx.board.status)

  // Under the button that opened it (portaled: the bar clips and the "⋯" menu may be closing).
  useLayoutEffect(() => {
    const update = () => {
      // Phones: a sheet under the top bar, across the screen (people.css).
      if (window.matchMedia?.(PHONE_QUERY).matches) return setPlace({})
      const r = anchor.current?.getBoundingClientRect()
      if (!r || (r.width === 0 && r.height === 0)) return
      setPlace({ top: Math.round(r.bottom + 8), right: Math.max(8, Math.round(window.innerWidth - r.right)) })
    }
    update()
    window.addEventListener('resize', update)
    search.current?.focus()
    return () => window.removeEventListener('resize', update)
  }, [anchor])

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null
      if (panel.current?.contains(t) || anchor.current?.contains(t)) return
      onClose(false)
    }
    const onKey = (e: KeyboardEvent) => {
      const el = panel.current
      // A11Y2-05: Tab stays inside the list (portaled to the end of the page).
      if (e.key === 'Tab' && el?.contains(document.activeElement)) {
        trapTab(e, el)
        return
      }
      if (e.key !== 'Escape') return
      if (!el?.contains(document.activeElement) && document.activeElement !== document.body) return
      e.stopPropagation()
      onClose(true)
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    // A11Y2-05: the keyboard moving elsewhere (a dialog opening, a shortcut) closes the list.
    const off = panel.current
      ? onFocusLeave(
          panel.current,
          () => onClose(false),
          (to) => anchor.current?.contains(to) === true,
        )
      : () => {}
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
      off()
    }
  }, [anchor, onClose])

  // Frames change with the board, not with presence: serialized, so edits elsewhere re-render nothing here.
  const framesKey = useValue(
    'dr-people-frames',
    () =>
      JSON.stringify(
        frameBoxesOf(
          canvas.items().filter((e) => e.type === 'frame' && !e.isDeleted),
          SINGLE_PAGE_ID,
        ),
      ),
    [canvas],
  )
  const frames = useMemo(() => JSON.parse(framesKey) as FrameBox[], [framesKey])
  // Serialized: presence changes on every cursor move, the list only when what it shows changes.
  const rowsKey = useValue('dr-people-rows', () => {
    const me = ctx.me.user
    const roster = canvas.collaborators()
    const followedSid = canvas.follow.current()
    const rows = buildPeople({
      selfUserId,
      selfName: me.name,
      selfColor: me.color,
      selfFollowing: followedSid ? (roster.find((r) => r.sid === followedSid)?.uid ?? null) : null,
      collaborators: presenceLikes(roster, canvas.presence.peers(), now, SINGLE_PAGE_ID, selfSidOf(ctx)),
      roster: rosterMap(roster),
      presentation: getLive(ctx.registries)?.store.presentation.get() ?? null,
      frames,
      currentPageId: SINGLE_PAGE_ID,
      pageName: () => null,
      now,
    })
    return JSON.stringify(rows)
  }, [canvas, ctx, frames, now, selfUserId])
  const rows = useMemo(() => JSON.parse(rowsKey) as PersonRow[], [rowsKey])
  const shown = useMemo(() => filterPeople(rows, query), [rows, query])
  const followSids = useValue(
    'dr-people-follow-sids',
    () =>
      JSON.stringify(
        presenceUsers(canvas.collaborators(), canvas.presence.peers(), selfUserId).map((u) => [
          u.userId,
          u.followSid,
        ]),
      ),
    [canvas, selfUserId],
  )
  const sidOf = useMemo(() => new Map(JSON.parse(followSids) as [string, string][]), [followSids])
  const following = useFollowingUser(ctx)
  const others = rows.length - 1
  const { snap: outsideSnap } = useBoardOutside(ctx.board.id)

  const bring = async (row: PersonRow | null) => {
    const r = await workshopsOf(ctx).summon(row?.userId, summonScreen(ctx.canvas))
    if (r.ok) {
      onClose(false)
      ctx.notify({
        key: 'summon',
        text: row
          ? `${row.name} now follows your view until they move.`
          : 'Everyone here now follows your view. They stop following when they move.',
        testId: 'summon-toast',
      })
    } else {
      ctx.notify({
        key: 'summon',
        text: r.error ?? 'That did not work. Try again.',
        tone: 'error',
        testId: 'summon-toast',
      })
    }
  }

  return (
    <section
      ref={panel}
      id={id}
      className="dr-people-panel"
      role="dialog"
      aria-label="People on this board"
      data-testid="people-panel"
      style={place}
    >
      <header className="dr-people-panel__head">
        <h2>
          People on this board <span className="dr-people-panel__count">{rows.length}</span>
        </h2>
        <button type="button" className="dr-iconbtn" aria-label="Close" onClick={() => onClose(true)}>
          ×
        </button>
      </header>
      <input
        ref={search}
        type="search"
        className="dr-input dr-people-panel__search"
        data-testid="people-search"
        placeholder="Search people"
        aria-label="Search people on this board"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <ul className="dr-people-list" aria-label="People">
        {shown.map((r) => {
          const sid = sidOf.get(r.userId) ?? null
          const iFollow = !r.self && following === r.userId
          return (
            <li
              key={r.userId}
              className="dr-people-row"
              data-testid="people-row"
              data-user-id={r.userId}
              data-status={r.status}
              data-idle={r.idle ? 'true' : undefined}
            >
              <span className="dr-people-row__avatar" style={{ background: r.color }} aria-hidden="true">
                {initialsFor(r.name)}
              </span>
              <div className="dr-people-row__main">
                <div className="dr-people-row__name">
                  <PersonName name={r.name} suffix={r.self ? ' (you)' : undefined} />
                  {!r.guest && outsideSnap.people.has(r.userId) && (
                    <ExternalTag domain={outsideSnap.people.get(r.userId) ?? null} />
                  )}
                  {r.role && (
                    <span className="dr-people-role" data-testid="people-role" data-role={r.role}>
                      {ROLE_LABEL[r.role]}
                    </span>
                  )}
                </div>
                <div className="dr-people-row__status" data-testid="people-status">
                  {statusText(r)}
                </div>
              </div>
              {!r.self && sid && r.status === 'presenting' && (
                // The presenter: follow their slides (present-live) rather than their camera.
                <div className="dr-people-row__actions">
                  <button
                    type="button"
                    className="dr-btn dr-btn--sm dr-btn--primary"
                    data-testid="people-join"
                    aria-label={`Join ${r.name}’s presentation`}
                    onClick={() => {
                      onClose(false)
                      getLive(ctx.registries)?.join()
                    }}
                  >
                    Join
                  </button>
                </div>
              )}
              {!r.self && sid && r.status !== 'presenting' && (
                <div className="dr-people-row__actions">
                  <button
                    type="button"
                    className="dr-btn dr-btn--sm dr-people-follow"
                    data-testid="people-follow"
                    aria-pressed={iFollow}
                    aria-label={iFollow ? `Stop following ${r.name}` : `Follow ${r.name}`}
                    onClick={() => {
                      if (iFollow) {
                        canvas.follow.stop()
                        return
                      }
                      canvas.follow.start(sid)
                      onClose(false)
                    }}
                  >
                    {iFollow ? 'Following' : 'Follow'}
                  </button>
                  {facilitator && (
                    <button
                      type="button"
                      className="dr-btn dr-btn--sm"
                      data-testid="people-bring"
                      title={`Bring ${r.name} to your view`}
                      aria-label={`Bring ${r.name} to your view`}
                      onClick={() => void bring(r)}
                    >
                      Bring here
                    </button>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ul>
      {shown.length === 0 && (
        <p className="dr-people-panel__empty" data-testid="people-empty">
          No one here matches “{query.trim()}”.
        </p>
      )}
      {others === 0 && !query && (
        <p className="dr-people-panel__empty">Only you right now. Share the board to invite people.</p>
      )}
      {facilitator && others > 0 && (
        <footer className="dr-people-panel__foot">
          <button
            type="button"
            className="dr-btn dr-btn--sm dr-people-panel__all"
            data-testid="people-bring-all"
            onClick={() => void bring(null)}
          >
            Bring everyone to me
          </button>
        </footer>
      )}
    </section>
  )
}
