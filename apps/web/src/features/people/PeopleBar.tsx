// The people on the board, in the top bar (WRK-02, FAC-01, FAC-07..10's per-person "Bring to me"):
// - the avatars (up to `max`; a click follows or stops following that person, as before), "+N";
// - "N following you" when anyone follows you (tldraw's follow, or your presentation to everyone);
// - a people button that opens a searchable list: name, "(guest)", role, what they are doing (the
//   frame in their view, following whom, idle), with Follow / Following and, for people who can
//   edit, "Bring here" (the workshops summon with a target) and "Bring everyone to me".
// Presence is read with narrow, serialized selectors, so cursor movement re-renders nothing here; the
// list's frame and idle details are computed only while it is open.

import { type CSSProperties, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { type Editor, useValue } from 'tldraw'
import { presenceUsers } from '../../board/presence.ts'
import { initialsFor } from '../../lib/identity.ts'
import { can } from '../../lib/permissions.ts'
import { PHONE_QUERY } from '../../ui/useMedia.ts'
import { getLive } from '../present-export/live/controller.ts'
import { namesText } from '../present-export/live/words.ts'
import type { FeatureContext } from '../types.ts'
import { PersonName } from '../workshops/Hands.tsx'
import { storeFor } from '../workshops/hooks.ts'
import { usePresenting } from '../workshops/presenting.ts'
import { frameBoxes, frameRecordsQuery } from './frames.ts'
import {
  buildPeople,
  type FrameBox,
  filterPeople,
  followerSummary,
  type PersonRow,
  type PresenceLike,
  statusText,
} from './model.ts'
import { ROLE_LABEL, rosterFor } from './roster.ts'
import './people.css'

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

const presenceOf = (editor: Editor): PresenceLike[] =>
  editor.getCollaborators().map((c) => ({
    userId: c.userId,
    userName: c.userName,
    color: c.color,
    followingUserId: c.followingUserId,
    lastActivityTimestamp: c.lastActivityTimestamp,
    currentPageId: c.currentPageId,
    camera: c.camera,
    screenBounds: c.screenBounds,
  }))

/** Who follows you right now (names and count), serialized: re-renders only when that changes. */
function useFollowersOfMe(editor: Editor | null, selfUserId: string) {
  const key = useValue('dr-people-followers', () => {
    if (!editor) return '{"names":[],"count":0}'
    const presentation = getLive(editor)?.store.presentation.get() ?? null
    return JSON.stringify(followerSummary(editor.getCollaborators(), presentation, selfUserId))
  }, [editor, selfUserId])
  return useMemo(() => JSON.parse(key) as { names: string[]; count: number }, [key])
}

export function PeopleTopBar({
  editor,
  ctx,
  selfUserId,
  max,
}: {
  editor: Editor | null
  ctx: FeatureContext | null
  selfUserId: string
  max: number
}) {
  const [open, setOpen] = useState(false)
  const opener = useRef<HTMLButtonElement>(null)
  const panelId = useId()
  // Serialized so cursor movement (which changes presence every frame) does not re-render the bar.
  const key = useValue(
    'dr-presence-users',
    () => (editor ? JSON.stringify(presenceUsers(editor.getCollaborators(), selfUserId)) : '[]'),
    [editor, selfUserId],
  )
  const following = useValue('dr-following', () => editor?.getInstanceState().followingUserId ?? null, [
    editor,
  ])
  const users = useMemo(() => JSON.parse(key) as ReturnType<typeof presenceUsers>, [key])
  const followers = useFollowersOfMe(editor, selfUserId)
  const presenting = usePresenting()
  useEffect(() => {
    if (presenting) setOpen(false)
  }, [presenting])
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
          const isFollowing = following === u.followId
          return (
            <li key={u.userId} data-testid="presence-user" data-user-id={u.userId}>
              <button
                type="button"
                className="dr-avatar"
                style={{ background: u.color }}
                aria-pressed={isFollowing}
                aria-label={isFollowing ? `Stop following ${u.name}` : `Follow ${u.name}`}
                title={isFollowing ? `Following ${u.name}` : u.name}
                disabled={!editor}
                onClick={() => {
                  if (!editor) return
                  if (isFollowing) editor.stopFollowingUser()
                  else editor.startFollowingUser(u.followId)
                }}
              >
                {initialsFor(u.name)}
              </button>
            </li>
          )
        })}
        {extra > 0 && (
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
              disabled={!ctx}
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
          disabled={!ctx}
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
        disabled={!ctx || !editor}
        onClick={toggle}
      >
        <PeopleIcon />
        <span className="dr-people-open__count">{users.length + 1}</span>
      </button>
      {open &&
        ctx &&
        editor &&
        createPortal(
          <PeoplePanel
            id={panelId}
            ctx={ctx}
            editor={editor}
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
  editor,
  anchor,
  onClose,
}: {
  id: string
  ctx: FeatureContext
  editor: Editor
  anchor: React.RefObject<HTMLButtonElement | null>
  onClose(refocus: boolean): void
}) {
  const [query, setQuery] = useState('')
  const [place, setPlace] = useState<CSSProperties>({})
  const panel = useRef<HTMLElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const roster = useMemo(() => rosterFor(ctx), [ctx])
  const entries = useValue('dr-people-roster', () => roster.entries.get(), [roster])
  const now = useTick(10_000)
  const selfUserId = ctx.me.user.id
  const facilitator = can(ctx.role, 'edit', ctx.board.status)

  useEffect(() => {
    void roster.load()
  }, [roster])

  // Under the button that opened it (portaled: the bar clips and the "⋯" menu may be closing).
  useLayoutEffect(() => {
    const update = () => {
      // Phones: a sheet under the top bar, across the screen (people.css); the button may sit in the
      // "⋯" menu, which closes as the list opens.
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
      if (e.key !== 'Escape') return
      if (!panel.current?.contains(document.activeElement) && document.activeElement !== document.body) return
      e.stopPropagation()
      onClose(true)
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [anchor, onClose])

  // Frames change with the board, not with presence: their own derivation (only while open), from
  // the frame records alone and serialized, so edits elsewhere on the board re-render nothing here.
  const frameRecords = useMemo(() => frameRecordsQuery(editor), [editor])
  const framesKey = useValue(
    'dr-people-frames',
    () => JSON.stringify(frameBoxes(editor, frameRecords.get())),
    [editor, frameRecords],
  )
  const frames = useMemo(() => JSON.parse(framesKey) as FrameBox[], [framesKey])
  // Serialized: presence changes on every cursor move, the list only when what it shows changes.
  const rowsKey = useValue('dr-people-rows', () => {
    const live = getLive(editor)
    const me = ctx.me.user
    const rows = buildPeople({
      selfUserId,
      selfName: me.name,
      selfColor: me.color,
      selfFollowing: editor.getInstanceState().followingUserId,
      collaborators: presenceOf(editor),
      roster: entries,
      presentation: live?.store.presentation.get() ?? null,
      frames,
      currentPageId: editor.getCurrentPageId(),
      pageName: (pageId) => editor.getPage(pageId as never)?.name ?? null,
      now,
    })
    return JSON.stringify(rows)
  }, [editor, ctx, entries, frames, now, selfUserId])
  const rows = useMemo(() => JSON.parse(rowsKey) as PersonRow[], [rowsKey])
  const shown = useMemo(() => filterPeople(rows, query), [rows, query])
  const following = useValue('dr-following', () => editor.getInstanceState().followingUserId, [editor])
  const others = rows.length - 1

  const bring = async (row: PersonRow | null) => {
    const r = await storeFor(ctx).summon(row?.userId)
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
          const iFollow = !!r.followId && following === r.followId
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
              {!r.self && r.followId && r.status === 'presenting' && (
                // The presenter: follow their slides (present-live) rather than their camera.
                <div className="dr-people-row__actions">
                  <button
                    type="button"
                    className="dr-btn dr-btn--sm dr-btn--primary"
                    data-testid="people-join"
                    aria-label={`Join ${r.name}’s presentation`}
                    onClick={() => {
                      onClose(false)
                      getLive(editor)?.join()
                    }}
                  >
                    Join
                  </button>
                </div>
              )}
              {!r.self && r.followId && r.status !== 'presenting' && (
                <div className="dr-people-row__actions">
                  <button
                    type="button"
                    className="dr-btn dr-btn--sm dr-people-follow"
                    data-testid="people-follow"
                    aria-pressed={iFollow}
                    aria-label={iFollow ? `Stop following ${r.name}` : `Follow ${r.name}`}
                    onClick={() => {
                      if (iFollow) {
                        editor.stopFollowingUser()
                        return
                      }
                      editor.startFollowingUser(r.followId as never)
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
