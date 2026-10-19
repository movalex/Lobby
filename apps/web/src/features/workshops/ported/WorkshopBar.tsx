// OWNER: 3f. The workshops feature's top-bar item on the Excalidraw page (the tldraw board's WorkshopBar).
// K3-3 (wave K, UXD-01): ONE button, "Facilitate" ("Session" for people who cannot facilitate), instead of the
// timer pill, the vote chip, the brainstorm chip, the raised-hands chip and the reactions button side by side.
// Its pill shows only what is live ("4:58 · Vote"); its menu holds the same entries with the same test ids:
// Timer (`timer-pill`: the workshop tools popover with the timer controls, the raise-hand queue, voting, the
// private brainstorm, gather everyone and the session settings), Reactions and raise hand
// (`reactions-button`: the reactions bar), Raised hands (`hands-chip`), Voting (`vote-chip`: the voting
// panel, or a new vote's setup for a facilitator) and Private brainstorm (`pn-chip`). Who sees which entry is
// ./guest-chrome.ts `facilitateEntries`: the rules each control had in the bar. Controls are hidden for
// people who cannot facilitate; the API refuses them anyway. Wave V: entries and pill parts other features register
// (./facilitate-entries.ts) come after the built-ins; nobody edits this file to add one.
import { Fragment, type KeyboardEvent, useEffect, useId, useRef, useState } from 'react'
import type { CanvasFeatureContext } from '../../../canvas/api/index.ts'
import { useIsGuest } from '../../../invite/guest.tsx'
import { useValue } from '../../../lib/signals.ts'
import { onFocusLeave } from '../../../ui/focus.ts'
import { installAudioUnlock, playChime, readMuted, writeMuted } from '../chime.ts'
import {
  crossedZero,
  describeClock,
  formatClock,
  parseDurationInput,
  type TimerDisplay,
  type TimerPhase,
  timerDisplayPhase,
  timerPhase,
  timerRemainingMs,
} from '../countdown.ts'
import { HandIcon, HandsEntry, HandsSection, handsLabel } from '../Hands.tsx'
import { usePrivateNotes } from '../private-notes/hooks.ts'
import type { WorkshopSnapshot, WorkshopStore } from '../store.ts'
import { canEditBoard, useIsFacilitator, useNow, useWorkshop } from '../workshop-context.ts'
import { summonScreen } from './camera.ts'
import { type FacilitateEntrySpec, facilitateExtras, useFacilitatePill } from './facilitate-entries.ts'
import {
  type FacilitateEntry,
  facilitateEntries,
  facilitatePill,
  type PillPart,
  pillText,
  workshopActivity,
} from './guest-chrome.ts'
import {
  PrivateNotesEntry,
  PrivateNotesSection,
  PrivateNotesSetup,
} from './private-notes/PrivateNotesBar.tsx'
import { ReactionBar, SmileIcon } from './Reactions.tsx'
import { endSpotlight, mayEndSpotlight, SpotlightIcon, spotlightIds } from './SpotlightLayer.tsx'
import { workshopSettingsOf, writeWorkshopSettings } from './session-settings.ts'
import { VoteSetupDialog } from './VoteSetupDialog.tsx'

type Ctx = CanvasFeatureContext

const PRESETS_MIN = [1, 3, 5, 10, 15]
const MIN = 60_000

export function StopwatchIcon({ size = 14 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <circle cx="12" cy="13.5" r="7.5" fill="none" stroke="currentColor" strokeWidth="2" />
      <path
        d="M12 13.5V9.5M9.5 2.5h5M18.5 6.5l1.5-1.5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  )
}

/** The Facilitate button's mark: a speech bubble with a spark (live tools for a session). */
function FacilitateIcon() {
  return (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">
      <path
        d="M4 5.5h10.5a2 2 0 0 1 2 2V13a2 2 0 0 1-2 2H9l-4 3.5V15H4a2 2 0 0 1-2-2V7.5a2 2 0 0 1 2-2z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinejoin="round"
      />
      <path d="M19.5 2.5l.8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8z" fill="currentColor" />
    </svg>
  )
}

function VoteIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <circle cx="8" cy="9" r="3" fill="currentColor" />
      <circle cx="16" cy="9" r="3" fill="currentColor" opacity="0.55" />
      <circle cx="12" cy="16" r="3" fill="currentColor" opacity="0.8" />
    </svg>
  )
}

/** What is open under the Facilitate button: its menu, the workshop tools or the reactions bar. */
type Open = 'menu' | 'tools' | 'reactions' | null

/** The Timer entry's state on the right ("4:58 left", "Paused · 4:58", "Not set"). */
export function timerMeta(display: TimerDisplay, remaining: number): string {
  switch (display) {
    case 'running':
      return `${formatClock(remaining)} left`
    case 'paused':
      return `Paused · ${formatClock(remaining)}`
    case 'finished':
      return "Time's up"
    case 'stopped':
      return 'Stopped'
    case 'ended':
      return 'Finished'
    default:
      return 'Not set'
  }
}

/** The Voting entry's state on the right ("3 left", "Join", "Results", "Start…"). */
export function voteMeta(
  snap: Pick<WorkshopSnapshot, 'vote' | 'participation' | 'ballot'>,
  facilitator: boolean,
) {
  const vote = snap.vote
  if (!vote) return facilitator ? 'Start…' : ''
  if (vote.session.status === 'open') {
    if (snap.participation !== 'joined') return 'Join'
    return `${snap.ballot?.myRemaining ?? vote.myRemaining} left`
  }
  return vote.session.status === 'revealed' ? 'Results' : 'Ended'
}

/** The pill's words for screen readers ("timer 4 minutes 58 seconds left, a vote is open"). */
function spokenPill(parts: readonly PillPart[], remaining: number, snap: WorkshopSnapshot): string {
  return parts
    .map((p) => {
      if (p.kind === 'timer')
        return p.state === 'finished'
          ? "time's up"
          : `timer ${describeClock(remaining)} left${p.state === 'paused' ? ', paused' : ''}`
      if (p.kind === 'vote') return 'a vote is open'
      if (p.kind === 'brainstorm') return 'a private brainstorm is open'
      if (p.kind === 'extra') return p.spoken
      return handsLabel(snap)
    })
    .join(', ')
}

export function WorkshopBar({ ctx }: { ctx: Ctx }) {
  const { store, snap } = useWorkshop(ctx)
  const facilitator = useIsFacilitator(ctx)
  const guest = useIsGuest()
  const brainstorm = usePrivateNotes(ctx).snap.session
  const selectedCount = useValue('dr-wk-bar-selected', () => ctx.canvas.selection.length, [ctx.canvas])
  const sessionSettings = useValue('dr-wk-bar-settings', () => workshopSettingsOf(ctx.canvas), [ctx.canvas])
  // wave V: the registered entries' live pill parts (./facilitate-entries.ts)
  const pillExtras = useFacilitatePill(ctx.canvas)
  const [open, setOpen] = useState<Open>(null)
  /** Which section the tools popover should bring into view and focus when it opens (null = the first). */
  const [focusSection, setFocusSection] = useState<'hands' | null>(null)
  const [muted, setMuted] = useState(readMuted)
  const wrap = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const menuId = useId()
  const popId = useId()
  const barId = useId()

  // "Show queue" (a toast) and the hands entry open the tools at the raised-hands queue.
  const requestSeq = snap.toolsRequest?.seq
  const requestSection = snap.toolsRequest?.section ?? null
  const handledRequest = useRef(requestSeq)
  useEffect(() => {
    if (requestSeq === undefined || requestSeq === handledRequest.current) return
    handledRequest.current = requestSeq
    setFocusSection(requestSection)
    setOpen('tools')
  }, [requestSeq, requestSection])

  const offset = store.serverOffsetMs()
  // Ticks while running, and through a finished timer's alert (so the pill calms down on time).
  const ticking =
    snap.timer?.status === 'running' || timerDisplayPhase(snap.timer, Date.now(), offset) === 'finished'
  const now = useNow(ticking)
  const remaining = timerRemainingMs(snap.timer, now, offset)
  const phase = timerPhase(snap.timer, now, offset)
  const display = timerDisplayPhase(snap.timer, now, offset)

  useEffect(() => installAudioUnlock(), [])

  // The end signal: only when this tab saw it running with time left (not for boards opened later).
  const prev = useRef<{ phase: TimerPhase; endsAt: string | null } | null>(null)
  const mutedRef = useRef(muted)
  mutedRef.current = muted
  useEffect(() => {
    const endsAt = snap.timer?.endsAt ?? null
    // One message: the canvas flash says "Time's up" (and announces it); no toast on top of it.
    if (crossedZero(prev.current, phase) && prev.current?.endsAt === endsAt) {
      store.raiseTimerAlert()
      playChime({ muted: mutedRef.current })
    }
    prev.current = { phase, endsAt }
  }, [phase, snap.timer?.endsAt, store])

  // Close on an outside press and on Escape (on the document: the focused control can disappear under the
  // user, Resume turning into Pause, which drops focus to <body>); the menu and the reactions bar also when
  // the keyboard leaves them (A11Y2-05: Tab past the bar, or a dialog taking the keyboard).
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(null)
    }
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const inside = wrap.current?.contains(document.activeElement)
      if (!inside && document.activeElement !== document.body) return // someone else's Escape
      e.stopPropagation()
      setOpen(null)
      button.current?.focus()
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    // The menu stays when the board page hands the canvas the keyboard (it does on its own after a load); a
    // Tab out of it, or a press anywhere else, closes it.
    const keep = open === 'menu' ? (el: Element) => !!el.closest('[data-lobby-board-canvas]') : undefined
    const off =
      open !== 'tools' && wrap.current ? onFocusLeave(wrap.current, () => setOpen(null), keep) : () => {}
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
      off()
    }
  }, [open])

  const vote = snap.vote
  const activity = workshopActivity({
    timer: snap.timer,
    vote: vote !== null,
    brainstorm: brainstorm !== null,
    hands: snap.hands.length,
    settings: sessionSettings,
    now,
    offsetMs: offset,
  })
  const entries = facilitateEntries({
    guest,
    facilitator,
    activity,
    vote: vote !== null,
    // L5-2: offered when there is something to spotlight (a selection) or to end; an idle menu is as it was
    spotlight: facilitator && (selectedCount > 0 || !!snap.spotlight),
  })
  const parts = facilitatePill({
    timer: display,
    clock: formatClock(remaining),
    voteOpen: vote?.session.status === 'open',
    brainstormOpen: brainstorm?.status === 'open',
    hands: snap.hands.length,
    extras: pillExtras,
  })
  // wave V: the registered entries the menu shows now, after the built-ins (./facilitate-entries.ts)
  const extras = facilitateExtras({ ctx, guest, facilitator })
  const title = facilitator ? 'Facilitate' : 'Session'
  const spoken = spokenPill(parts, remaining, snap)
  const label = spoken ? `${title}: ${spoken}` : title
  const controls =
    open === 'menu' ? menuId : open === 'tools' ? popId : open === 'reactions' ? barId : undefined

  const show = (what: Open, section: 'hands' | null = null) => {
    setFocusSection(section)
    setOpen(what)
  }

  return (
    <div className="dr-wk-bar" ref={wrap}>
      <button
        ref={button}
        type="button"
        className="dr-wk-facilitate"
        data-testid="facilitate-button"
        data-timer-state={display}
        data-live={parts.length > 0 ? 'true' : 'false'}
        aria-haspopup="menu"
        aria-expanded={open !== null}
        aria-controls={controls}
        aria-label={label}
        title={parts.length ? `${title}: ${pillText(parts)}` : title}
        onClick={() => setOpen((o) => (o === null ? 'menu' : null))}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && open !== 'menu') {
            e.preventDefault()
            setOpen('menu')
          }
        }}
      >
        <FacilitateIcon />
        <span className="dr-wk-facilitate__label">{title}</span>
        {parts.length > 0 && (
          <span className="dr-wk-facilitate__pill" data-testid="facilitate-pill">
            {parts.map((p, i) => (
              <Fragment key={p.kind === 'extra' ? `extra-${p.id}` : p.kind}>
                {i > 0 && (
                  <span className="dr-wk-facilitate__sep" aria-hidden="true">
                    ·
                  </span>
                )}
                <span
                  className={`dr-wk-facilitate__part dr-wk-facilitate__part--${p.kind}`}
                  data-testid={
                    p.kind === 'timer'
                      ? 'timer-remaining'
                      : p.kind === 'extra'
                        ? `facilitate-pill-${p.id}`
                        : `facilitate-pill-${p.kind}`
                  }
                  data-state={p.kind === 'timer' ? p.state : undefined}
                  data-count={p.kind === 'hands' ? p.count : undefined}
                  data-mine={p.kind === 'hands' ? (snap.myHand ? 'true' : 'false') : undefined}
                >
                  {p.text}
                </span>
              </Fragment>
            ))}
          </span>
        )}
      </button>
      {open === 'menu' && (
        <FacilitateMenu
          id={menuId}
          ctx={ctx}
          store={store}
          snap={snap}
          entries={entries}
          extras={extras}
          guest={guest}
          facilitator={facilitator}
          timer={{ display, remaining }}
          onShow={show}
          onClose={(refocus) => {
            setOpen(null)
            if (refocus) button.current?.focus()
          }}
        />
      )}
      {open === 'tools' && (
        <WorkshopPopover
          id={popId}
          ctx={ctx}
          store={store}
          focusSection={focusSection}
          facilitator={facilitator}
          phase={phase}
          remaining={remaining}
          muted={muted}
          onMuted={(m) => {
            setMuted(m)
            writeMuted(m)
          }}
          onClose={(refocus) => {
            setOpen(null)
            if (refocus) button.current?.focus()
          }}
        />
      )}
      {open === 'reactions' && <ReactionBar id={barId} ctx={ctx} store={store} snap={snap} />}
      <PrivateNotesSetup ctx={ctx} />
      {snap.setupOpen && (
        <VoteSetupDialog
          ctx={ctx}
          store={store}
          prefill={snap.setupPrefill}
          onClose={() => store.setSetupOpen(false)}
        />
      )}
    </div>
  )
}

/**
 * The Facilitate menu (role menu): ↑/↓ (and Home/End) move between the entries, Enter or a click opens one,
 * Escape gives the keyboard back to the button. Each entry keeps the test id of the control it replaces.
 */
export function FacilitateMenu({
  id,
  ctx,
  store,
  snap,
  entries,
  extras = [],
  guest = false,
  facilitator,
  timer,
  onShow,
  onClose,
}: {
  id: string
  ctx: Ctx
  store: WorkshopStore
  snap: WorkshopSnapshot
  entries: readonly FacilitateEntry[]
  /** wave V: the registered entries to show after the built-ins (./facilitate-entries.ts facilitateExtras) */
  extras?: readonly FacilitateEntrySpec[]
  guest?: boolean
  facilitator: boolean
  timer: { display: TimerDisplay; remaining: number }
  onShow(what: Open, section?: 'hands' | null): void
  onClose(refocus: boolean): void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
  }, [])
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' || e.key === 'Tab') return // the bar's document handlers
    e.stopPropagation() // no board shortcuts from inside the menu
    const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
    const at = items.indexOf(document.activeElement as HTMLElement)
    const go = (i: number) => {
      e.preventDefault()
      items[(i + items.length) % items.length]?.focus()
    }
    if (e.key === 'ArrowDown') go(at + 1)
    else if (e.key === 'ArrowUp') go(at - 1)
    else if (e.key === 'Home') go(0)
    else if (e.key === 'End') go(items.length - 1)
  }
  const raised = !!snap.myHand
  const vote = snap.vote
  return (
    <div
      id={id}
      ref={ref}
      role="menu"
      aria-label={facilitator ? 'Facilitate' : 'Session'}
      className="dr-wk-menu"
      data-testid="facilitate-menu"
      onKeyDown={onKeyDown}
    >
      {entries.map((entry) => {
        switch (entry) {
          case 'timer':
            return (
              <button
                key={entry}
                type="button"
                role="menuitem"
                className="dr-wk-menu__item"
                data-testid="timer-pill"
                data-state={timer.display}
                onClick={() => onShow('tools')}
              >
                <span className="dr-wk-menu__icon" aria-hidden="true">
                  <StopwatchIcon size={16} />
                </span>
                <span className="dr-wk-menu__label">Timer</span>
                <span className="dr-wk-menu__meta" data-state={timer.display}>
                  {timerMeta(timer.display, timer.remaining)}
                </span>
              </button>
            )
          case 'reactions':
            return (
              <button
                key={entry}
                type="button"
                role="menuitem"
                className="dr-wk-menu__item"
                data-testid="reactions-button"
                data-hand={raised ? 'up' : 'down'}
                aria-label={raised ? 'Reactions. Your hand is raised' : 'Reactions and raise hand'}
                onClick={() => onShow('reactions')}
              >
                <span className="dr-wk-menu__icon" aria-hidden="true">
                  {raised ? <HandIcon size={16} /> : <SmileIcon />}
                </span>
                <span className="dr-wk-menu__label">Reactions and raise hand</span>
                {raised && <span className="dr-wk-menu__meta dr-wk-menu__meta--hands">Hand up</span>}
              </button>
            )
          case 'hands':
            return <HandsEntry key={entry} snap={snap} onOpen={() => onShow('tools', 'hands')} />
          case 'voting':
            return (
              <button
                key={entry}
                type="button"
                role="menuitem"
                className="dr-wk-menu__item"
                data-testid="vote-chip"
                data-status={vote?.session.status ?? 'none'}
                onClick={() => {
                  onClose(false)
                  // a facilitator with no vote yet goes straight to a new vote's setup
                  if (!vote && facilitator) store.setSetupOpen(true)
                  else ctx.openPanel('voting')
                }}
              >
                <span className="dr-wk-menu__icon" aria-hidden="true">
                  <VoteIcon />
                </span>
                <span className="dr-wk-menu__label">Voting</span>
                <span className="dr-wk-menu__meta">{voteMeta(snap, facilitator)}</span>
              </button>
            )
          case 'brainstorm':
            return <PrivateNotesEntry key={entry} ctx={ctx} onDone={() => onClose(false)} />
          case 'spotlight':
            return <SpotlightEntry key={entry} ctx={ctx} snap={snap} onDone={() => onClose(false)} />
          default:
            return null
        }
      })}
      {extras.map((e) => (
        <e.Item key={e.id} ctx={ctx} guest={guest} facilitator={facilitator} close={onClose} />
      ))}
    </div>
  )
}

/**
 * L5-2: the Facilitate menu's Spotlight entries: "Spotlight for everyone" dims the board for everyone around what
 * is selected (it replaces a spotlight that is on), and, while one is on that this person may end, "End the
 * spotlight". The selection is read live (it is the board's, not the menu's).
 */
function SpotlightEntry({ ctx, snap, onDone }: { ctx: Ctx; snap: WorkshopSnapshot; onDone(): void }) {
  const selected = useValue('dr-wk-spot-entry-sel', () => ctx.canvas.selection.length, [ctx.canvas])
  const on = snap.spotlight
  const ending = !!on && mayEndSpotlight(ctx, on)
  const back = () => ctx.canvas.focus({ preventScroll: true })
  return (
    <>
      <button
        type="button"
        role="menuitem"
        className="dr-wk-menu__item"
        data-testid="spotlight-menu"
        aria-disabled={selected === 0 ? true : undefined}
        onClick={() => {
          onDone()
          void spotlightIds(ctx, ctx.canvas.selection)
          back()
        }}
      >
        <span className="dr-wk-menu__icon" aria-hidden="true">
          <SpotlightIcon size={16} />
        </span>
        <span className="dr-wk-menu__label">Spotlight for everyone</span>
        <span className="dr-wk-menu__meta">
          {selected > 0 ? `${selected} selected` : 'Select items first'}
        </span>
      </button>
      {ending && (
        <button
          type="button"
          role="menuitem"
          className="dr-wk-menu__item"
          data-testid="spotlight-menu-end"
          onClick={() => {
            onDone()
            void endSpotlight(ctx)
            back()
          }}
        >
          <span className="dr-wk-menu__icon" aria-hidden="true">
            <SpotlightIcon size={16} />
          </span>
          <span className="dr-wk-menu__label">End the spotlight</span>
          <span className="dr-wk-menu__meta">On</span>
        </button>
      )}
    </>
  )
}

function WorkshopPopover({
  id,
  ctx,
  store,
  focusSection,
  facilitator,
  phase,
  remaining,
  muted,
  onMuted,
  onClose,
}: {
  id: string
  ctx: Ctx
  store: WorkshopStore
  focusSection: 'hands' | null
  facilitator: boolean
  phase: TimerPhase
  remaining: number
  muted: boolean
  onMuted(m: boolean): void
  onClose(refocus: boolean): void
}) {
  const snap = store.getSnapshot()
  const [duration, setDuration] = useState(() => formatClock(snap.timer?.durationMs || 5 * MIN))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const handsRef = useRef<HTMLElement>(null)
  const durationId = useId()
  const parsed = parseDurationInput(duration)

  useEffect(() => {
    const hands = focusSection === 'hands' ? handsRef.current : null
    if (hands) {
      hands.scrollIntoView({ block: 'nearest' })
      ;(hands.querySelector<HTMLElement>('button') ?? hands).focus()
      return
    }
    ref.current?.querySelector<HTMLElement>('button, input')?.focus()
  }, [focusSection])

  const act = async (fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(true)
    setError(null)
    const r = await fn()
    setBusy(false)
    if (!r.ok) setError(r.error ?? 'That did not work.')
    return r.ok
  }
  const timer = (action: Parameters<WorkshopStore['timerAction']>[0]) => act(() => store.timerAction(action))
  const step = (deltaMin: number) => {
    const base = parsed ?? 5 * MIN
    const next = Math.min(24 * 60 * MIN, Math.max(MIN, Math.round((base + deltaMin * MIN) / MIN) * MIN))
    setDuration(formatClock(next))
  }
  const vote = snap.vote
  const voteOpen = vote?.session.status === 'open'
  const canStart = phase === 'idle' || phase === 'stopped' || phase === 'finished'
  // Someone else's running or paused timer is theirs (final review R3): only they and the board owner
  // may pause, stop or change it (the API enforces it), so nobody silently pauses the facilitator.
  const startedBy = snap.timer?.startedBy ?? null
  const heldBy =
    (phase === 'running' || phase === 'paused') &&
    startedBy &&
    startedBy !== ctx.me.user.id &&
    ctx.role !== 'owner'
      ? startedBy
      : null
  const holderName = useValue(
    'dr-wk-timer-holder',
    () => (heldBy ? (ctx.canvas.collaborators().find((c) => c.uid === heldBy)?.name ?? null) : null),
    [ctx.canvas, heldBy],
  )

  return (
    <div
      id={id}
      ref={ref}
      role="dialog"
      aria-label="Workshop tools"
      className="dr-wk-pop"
      data-testid="workshop-popover"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onClose(true)
        }
      }}
    >
      <section className="dr-wk-pop__section" aria-label="Timer">
        <div className="dr-wk-pop__head">
          <h3>Timer</h3>
          <span className="dr-wk-pop__clock" data-state={phase}>
            {phase === 'idle' ? 'Not set' : phase === 'finished' ? "Time's up" : formatClock(remaining)}
            {phase === 'paused' && <span className="dr-muted"> · paused</span>}
          </span>
        </div>
        {facilitator && heldBy ? (
          <p className="dr-wk-hint" data-testid="timer-held-hint">
            {holderName ?? 'Someone else'} is running this timer. Only they or the board owner can pause, stop
            or change it.
          </p>
        ) : facilitator ? (
          <>
            {canStart && (
              <>
                <fieldset className="dr-wk-presets">
                  <legend className="dr-sr-only">Preset durations</legend>
                  {PRESETS_MIN.map((m) => (
                    <button
                      key={m}
                      type="button"
                      className="dr-wk-preset"
                      aria-pressed={parsed === m * MIN}
                      data-testid={`timer-preset-${m}`}
                      onClick={() => setDuration(formatClock(m * MIN))}
                    >
                      {m} min
                    </button>
                  ))}
                </fieldset>
                <div className="dr-wk-duration">
                  <label htmlFor={durationId}>Duration</label>
                  <button
                    type="button"
                    className="dr-iconbtn dr-wk-step"
                    aria-label="One minute less"
                    onClick={() => step(-1)}
                  >
                    −
                  </button>
                  <input
                    id={durationId}
                    className="dr-input dr-wk-duration__input"
                    data-testid="timer-duration"
                    value={duration}
                    inputMode="numeric"
                    aria-invalid={parsed === null}
                    aria-describedby={`${durationId}-hint`}
                    onChange={(e) => setDuration(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && parsed) void timer({ action: 'start', durationMs: parsed })
                    }}
                  />
                  <button
                    type="button"
                    className="dr-iconbtn dr-wk-step"
                    aria-label="One minute more"
                    onClick={() => step(1)}
                  >
                    +
                  </button>
                </div>
                <p id={`${durationId}-hint`} className="dr-wk-hint">
                  Minutes, or m:ss (for example 2:30).
                </p>
                <button
                  type="button"
                  className="dr-btn dr-btn--primary dr-btn--sm dr-wk-wide"
                  data-testid="timer-start"
                  disabled={!parsed || busy}
                  onClick={() => parsed && void timer({ action: 'start', durationMs: parsed })}
                >
                  Start {parsed ? formatClock(parsed) : ''}
                </button>
              </>
            )}
            {!canStart || phase === 'finished' ? (
              <fieldset className="dr-wk-row">
                <legend className="dr-sr-only">Timer controls</legend>
                {phase === 'running' && (
                  <button
                    type="button"
                    className="dr-btn dr-btn--sm"
                    data-testid="timer-pause"
                    disabled={busy}
                    onClick={() => void timer({ action: 'pause' })}
                  >
                    Pause
                  </button>
                )}
                {phase === 'paused' && (
                  <button
                    type="button"
                    className="dr-btn dr-btn--sm"
                    data-testid="timer-resume"
                    disabled={busy}
                    onClick={() => void timer({ action: 'resume' })}
                  >
                    Resume
                  </button>
                )}
                <button
                  type="button"
                  className="dr-btn dr-btn--sm"
                  data-testid="timer-add-1m"
                  disabled={busy}
                  onClick={() => void timer({ action: 'add', addMs: MIN })}
                >
                  +1 min
                </button>
                <button
                  type="button"
                  className="dr-btn dr-btn--sm"
                  data-testid="timer-add-5m"
                  disabled={busy}
                  onClick={() => void timer({ action: 'add', addMs: 5 * MIN })}
                >
                  +5 min
                </button>
                <button
                  type="button"
                  className="dr-btn dr-btn--sm dr-btn--ghost"
                  data-testid="timer-stop"
                  disabled={busy}
                  onClick={() => void timer({ action: 'stop' })}
                >
                  {phase === 'finished' ? 'Reset' : 'Stop'}
                </button>
              </fieldset>
            ) : null}
          </>
        ) : (
          <p className="dr-wk-hint" data-testid="timer-participant-hint">
            {canEditBoard(ctx)
              ? 'The facilitator runs the timer, votes and brainstorms. Everyone sees the same countdown.'
              : 'Only editors and owners can set the timer. Everyone sees the same countdown.'}
          </p>
        )}
        <label className="dr-wk-check">
          <input
            type="checkbox"
            data-testid="timer-sound"
            checked={!muted}
            onChange={(e) => onMuted(!e.target.checked)}
          />
          Play a sound when time is up
        </label>
      </section>

      <HandsSection ctx={ctx} store={store} snap={snap} sectionRef={handsRef} />

      {(facilitator || vote) && (
        <section className="dr-wk-pop__section" aria-label="Voting">
          <h3>Voting</h3>
          {voteOpen || (vote && !facilitator) ? (
            <button
              type="button"
              className="dr-btn dr-btn--sm dr-wk-wide"
              data-testid="vote-open-panel"
              onClick={() => {
                onClose(false)
                ctx.openPanel('voting')
              }}
            >
              {voteOpen ? 'Open the voting panel' : 'See the last vote'}
            </button>
          ) : (
            <button
              type="button"
              className="dr-btn dr-btn--sm dr-wk-wide"
              data-testid="vote-start"
              onClick={() => {
                onClose(false)
                store.setSetupOpen(true)
              }}
            >
              Start a vote…
            </button>
          )}
        </section>
      )}

      <PrivateNotesSection ctx={ctx} onClose={() => onClose(false)} />

      {facilitator && (
        <section className="dr-wk-pop__section" aria-label="Gather everyone">
          <h3>Gather everyone</h3>
          <p className="dr-wk-hint">
            Everyone on the board follows your view until they move, zoom or click.
          </p>
          <button
            type="button"
            className="dr-btn dr-btn--sm dr-wk-wide"
            data-testid="summon-button"
            disabled={busy}
            onClick={async () => {
              if (await act(() => store.summon(undefined, summonScreen(ctx.canvas)))) {
                onClose(false)
                ctx.notify({
                  key: 'summon',
                  text: 'Everyone here now follows your view. They stop following when they move.',
                  testId: 'summon-toast',
                })
              }
            }}
          >
            Gather everyone here
          </button>
        </section>
      )}
      <SessionSection ctx={ctx} facilitator={facilitator} />
      {error && (
        <p className="dr-field-error" role="alert" data-testid="workshop-error">
          {error}
        </p>
      )}
    </div>
  )
}

/**
 * Session settings for everyone on the board (./session-settings.ts): facilitators switch them, the
 * others are told what is in effect. The wording is honest about what "hidden" means.
 */
function SessionSection({ ctx, facilitator }: { ctx: Ctx; facilitator: boolean }) {
  const { canvas } = ctx
  const settings = useValue('dr-wk-session-settings', () => workshopSettingsOf(canvas), [canvas])
  if (!facilitator) {
    if (!settings.hideNoteAuthors && !settings.hideCursors) return null
    return (
      <section className="dr-wk-pop__section" aria-label="Session" data-testid="session-settings">
        <h3>Session</h3>
        {settings.hideNoteAuthors && (
          <p className="dr-wk-hint">A facilitator has hidden the names on sticky notes.</p>
        )}
        {settings.hideCursors && <p className="dr-wk-hint">A facilitator has hidden everyone’s cursors.</p>}
      </section>
    )
  }
  return (
    <section className="dr-wk-pop__section" aria-label="Session" data-testid="session-settings">
      <h3>Session</h3>
      <label className="dr-wk-check">
        <input
          type="checkbox"
          data-testid="session-hide-authors"
          checked={settings.hideNoteAuthors}
          aria-describedby="dr-wk-hide-authors-hint"
          onChange={(e) => writeWorkshopSettings(canvas, { hideNoteAuthors: e.target.checked })}
        />
        Hide note authors
      </label>
      <p id="dr-wk-hide-authors-hint" className="dr-wk-hint">
        Nobody sees whose sticky note is whose: not on the board, in Present or in exports. The board still
        records who last edited each note.
      </p>
      <label className="dr-wk-check">
        <input
          type="checkbox"
          data-testid="session-hide-cursors"
          checked={settings.hideCursors}
          aria-describedby="dr-wk-hide-cursors-hint"
          onChange={(e) => writeWorkshopSettings(canvas, { hideCursors: e.target.checked })}
        />
        Hide everyone’s cursors
      </label>
      <p id="dr-wk-hide-cursors-hint" className="dr-wk-hint">
        People stop seeing each other’s pointers (yours too). Everyone still sees their own.
      </p>
    </section>
  )
}
