// OWNER: 3c. Present to everyone (present-live) on the Excalidraw board page: what people see (the tldraw
// page's ../LiveUi.tsx).
// - On the board: an invitation when someone presents ("Chase is presenting · Join / Not now"), and a
//   top-bar chip to rejoin after "Not now" or "Stop following" (or, for the presenter's other tabs,
//   "Present here").
// - In the presentation (present-export's chrome): a banner at the top for the presenter ("Presenting
//   to everyone · 3 following") and for followers ("Following Chase · Stop following"), messages
//   (hand-offs, refusals), and the presenter's "Invite everyone" / "Hand over" controls in the bar.

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { CanvasFeatureContext } from '../../../../canvas/api/index.ts'
import { useUserKind } from '../../../../invite/guest.tsx'
import { initialsFor, safeColor } from '../../../../lib/identity.ts'
import { useValue } from '../../../../lib/signals.ts'
import { mayPresentAs, presenceUsers, type RosterRow, rosterMap } from '../../../people/ported/presence.ts'
import { PersonName } from '../../../workshops/Hands.tsx'
import { followingText, namesText } from '../words.ts'
import { getLive, type LiveController } from './controller.ts'
import { PRESENT_POPUP_ATTR, PRESENT_POPUP_CLOSE } from './presenter.ts'
import '../live.css'

/** The live controller of this board page (re-renders when present mode provides its presenter). */
export function useLive(ctx: CanvasFeatureContext | null): LiveController | null {
  const registries = ctx?.registries ?? null
  return useValue('dr-live', () => (registries ? getLive(registries) : null), [registries])
}

/** Keeps the controller's copy of the caller's role and guest status current (no output). */
export function LiveSync({ ctx }: { ctx: CanvasFeatureContext }) {
  const live = useLive(ctx)
  const kind = useUserKind()
  const { role } = ctx
  const { status } = ctx.board
  useEffect(() => {
    live?.role.set({ role, status })
  }, [live, role, status])
  useEffect(() => {
    live?.guest.set(kind === null ? null : kind === 'guest')
  }, [live, kind])
  return null
}

function PlayIcon({ size = 12 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <path d="M7 4.5v15l12-7.5z" fill="currentColor" />
    </svg>
  )
}

// ---- on the board: the invitation ------------------------------------------------------------------------

export function LiveInvite({ ctx }: { ctx: CanvasFeatureContext }) {
  const live = useLive(ctx)
  return live ? <LiveInviteCard live={live} /> : null
}

function LiveInviteCard({ live }: { live: LiveController }) {
  const view = useValue('dr-live-invite', () => {
    const p = live.store.presentation.get()
    if (!p || p.presenter.userId === live.me.id) return null
    if (live.presenter.role() === 'follower') return null
    const intent = live.store.intentFor(p.id)
    if (intent === 'following') return null
    return {
      id: p.id,
      name: p.presenter.name,
      userId: p.presenter.userId,
      online: p.presenterOnline,
      declined: intent === 'declined',
    }
  }, [live])
  const may = useValue('dr-live-may', () => live.mayPresent(), [live])
  const busy = useValue('dr-live-busy', () => live.busy.get(), [live])
  const color = useValue('dr-live-invite-color', () => {
    if (!view || view.declined) return null
    const c = live.ctx.canvas.collaborators().find((x) => x.uid === view.userId)
    return c?.color ?? null
  }, [live, view?.userId, view?.declined])
  if (!view) return null
  if (view.declined) {
    // Phones only (CSS): the top bar has no room for the Rejoin chip there, so it floats on the board.
    return (
      <button
        type="button"
        className="dr-live-rejoin"
        data-testid="live-rejoin-floating"
        aria-label={`${view.name} is presenting. Rejoin the presentation`}
        onClick={() => live.join()}
      >
        <span className="dr-live-chip__dot" aria-hidden="true" />
        <span className="dr-live-rejoin__label">
          <PersonName name={view.name} /> is presenting
        </span>
        <strong>Rejoin</strong>
      </button>
    )
  }
  return (
    <section
      className="dr-live-invite"
      aria-label="Presentation"
      data-testid="live-invite"
      data-online={view.online ? 'true' : 'false'}
    >
      <span
        className="dr-live-invite__avatar"
        style={{ background: safeColor(color, view.userId) }}
        aria-hidden="true"
      >
        {initialsFor(view.name)}
      </span>
      <p className="dr-live-invite__text" aria-live="polite">
        {view.online ? (
          <>
            <span className="dr-live-invite__title">
              <PersonName name={view.name} className="dr-live-invite__name" /> is presenting
            </span>
            <span className="dr-live-invite__sub">Join to follow their slides as they present.</span>
          </>
        ) : (
          <>
            <span className="dr-live-invite__title">
              <PersonName name={view.name} className="dr-live-invite__name" /> lost the connection
            </span>
            <span className="dr-live-invite__sub">
              {may
                ? 'Wait for them to come back, or take over the presentation.'
                : 'Waiting for them to come back…'}
            </span>
          </>
        )}
      </p>
      <div className="dr-live-invite__actions">
        {view.online ? (
          <button
            type="button"
            className="dr-btn dr-btn--primary dr-btn--sm"
            data-testid="live-join"
            onClick={() => live.join()}
          >
            <PlayIcon /> Join
          </button>
        ) : (
          may && (
            <button
              type="button"
              className="dr-btn dr-btn--primary dr-btn--sm"
              data-testid="live-take-over"
              disabled={busy}
              onClick={() => void live.takeOver()}
            >
              Take over
            </button>
          )
        )}
        <button
          type="button"
          className="dr-btn dr-btn--sm"
          data-testid="live-not-now"
          onClick={() => live.notNow()}
        >
          Not now
        </button>
      </div>
    </section>
  )
}

// ---- the top-bar chip ------------------------------------------------------------------------------------

export function LiveChip({ ctx }: { ctx: CanvasFeatureContext | null }) {
  const live = useLive(ctx)
  return live ? <LiveChipButton live={live} /> : null
}

function LiveChipButton({ live }: { live: LiveController }) {
  const view = useValue('dr-live-chip', () => {
    const p = live.store.presentation.get()
    if (!p) return null
    if (p.presenter.userId === live.me.id) {
      if (p.tab && p.tab !== live.tab && !live.presentingLive.get())
        return { kind: 'other-tab' as const, name: '' }
      return null
    }
    if (live.presenter.role() === 'follower') return null
    // Before a choice the invitation on the board asks; after "Not now" / "Stop following" this rejoins.
    if (live.store.intentFor(p.id) !== 'declined') return null
    return { kind: 'rejoin' as const, name: p.presenter.name }
  }, [live])
  const busy = useValue('dr-live-busy', () => live.busy.get(), [live])
  if (!view) return null
  if (view.kind === 'other-tab') {
    return (
      <button
        type="button"
        className="dr-live-chip"
        data-testid="live-chip"
        data-state="other-tab"
        disabled={busy}
        title="You are presenting to everyone from another tab. Present from this tab instead."
        onClick={() => void live.presentHere()}
      >
        <span className="dr-live-chip__dot" aria-hidden="true" />
        <span className="dr-live-chip__label">Presenting in another tab</span>
        <strong>Present here</strong>
      </button>
    )
  }
  return (
    <button
      type="button"
      className="dr-live-chip"
      data-testid="live-chip"
      data-state="rejoin"
      title={`${view.name} is presenting. Follow their slides again.`}
      aria-label={`${view.name} is presenting. Rejoin the presentation`}
      onClick={() => live.join()}
    >
      <span className="dr-live-chip__dot" aria-hidden="true" />
      <span className="dr-live-chip__label">
        <PersonName name={view.name} /> is presenting
      </span>
      <strong>Rejoin</strong>
    </button>
  )
}

// ---- in the presentation ----------------------------------------------------------------------------------

/** The banner at the top of a presentation: presenting to everyone, following someone, messages. */
export function LiveTop({ ctx }: { ctx: CanvasFeatureContext }) {
  const live = useLive(ctx)
  return live ? <LiveTopBanner live={live} /> : null
}

type TopView =
  | { kind: 'presenting'; count: number; names: string[] }
  | { kind: 'following' | 'waiting' | 'reconnecting'; name: string }

function LiveTopBanner({ live }: { live: LiveController }) {
  const view = useValue<TopView | null>('dr-live-top', () => {
    const st = live.presenter.state.get()
    if (!st) return null
    const p = live.store.presentation.get()
    if (st.role === 'follower') {
      const name = st.leader?.name ?? p?.presenter.name ?? 'the presenter'
      if (!p) return live.store.restartLost.get() ? { kind: 'reconnecting', name } : null
      return { kind: p.presenterOnline ? 'following' : 'waiting', name }
    }
    if (!live.presentingLive.get() || !p) return null
    return { kind: 'presenting', count: p.followerCount, names: p.followers.map((f) => f.name) }
  }, [live])
  const flash = useValue('dr-live-flash', () => live.flash.get(), [live])
  const may = useValue('dr-live-may', () => live.mayPresent(), [live])
  const busy = useValue('dr-live-busy', () => live.busy.get(), [live])
  if (!view && !flash) return null
  return (
    <div className="dr-live-top" data-testid="live-top">
      {view?.kind === 'presenting' && (
        <div
          className="dr-live-pill"
          data-testid="live-presenting"
          data-count={view.count}
          title={view.count ? `Following: ${namesText(view.names, view.count, 8)}` : undefined}
        >
          <span className="dr-live-pill__dot" aria-hidden="true" />
          <span>Presenting to everyone</span>
          <span className="dr-live-pill__sep" aria-hidden="true">
            ·
          </span>
          <span data-testid="live-follower-count" aria-live="polite">
            {followingText(view.count)}
          </span>
        </div>
      )}
      {view && view.kind !== 'presenting' && (
        <div className="dr-live-pill" data-testid="live-following" data-state={view.kind}>
          <span className="dr-live-pill__dot" data-state={view.kind} aria-hidden="true" />
          <span className="dr-live-pill__text" aria-live="polite">
            {view.kind === 'following' && (
              <>
                Following <PersonName name={view.name} className="dr-live-pill__name" />
              </>
            )}
            {view.kind === 'waiting' && (
              <>
                Waiting for <PersonName name={view.name} className="dr-live-pill__name" /> to reconnect…
              </>
            )}
            {view.kind === 'reconnecting' && 'Reconnecting to the presentation…'}
          </span>
          {view.kind === 'waiting' && may && (
            <button
              type="button"
              className="dr-live-pill__btn"
              data-testid="live-take-over"
              disabled={busy}
              onClick={() => void live.takeOver()}
            >
              Take over
            </button>
          )}
          <button
            type="button"
            className="dr-live-pill__btn"
            data-testid="live-stop-following"
            aria-keyshortcuts="Escape"
            onClick={() => live.stepOut()}
          >
            Stop following
          </button>
        </div>
      )}
      {flash && (
        <div className="dr-live-flash" role="status" data-testid="live-flash" key={flash.seq}>
          {flash.text}
          {flash.action === 'take-over' && may && (
            <button
              type="button"
              className="dr-live-pill__btn"
              disabled={busy}
              onClick={() => void live.inviteEveryone({ takeOver: true })}
            >
              Take over
            </button>
          )}
        </div>
      )}
    </div>
  )
}

/** The presenter's controls in the presentation bar: "Invite everyone", then "Hand over". */
export function LiveBarControls({ ctx }: { ctx: CanvasFeatureContext }) {
  const live = useLive(ctx)
  return live ? <LiveBarButtons live={live} /> : null
}

function LiveBarButtons({ live }: { live: LiveController }) {
  const presenting = useValue('dr-live-presenting', () => live.presentingLive.get(), [live])
  const presenter = useValue('dr-live-role', () => live.presenter.role() === 'presenter', [live])
  const may = useValue('dr-live-may', () => live.mayPresent(), [live])
  const busy = useValue('dr-live-busy', () => live.busy.get(), [live])
  if (!presenter) return null
  if (!presenting) {
    if (!may) return null
    return (
      <button
        type="button"
        className="dr-present__btn dr-present__btn--text dr-present__btn--invite"
        data-testid="present-invite"
        title="Everyone on the board is asked to join and follow your slides"
        disabled={busy}
        onClick={() => void live.inviteEveryone()}
      >
        Invite everyone
      </button>
    )
  }
  return <HandOffButton live={live} />
}

function HandOffButton({ live }: { live: LiveController }) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const listId = useId()
  const canvas = live.ctx.canvas
  // roles and "(guest)" come with the roster (the server's sessions): nothing to load
  // serialized: the roster's identity changes on every presence frame, its content rarely
  const entriesKey = useValue(
    'dr-live-roster',
    () => JSON.stringify([...rosterMap(canvas.collaborators())]),
    [canvas],
  )
  const entries = useMemo(() => new Map(JSON.parse(entriesKey) as [string, RosterRow][]), [entriesKey])
  const followers = useValue(
    'dr-live-followers',
    () => new Set(live.store.presentation.get()?.followers.map((f) => f.userId) ?? []),
    [live],
  )
  // Serialized so cursor movement (presence changes every frame) does not re-render the list.
  const peopleKey = useValue(
    'dr-live-handoff-people',
    () => (open ? JSON.stringify(presenceUsers(canvas.collaborators(), [], live.me.id)) : '[]'),
    [canvas, live, open],
  )
  const people = useMemo(() => JSON.parse(peopleKey) as ReturnType<typeof presenceUsers>, [peopleKey])
  const candidates = useMemo(
    () =>
      people
        .filter((u) => mayPresentAs(entries?.get(u.userId)))
        .sort((a, b) => Number(followers.has(b.userId)) - Number(followers.has(a.userId))),
    [people, entries, followers],
  )

  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [open])

  useEffect(() => {
    if (open) wrap.current?.querySelector<HTMLElement>('[data-handoff-option]')?.focus()
  }, [open, candidates.length])

  // The presentation owns the keyboard: its Esc closes this menu (present-session.ts) instead of
  // ending the presentation for everyone.
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const list = listRef.current
    if (!open || !list) return
    const close = () => {
      setOpen(false)
      button.current?.focus()
    }
    list.addEventListener(PRESENT_POPUP_CLOSE, close)
    return () => list.removeEventListener(PRESENT_POPUP_CLOSE, close)
  }, [open])

  return (
    <div className="dr-live-handoff" ref={wrap}>
      <button
        ref={button}
        type="button"
        className="dr-present__btn dr-present__btn--text"
        data-testid="present-handoff"
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        Hand over
      </button>
      {open && (
        <div
          ref={listRef}
          id={listId}
          className="dr-live-handoff__list"
          data-testid="handoff-list"
          {...{ [PRESENT_POPUP_ATTR]: '' }}
        >
          <p className="dr-live-handoff__title" id={`${listId}-title`}>
            Hand the presentation to
          </p>
          {entries === null ? (
            <p className="dr-live-handoff__empty">Loading who can present…</p>
          ) : candidates.length === 0 ? (
            <p className="dr-live-handoff__empty" data-testid="handoff-empty">
              No one else here can present. People who can edit this board and have an account can.
            </p>
          ) : (
            <ul aria-labelledby={`${listId}-title`}>
              {candidates.map((u) => (
                <li key={u.userId}>
                  <button
                    type="button"
                    data-handoff-option={u.userId}
                    data-testid="handoff-option"
                    data-user-id={u.userId}
                    onClick={() => {
                      setOpen(false)
                      void live.handOff(u.userId)
                    }}
                  >
                    <span
                      className="dr-live-handoff__avatar"
                      style={{ background: u.color }}
                      aria-hidden="true"
                    >
                      {initialsFor(u.name)}
                    </span>
                    <PersonName name={u.name} className="dr-live-handoff__name" />
                    {followers.has(u.userId) && <span className="dr-live-handoff__tag">following</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
