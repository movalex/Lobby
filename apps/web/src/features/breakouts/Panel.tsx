// OWNER: WS4 (wave V, breakouts). The Breakouts dock panel.
//   - A facilitator (an editor with an account) with nothing running: the setup. Groups from the selected frames or
//     "Make N frames" (4 by default), how people get a group (Split everyone now: auto, the default; I'll assign:
//     manual; Let people choose, with an optional cap), and the time (10 minutes by default, or none).
//   - While breakouts run, for the people who manage them: the time with "+5 min" and End; a message to everyone or
//     to one group; each group with its people (a picker per person moves them, keyboard and touch alike), "Join"
//     (this camera goes to the frame) and "Bring here" (that group follows this view); the people in no group; Shuffle.
//   - For everyone else: their group and "Go to my frame"; in choose mode, the groups to pick from.
//   - For anyone in a group: "Only show my group's cursors" (this screen only: presence is unchanged).
// Every control is a native button, select, input or checkbox (Tab, Space and Enter work), 44 px tall on a touch
// screen, and the layout stacks at phone width. The api decides every action; a refusal is shown in words.
import {
  BREAKOUT_LIMITS,
  type BreakoutMode,
  type BreakoutState,
  breakoutGroupDefaultName,
} from '@draftroom/contracts'
import { type FormEvent, useId, useState } from 'react'
import type { CanvasFeatureContext } from '../../canvas/api/index.ts'
import { knownUserKind } from '../../invite/guest.tsx'
import { useValue } from '../../lib/signals.ts'
import { summonScreen } from '../workshops/ported/camera.ts'
import { canEditBoard } from '../workshops/workshop-context.ts'
import { useSecondTick } from './Chip.tsx'
import { frameExists, goToFrame } from './camera.ts'
import { onlyMyGroupOf } from './cursors.ts'
import { groupsFromFrames, makeFrames, selectedFrames } from './frames.ts'
import {
  clockText,
  countText,
  DEFAULT_DURATION_MS,
  DURATION_CHOICES,
  durationLabel,
  EXTEND_MS,
  groupOf,
  membersOf,
  remainingMs,
} from './model.ts'
import { type BreakoutStore, breakoutStoreOf } from './store.ts'
import './breakouts.css'

type Ctx = CanvasFeatureContext

/** An editor with an account (UI hint only: the api decides). */
export const facilitatorHere = (ctx: Pick<Ctx, 'role' | 'board' | 'me'>) =>
  canEditBoard(ctx) && knownUserKind(ctx.me.user.id) !== 'guest'

const NOT_FENCED = 'Groups are a guide: everyone can still edit the whole board.'

export function BreakoutsPanel({ ctx }: { ctx: Ctx; close(): void }) {
  const store = breakoutStoreOf(ctx.canvas)
  if (!store) return null
  return <PanelBody ctx={ctx} store={store} />
}

function PanelBody({ ctx, store }: { ctx: Ctx; store: BreakoutStore }) {
  const state = useValue(store.state)
  const available = useValue(store.available)
  const [error, setError] = useState<string | null>(null)
  const running = state?.session?.status === 'running'
  useSecondTick(running)
  const facilitator = facilitatorHere(ctx)
  const run = async (fn: () => Promise<{ ok: boolean; message?: string }>) => {
    setError(null)
    const out = await fn()
    if (!out.ok) setError((out as { message?: string }).message ?? 'Something went wrong. Try again.')
    return out.ok
  }
  return (
    <div className="dr-brk-panel" data-testid="breakouts-panel">
      <h2 className="dr-brk-panel__title">Breakouts</h2>
      {!available && <p className="dr-brk-hint">Breakouts are not available on this board right now.</p>}
      {error && (
        <p className="dr-brk-error" role="alert" data-testid="breakouts-error">
          {error}
        </p>
      )}
      {available && !running && state?.session?.status === 'ended' && (
        <p className="dr-brk-hint" data-testid="breakouts-ended">
          Breakouts ended.
          {facilitator ? ' Gather everyone from the Facilitate menu, or start new ones below.' : ''}
        </p>
      )}
      {available && !running && facilitator && <Setup ctx={ctx} store={store} run={run} />}
      {available && !running && !facilitator && (
        <p className="dr-brk-hint">No breakouts are running. The facilitator starts them.</p>
      )}
      {available && running && state && <Running ctx={ctx} store={store} state={state} run={run} />}
    </div>
  )
}

type Run = (fn: () => Promise<{ ok: boolean; message?: string }>) => Promise<boolean>

// ---- setup ----------------------------------------------------------------------------------------------------------

function Setup({ ctx, store, run }: { ctx: Ctx; store: BreakoutStore; run: Run }) {
  const id = useId()
  const frames = useValue('dr-brk-selected-frames', () => selectedFrames(ctx.canvas), [ctx.canvas])
  const enough = frames.length >= BREAKOUT_LIMITS.groupsMin && frames.length <= BREAKOUT_LIMITS.groupsMax
  const [source, setSource] = useState<'selected' | 'make' | null>(null)
  const from = source ?? (enough ? 'selected' : 'make')
  const [count, setCount] = useState(4)
  const [mode, setMode] = useState<BreakoutMode>('auto')
  const [duration, setDuration] = useState<number | null>(DEFAULT_DURATION_MS)
  const [cap, setCap] = useState('')
  const [busy, setBusy] = useState(false)
  const capValue = cap.trim() === '' ? null : Math.floor(Number(cap))
  const capOk = capValue === null || (capValue >= 1 && capValue <= BREAKOUT_LIMITS.groupCapMax)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy || !capOk) return
    if (from === 'selected' && !enough) return
    setBusy(true)
    const groups = from === 'selected' ? groupsFromFrames(frames) : makeFrames(ctx.canvas, count)
    const ok = await run(() =>
      store.start({
        groups,
        mode,
        durationMs: duration,
        groupCap: mode === 'choose' ? capValue : null,
      }),
    )
    setBusy(false)
    if (ok) ctx.canvas.select([])
  }
  return (
    <form className="dr-brk-setup" data-testid="breakouts-setup" onSubmit={submit}>
      <fieldset className="dr-brk-fieldset">
        <legend>Groups</legend>
        <label className="dr-brk-choice">
          <input
            type="radio"
            name={`${id}-src`}
            checked={from === 'selected'}
            disabled={!enough}
            onChange={() => setSource('selected')}
            data-testid="breakouts-src-selected"
          />
          <span>
            Use the {frames.length >= 2 ? `${frames.length} ` : ''}selected frames
            {!enough && <span className="dr-brk-hint"> (select 2 to 20 frames)</span>}
          </span>
        </label>
        <label className="dr-brk-choice">
          <input
            type="radio"
            name={`${id}-src`}
            checked={from === 'make'}
            onChange={() => setSource('make')}
            data-testid="breakouts-src-make"
          />
          <span>Make new frames</span>
        </label>
        {from === 'make' && (
          <label className="dr-brk-field">
            <span>How many groups</span>
            <input
              type="number"
              inputMode="numeric"
              min={BREAKOUT_LIMITS.groupsMin}
              max={BREAKOUT_LIMITS.groupsMax}
              value={count}
              onChange={(e) =>
                setCount(
                  Math.max(
                    BREAKOUT_LIMITS.groupsMin,
                    Math.min(BREAKOUT_LIMITS.groupsMax, Math.floor(Number(e.target.value) || 0)),
                  ),
                )
              }
              data-testid="breakouts-count"
            />
          </label>
        )}
      </fieldset>
      <fieldset className="dr-brk-fieldset">
        <legend>People</legend>
        {(
          [
            [
              'auto',
              'Split everyone now',
              'Everyone on the board is put in a group; latecomers join the smallest.',
            ],
            ['manual', "I'll assign people", 'You move people into groups from this panel.'],
            ['choose', 'Let people choose', 'Each person picks a group.'],
          ] as const
        ).map(([value, label, hint]) => (
          <label key={value} className="dr-brk-choice">
            <input
              type="radio"
              name={`${id}-mode`}
              checked={mode === value}
              onChange={() => setMode(value)}
              data-testid={`breakouts-mode-${value}`}
            />
            <span>
              {label}
              <span className="dr-brk-hint dr-brk-hint--block">{hint}</span>
            </span>
          </label>
        ))}
        {mode === 'choose' && (
          <label className="dr-brk-field">
            <span>Most people per group (optional)</span>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={BREAKOUT_LIMITS.groupCapMax}
              value={cap}
              placeholder="No limit"
              aria-invalid={!capOk}
              onChange={(e) => setCap(e.target.value)}
              data-testid="breakouts-cap"
            />
          </label>
        )}
      </fieldset>
      <label className="dr-brk-field">
        <span>Time</span>
        <select
          value={duration === null ? 'none' : String(duration)}
          onChange={(e) => setDuration(e.target.value === 'none' ? null : Number(e.target.value))}
          data-testid="breakouts-duration"
        >
          {DURATION_CHOICES.map((d) => (
            <option key={String(d)} value={d === null ? 'none' : String(d)}>
              {durationLabel(d)}
            </option>
          ))}
        </select>
      </label>
      <p className="dr-brk-hint">{NOT_FENCED}</p>
      <button
        type="submit"
        className="dr-btn dr-btn--primary dr-brk-wide"
        disabled={busy || !capOk || (from === 'selected' && !enough)}
        data-testid="breakouts-start"
      >
        Start breakouts
      </button>
    </form>
  )
}

// ---- running --------------------------------------------------------------------------------------------------------

function Running({
  ctx,
  store,
  state,
  run,
}: {
  ctx: Ctx
  store: BreakoutStore
  state: BreakoutState
  run: Run
}) {
  const session = state.session
  if (!session) return null
  const left = remainingMs(session, store.serverNow())
  const mine = groupOf(state, state.myGroupId)
  return (
    <div className="dr-brk-running">
      <p className="dr-brk-status" data-testid="breakouts-status">
        {session.groups.length} groups ·{' '}
        {left === null ? 'no end time' : left > 0 ? `${clockText(left)} left` : "time's up"}
      </p>
      {mine && <MyGroup ctx={ctx} state={state} />}
      {!state.canManage && session.mode === 'choose' && (
        <ChooseGroup ctx={ctx} store={store} state={state} run={run} />
      )}
      {!state.canManage && !mine && session.mode !== 'choose' && (
        <p className="dr-brk-hint">The facilitator will put you in a group.</p>
      )}
      {state.canManage && <Manage ctx={ctx} store={store} state={state} run={run} />}
      {mine && <OnlyMyGroup ctx={ctx} />}
      <p className="dr-brk-hint">{NOT_FENCED}</p>
    </div>
  )
}

function MyGroup({ ctx, state }: { ctx: Ctx; state: BreakoutState }) {
  const group = groupOf(state, state.myGroupId)
  const exists = useValue('dr-brk-my-frame', () => (group ? frameExists(ctx.canvas, group.frameId) : false), [
    ctx.canvas,
    group?.frameId,
  ])
  if (!group) return null
  const people = membersOf(state, group.id)
  return (
    <section className="dr-brk-mine" aria-label="Your group" data-testid="breakouts-mine">
      <p className="dr-brk-mine__name">
        You are in <strong>{group.name}</strong> ({countText(people.length, null)})
      </p>
      {exists ? (
        <button
          type="button"
          className="dr-btn dr-btn--sm"
          onClick={() => goToFrame(ctx.canvas, group.frameId)}
          data-testid="breakouts-go-mine"
        >
          Go to my frame
        </button>
      ) : (
        <p className="dr-brk-hint">Your group's frame was removed from the board.</p>
      )}
    </section>
  )
}

function ChooseGroup({
  ctx,
  store,
  state,
  run,
}: {
  ctx: Ctx
  store: BreakoutStore
  state: BreakoutState
  run: Run
}) {
  const session = state.session
  if (!session) return null
  return (
    <section className="dr-brk-groups" aria-label="Pick a group" data-testid="breakouts-choose">
      <h3 className="dr-brk-h3">Pick a group</h3>
      <ul className="dr-brk-list">
        {session.groups.map((g) => {
          const n = membersOf(state, g.id).length
          const full = session.groupCap !== null && n >= session.groupCap && state.myGroupId !== g.id
          const here = state.myGroupId === g.id
          return (
            <li key={g.id} className="dr-brk-row" data-testid={`breakouts-choose-${g.id}`}>
              <span className="dr-brk-row__name">{g.name}</span>
              <span className="dr-brk-row__meta">{countText(n, session.groupCap)}</span>
              <button
                type="button"
                className={`dr-btn dr-btn--sm${here ? '' : ' dr-btn--primary'}`}
                disabled={full || here}
                aria-label={here ? `You are in ${g.name}` : full ? `${g.name} is full` : `Join ${g.name}`}
                onClick={() =>
                  void run(async () => {
                    const out = await store.join(g.id)
                    if (out.ok) goToFrame(ctx.canvas, g.frameId)
                    return out
                  })
                }
              >
                {here ? 'Joined' : full ? 'Full' : 'Join'}
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function Manage({
  ctx,
  store,
  state,
  run,
}: {
  ctx: Ctx
  store: BreakoutStore
  state: BreakoutState
  run: Run
}) {
  const session = state.session
  const roster = useValue('dr-brk-roster', () => {
    const seen = new Map<string, string>()
    for (const c of ctx.canvas.collaborators()) if (!seen.has(c.uid)) seen.set(c.uid, c.name)
    return JSON.stringify([...seen.entries()])
  }, [ctx.canvas])
  if (!session) return null
  const people = new Map<string, string>(JSON.parse(roster) as [string, string][])
  people.set(ctx.me.user.id, ctx.me.user.name)
  const assigned = new Set(state.members.map((m) => m.userId))
  const unassigned = [...people.entries()]
    .filter(([uid]) => !assigned.has(uid))
    .sort((a, b) => a[1].localeCompare(b[1]))
  const move = (userId: string, groupId: string | null) => void run(() => store.assign([{ userId, groupId }]))
  return (
    <div className="dr-brk-manage" data-testid="breakouts-manage">
      <div className="dr-brk-actions">
        <button
          type="button"
          className="dr-btn dr-btn--sm"
          onClick={() => void run(() => store.extend(EXTEND_MS))}
          data-testid="breakouts-extend"
        >
          +5 min
        </button>
        <button
          type="button"
          className="dr-btn dr-btn--sm"
          onClick={() => void run(() => store.shuffle())}
          data-testid="breakouts-shuffle"
        >
          Shuffle
        </button>
        <button
          type="button"
          className="dr-btn dr-btn--sm dr-brk-danger"
          onClick={() => void run(() => store.end())}
          data-testid="breakouts-end"
        >
          End breakouts
        </button>
      </div>
      <Broadcast store={store} state={state} run={run} />
      <ul className="dr-brk-list" aria-label="Groups">
        {session.groups.map((g) => (
          <GroupRow key={g.id} ctx={ctx} store={store} state={state} groupId={g.id} move={move} run={run} />
        ))}
      </ul>
      <section className="dr-brk-groups" aria-label="Not in a group" data-testid="breakouts-unassigned">
        <h3 className="dr-brk-h3">Not in a group ({unassigned.length})</h3>
        {unassigned.length === 0 ? (
          <p className="dr-brk-hint">Everyone here is in a group.</p>
        ) : (
          <ul className="dr-brk-people">
            {unassigned.map(([uid, name]) => (
              <Person key={uid} state={state} userId={uid} name={name} groupId={null} move={move} />
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function GroupRow({
  ctx,
  store,
  state,
  groupId,
  move,
  run,
}: {
  ctx: Ctx
  store: BreakoutStore
  state: BreakoutState
  groupId: string
  move: (userId: string, groupId: string | null) => void
  run: Run
}) {
  const g = groupOf(state, groupId)
  const exists = useValue('dr-brk-group-frame', () => (g ? frameExists(ctx.canvas, g.frameId) : false), [
    ctx.canvas,
    g?.frameId,
  ])
  if (!g) return null
  const people = membersOf(state, g.id)
  return (
    <li className="dr-brk-group" data-testid={`breakouts-group-${g.id}`}>
      <div className="dr-brk-row">
        <span className="dr-brk-row__name">{g.name}</span>
        <span className="dr-brk-row__meta">{countText(people.length, state.session?.groupCap ?? null)}</span>
      </div>
      {!exists && (
        <p className="dr-brk-hint">Frame removed. End and start again to give this group a frame.</p>
      )}
      <div className="dr-brk-actions">
        <button
          type="button"
          className="dr-btn dr-btn--sm"
          disabled={!exists}
          onClick={() => goToFrame(ctx.canvas, g.frameId)}
          data-testid={`breakouts-visit-${g.id}`}
          aria-label={`Join ${g.name}: go to its frame`}
        >
          Join
        </button>
        <button
          type="button"
          className="dr-btn dr-btn--sm"
          disabled={people.length === 0}
          onClick={() => void run(() => store.summon(g.id, summonScreen(ctx.canvas)))}
          data-testid={`breakouts-summon-${g.id}`}
          aria-label={`Bring ${g.name} to your view`}
        >
          Bring here
        </button>
      </div>
      {people.length > 0 && (
        <ul className="dr-brk-people">
          {people.map((m) => (
            <Person key={m.userId} state={state} userId={m.userId} name={m.name} groupId={g.id} move={move} />
          ))}
        </ul>
      )}
    </li>
  )
}

function Person({
  state,
  userId,
  name,
  groupId,
  move,
}: {
  state: BreakoutState
  userId: string
  name: string
  groupId: string | null
  move: (userId: string, groupId: string | null) => void
}) {
  const id = useId()
  return (
    <li className="dr-brk-person" data-testid={`breakouts-person-${userId}`}>
      <label htmlFor={id} className="dr-brk-person__name">
        {name}
      </label>
      <select
        id={id}
        value={groupId ?? ''}
        onChange={(e) => move(userId, e.target.value || null)}
        aria-label={`Group for ${name}`}
        data-testid={`breakouts-move-${userId}`}
      >
        <option value="">No group</option>
        {state.session?.groups.map((g) => (
          <option key={g.id} value={g.id}>
            {g.name}
          </option>
        ))}
      </select>
    </li>
  )
}

function Broadcast({ store, state, run }: { store: BreakoutStore; state: BreakoutState; run: Run }) {
  const id = useId()
  const [text, setText] = useState('')
  const [to, setTo] = useState('')
  const [sent, setSent] = useState<string | null>(null)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const line = text.trim()
    if (!line) return
    const ok = await run(() => store.broadcast(line, to || null))
    if (ok) {
      setText('')
      const g = groupOf(state, to || null)
      setSent(g ? `Sent to ${g.name}.` : 'Sent to everyone.')
    }
  }
  return (
    <form className="dr-brk-broadcast" onSubmit={submit} data-testid="breakouts-broadcast">
      <label htmlFor={`${id}-text`} className="dr-brk-h3">
        Message
      </label>
      <input
        id={`${id}-text`}
        type="text"
        maxLength={BREAKOUT_LIMITS.broadcastMaxChars}
        value={text}
        placeholder="Five minutes left"
        onChange={(e) => {
          setText(e.target.value)
          setSent(null)
        }}
        data-testid="breakouts-broadcast-text"
      />
      <div className="dr-brk-actions">
        <select
          value={to}
          onChange={(e) => setTo(e.target.value)}
          aria-label="Send to"
          data-testid="breakouts-broadcast-to"
        >
          <option value="">Everyone</option>
          {state.session?.groups.map((g, i) => (
            <option key={g.id} value={g.id}>
              {g.name || breakoutGroupDefaultName(i + 1)}
            </option>
          ))}
        </select>
        <button
          type="submit"
          className="dr-btn dr-btn--sm dr-btn--primary"
          disabled={!text.trim()}
          data-testid="breakouts-broadcast-send"
        >
          Send
        </button>
      </div>
      {sent && (
        <p className="dr-brk-hint" role="status">
          {sent}
        </p>
      )}
    </form>
  )
}

function OnlyMyGroup({ ctx }: { ctx: Ctx }) {
  const a = onlyMyGroupOf(ctx.canvas)
  const on = useValue(a)
  return (
    <label className="dr-brk-choice dr-brk-cursors">
      <input
        type="checkbox"
        checked={on}
        onChange={(e) => a.set(e.target.checked)}
        data-testid="breakouts-only-mine"
      />
      <span>
        Only show my group's cursors
        <span className="dr-brk-hint dr-brk-hint--block">On this screen only.</span>
      </span>
    </label>
  )
}
